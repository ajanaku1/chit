import { createViemHandleClient } from "@iexec-nox/handle";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  http,
  isHex,
  parseAbi,
  size,
  type Address,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import {
  OperatorSponsorService,
  type OperatorSponsorRequest,
} from "../src/operator-sponsor.js";
import { deriveOperatorAccount } from "../src/service-crypto.js";
import { parseSecretHex } from "../src/service-role-rotation.js";

const RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const FACTORY = "0xae9f63B7E7b0aC875AaDBEC56efCccFb88Ea87e6" satisfies Address;
const ROUND_SALT = "0xb9be72f85c2b3ac09d3d42436be640ca215a01058043ee348e6081ba4aa425c1";
const CREATOR = "0x34b0Ba20669f3ec4F1056853780c381e5e35F724" satisfies Address;
const SPONSOR = "0x527e7Bdc2ef3eA0A10592Cc1B2DC40B974CD8c2F" satisfies Address;
const TOKEN = "0x19c151c602484234b689c46f3d2481dc05a7bfdb" satisfies Address;
const WRAPPER = "0xf2a752bacb7fab05117ba8040f4f55537d50a60c" satisfies Address;
const VAULT = "0x1eA6D0c25C6b144a110d83C493cf8DC8a17d8C1b" satisfies Address;
const BUDGET = 1_000n;
const TOKEN_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const WRAPPER_ABI = parseAbi([
  "function wrap(address to,uint256 amount) returns (bytes32)",
  "function isOperator(address holder,address spender) view returns (bool)",
  "function setOperator(address operator,uint48 until)",
]);
const VAULT_ABI = parseAbi([
  "function admissionDigest(address sponsor,uint48 validUntil) view returns (bytes32)",
  "function registeredSponsor(address sponsor) view returns (bool)",
  "function sponsorCount() view returns (uint256)",
  "function registerSponsor(bytes32 encryptedBudget,bytes inputProof,uint48 validUntil,bytes creatorSignature) returns (uint256)",
]);

interface RpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown };
}

function masterSecret(): Uint8Array {
  const value = process.env.SERVICE_MASTER_SECRET;
  if (value === undefined) throw new Error("SERVICE_MASTER_SECRET is not configured");
  return hexToBytes(parseSecretHex(value, "SERVICE_MASTER_SECRET"));
}

async function rpcHex(method: string, params: readonly unknown[]): Promise<Hex> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json() as RpcResponse;
  if (!response.ok || typeof payload.result !== "string" || !isHex(payload.result)) {
    const message = typeof payload.error?.message === "string"
      ? payload.error.message
      : `${method} failed`;
    throw new Error(message);
  }
  return payload.result;
}

class OperatorSponsorChain {
  private readonly account = deriveOperatorAccount(masterSecret(), {
    chainId: sepolia.id,
    factory: FACTORY,
    creator: CREATOR,
    roundSalt: ROUND_SALT,
  });
  private readonly publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
  private readonly walletClient = createWalletClient({
    account: this.account,
    chain: sepolia,
    transport: http(RPC_URL),
  });

  constructor() {
    if (getAddress(this.account.address) !== getAddress(SPONSOR)) {
      throw new Error("Derived service operator does not match sponsor two");
    }
  }

  async admissionDigest(sponsor: Address, expiresAt: number): Promise<Hex> {
    return this.readAdmissionDigest(sponsor, expiresAt);
  }

  async operatorTokenBalance(): Promise<bigint> {
    const result = await this.call(TOKEN, encodeFunctionData({
      abi: TOKEN_ABI,
      functionName: "balanceOf",
      args: [SPONSOR],
    }));
    return decodeFunctionResult({ abi: TOKEN_ABI, functionName: "balanceOf", data: result });
  }

  async register(input: OperatorSponsorRequest & {
    readonly sponsor: Address;
    readonly budget: bigint;
    readonly creatorSignature: Hex;
  }): Promise<{ slot: number; transactionHash: Hex }> {
    if (await this.registered()) {
      throw new Error("Service operator is already registered as sponsor two");
    }
    await this.replaceKnownPendingTransactions();
    await this.prepareCollateral(input.budget, input.expiresAt);
    const nox = await createViemHandleClient(this.walletClient);
    const encrypted = await nox.encryptInput(input.budget, "uint256", VAULT);
    if (size(encrypted.handleProof) !== 137) throw new Error("Nox sponsor proof is invalid");
    const transactionHash = await this.send(VAULT, encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "registerSponsor",
      args: [encrypted.handle, encrypted.handleProof, input.expiresAt, input.creatorSignature],
    }));
    const count = await this.sponsorCount();
    return { slot: Number(count - 1n), transactionHash };
  }

  private async prepareCollateral(budget: bigint, expiresAt: number): Promise<void> {
    const balance = await this.operatorTokenBalance();
    if (balance >= budget) {
      await this.send(TOKEN, encodeFunctionData({
        abi: TOKEN_ABI,
        functionName: "approve",
        args: [WRAPPER, budget],
      }));
      await this.send(WRAPPER, encodeFunctionData({
        abi: WRAPPER_ABI,
        functionName: "wrap",
        args: [SPONSOR, budget],
      }));
    }
    const authorized = await this.vaultIsOperator();
    if (!authorized) {
      await this.send(WRAPPER, encodeFunctionData({
        abi: WRAPPER_ABI,
        functionName: "setOperator",
        args: [VAULT, expiresAt],
      }));
    }
  }

  private async replaceKnownPendingTransactions(): Promise<void> {
    const [latestHex, pendingHex, gasPriceHex] = await Promise.all([
      rpcHex("eth_getTransactionCount", [SPONSOR, "latest"]),
      rpcHex("eth_getTransactionCount", [SPONSOR, "pending"]),
      rpcHex("eth_gasPrice", []),
    ]);
    const latest = Number(BigInt(latestHex));
    const pending = Number(BigInt(pendingHex));
    if (pending <= latest) return;
    if (latest < 2 || pending > 5) {
      throw new Error("Operator has an unexpected pending transaction queue");
    }
    const gasPrice = BigInt(gasPriceHex) * 3n > 3_000_000_000n
      ? BigInt(gasPriceHex) * 3n
      : 3_000_000_000n;
    const queuedOperations: readonly {
      readonly nonce: number;
      readonly to: Address;
      readonly data: Hex;
      readonly gas: bigint;
    }[] = [
      {
        nonce: 2,
        to: WRAPPER,
        data: encodeFunctionData({
          abi: WRAPPER_ABI,
          functionName: "wrap",
          args: [SPONSOR, BUDGET],
        }),
        gas: 300_000n,
      },
      {
        nonce: 3,
        to: TOKEN,
        data: encodeFunctionData({
          abi: TOKEN_ABI,
          functionName: "approve",
          args: [WRAPPER, BUDGET],
        }),
        gas: 80_000n,
      },
      {
        nonce: 4,
        to: TOKEN,
        data: encodeFunctionData({
          abi: TOKEN_ABI,
          functionName: "approve",
          args: [WRAPPER, BUDGET],
        }),
        gas: 80_000n,
      },
    ];
    const operations = queuedOperations.filter(
      ({ nonce }) => nonce >= latest && nonce < pending,
    );
    const replacements = await Promise.all(operations.map((operation) =>
      this.broadcastReplacement(operation, gasPrice)));
    await Promise.all(replacements
      .filter((hash): hash is Hex => hash !== undefined)
      .map((hash) => this.publicClient.waitForTransactionReceipt({ hash })));
  }

  private async broadcastReplacement(
    operation: {
      readonly nonce: number;
      readonly to: Address;
      readonly data: Hex;
      readonly gas: bigint;
    },
    gasPrice: bigint,
  ): Promise<Hex | undefined> {
    const serialized = await this.account.signTransaction({
      chainId: sepolia.id,
      type: "legacy",
      to: operation.to,
      data: operation.data,
      gas: operation.gas,
      gasPrice,
      nonce: operation.nonce,
    });
    try {
      return await rpcHex("eth_sendRawTransaction", [serialized]);
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes("nonce too low")) {
        return undefined;
      }
      throw error;
    }
  }

  private async send(to: Address, data: Hex, nonceOverride?: number): Promise<Hex> {
    const [nonceHex, gasHex, gasPriceHex] = await Promise.all([
      rpcHex("eth_getTransactionCount", [SPONSOR, "pending"]),
      rpcHex("eth_estimateGas", [{ from: SPONSOR, to, data }]),
      rpcHex("eth_gasPrice", []),
    ]);
    const serialized = await this.account.signTransaction({
      chainId: sepolia.id,
      type: "legacy",
      to,
      data,
      gas: BigInt(gasHex),
      gasPrice: BigInt(gasPriceHex) * 2n,
      nonce: nonceOverride ?? Number(BigInt(nonceHex)),
    });
    const hash = await rpcHex("eth_sendRawTransaction", [serialized]);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Operator sponsor transaction reverted");
    return hash;
  }

  private async readAdmissionDigest(sponsor: Address, expiresAt: number): Promise<Hex> {
    const result = await this.call(VAULT, encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "admissionDigest",
      args: [sponsor, expiresAt],
    }));
    return decodeFunctionResult({ abi: VAULT_ABI, functionName: "admissionDigest", data: result });
  }

  private async registered(): Promise<boolean> {
    const result = await this.call(VAULT, encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "registeredSponsor",
      args: [SPONSOR],
    }));
    return decodeFunctionResult({ abi: VAULT_ABI, functionName: "registeredSponsor", data: result });
  }

  private async sponsorCount(): Promise<bigint> {
    const result = await this.call(VAULT, encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "sponsorCount",
    }));
    return decodeFunctionResult({ abi: VAULT_ABI, functionName: "sponsorCount", data: result });
  }

  private async vaultIsOperator(): Promise<boolean> {
    const result = await this.call(WRAPPER, encodeFunctionData({
      abi: WRAPPER_ABI,
      functionName: "isOperator",
      args: [SPONSOR, VAULT],
    }));
    return decodeFunctionResult({ abi: WRAPPER_ABI, functionName: "isOperator", data: result });
  }

  private call(to: Address, data: Hex): Promise<Hex> {
    return rpcHex("eth_call", [{ to, data }, "latest"]);
  }
}

function service(chain: OperatorSponsorChain): OperatorSponsorService {
  return new OperatorSponsorService({
    creator: CREATOR,
    sponsor: SPONSOR,
    budget: BUDGET,
    admissionTtlSeconds: 3_600,
    clock: () => Math.floor(Date.now() / 1_000),
    chain,
  });
}

function exactBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid body");
  }
  return value as Record<string, unknown>;
}

function registerRequest(body: Record<string, unknown>): OperatorSponsorRequest {
  if (Object.keys(body).sort().join() !== "action,expiresAt,signature" ||
      body.action !== "register" || !Number.isSafeInteger(body.expiresAt) ||
      typeof body.signature !== "string" || !isHex(body.signature) || size(body.signature) !== 65) {
    throw new Error("invalid request");
  }
  return { expiresAt: Number(body.expiresAt), signature: body.signature };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = exactBody(await request.json());
    const chain = new OperatorSponsorChain();
    if (Object.keys(body).sort().join() === "action" && body.action === "challenge") {
      const challenge = await service(chain).challenge();
      const balance = await chain.operatorTokenBalance();
      return Response.json({ ...challenge, needsFunding: balance < BUDGET });
    }
    return Response.json(await service(chain).register(registerRequest(body)));
  } catch (error) {
    console.error("operator sponsor request failed", error);
    return Response.json({ error: "operator_sponsor_unavailable" }, { status: 503 });
  }
}
