import { createViemHandleClient } from "@iexec-nox/handle";
import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  http,
  parseAbi,
  size,
  type Address,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import { hostedEnrollmentResponse } from "../src/hosted-enrollment-http.js";
import { HostedEnrollmentService } from "../src/hosted-enrollment.js";
import { NeonEnrollmentRepository } from "../src/neon-enrollment-repository.js";
import { deriveSimpleAccountSalt } from "../src/operator-service.js";
import { deriveOperatorAccount } from "../src/service-crypto.js";
import { parseSecretHex } from "../src/service-role-rotation.js";

const ORIGIN = "https://chit-kohl.vercel.app";
const RPC_URL = process.env.SEPOLIA_RPC_URL ??
  "https://ethereum-sepolia-rpc.publicnode.com";
const FACTORY = "0xae9f63B7E7b0aC875AaDBEC56efCccFb88Ea87e6" satisfies Address;
const ROUND = "0xdf1b4073be7e71e17e9b09eaa4f203b80f801e9639b7fbbd3f07b2c0f8643478" satisfies Hex;
const ROUND_SALT = "0xb9be72f85c2b3ac09d3d42436be640ca215a01058043ee348e6081ba4aa425c1";
const CREATOR = "0x34b0Ba20669f3ec4F1056853780c381e5e35F724" satisfies Address;
const OPERATOR = "0x527e7Bdc2ef3eA0A10592Cc1B2DC40B974CD8c2F" satisfies Address;
const SETTLEMENT = "0xcc25c854C5c2745987302b2E7797C46C3019a46a" satisfies Address;
const ACCOUNT_FACTORY = "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985" satisfies Address;
const ACCOUNT_FACTORY_ABI = parseAbi(["function getAddress(address owner,uint256 salt) view returns (address)"]);
const ENROLL_ABI = parseAbi(["function enroll(address account,bytes32 encryptedSlot,bytes inputProof)"]);

interface RpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown };
}

async function rpc(method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json() as RpcResponse;
  if (!response.ok || payload.result === undefined) {
    const message = typeof payload.error?.message === "string"
      ? payload.error.message
      : "Sepolia RPC request failed";
    throw new Error(message);
  }
  return payload.result;
}

async function rpcHex(method: string, params: readonly unknown[]): Promise<Hex> {
  const result = await rpc(method, params);
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error(`${method} returned invalid hex`);
  }
  return result as Hex;
}

function requiredEnvironment(name: "DATABASE_URL" | "SERVICE_MASTER_SECRET"): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not configured`);
  return value;
}

function operatorAccount(): ReturnType<typeof deriveOperatorAccount> {
  const secret = hexToBytes(parseSecretHex(
    requiredEnvironment("SERVICE_MASTER_SECRET"),
    "SERVICE_MASTER_SECRET",
  ));
  const account = deriveOperatorAccount(secret, {
    chainId: sepolia.id,
    factory: FACTORY,
    creator: CREATOR,
    roundSalt: ROUND_SALT,
  });
  if (getAddress(account.address) !== getAddress(OPERATOR)) {
    throw new Error("Derived operator does not match the protected on-chain role");
  }
  return account;
}

class SepoliaEnrollmentExecutor {
  private readonly account = operatorAccount();
  private readonly publicClient = createPublicClient({
    chain: sepolia,
    transport: http(RPC_URL),
  });
  private readonly walletClient = createWalletClient({
    account: this.account,
    chain: sepolia,
    transport: http(RPC_URL),
  });

  async predict(owner: Address): Promise<Address> {
    const salt = deriveSimpleAccountSalt(sepolia.id, ROUND, owner);
    const result = await rpcHex("eth_call", [{
      to: ACCOUNT_FACTORY,
      data: encodeFunctionData({
        abi: ACCOUNT_FACTORY_ABI,
        functionName: "getAddress",
        args: [owner, salt],
      }),
    }, "latest"]);
    return decodeFunctionResult({
      abi: ACCOUNT_FACTORY_ABI,
      functionName: "getAddress",
      data: result,
    });
  }

  async enroll(account: Address, sponsorSlot: number): Promise<Hex> {
    const nox = await createViemHandleClient(this.walletClient);
    const encrypted = await nox.encryptInput(
      BigInt(sponsorSlot),
      "uint256",
      SETTLEMENT,
    );
    if (size(encrypted.handleProof) !== 137) {
      throw new Error("Nox enrollment proof is invalid");
    }
    const data = encodeFunctionData({
      abi: ENROLL_ABI,
      functionName: "enroll",
      args: [account, encrypted.handle, encrypted.handleProof],
    });
    const [nonceHex, gasHex, gasPriceHex] = await Promise.all([
      rpcHex("eth_getTransactionCount", [this.account.address, "pending"]),
      rpcHex("eth_estimateGas", [{ from: this.account.address, to: SETTLEMENT, data }]),
      rpcHex("eth_gasPrice", []),
    ]);
    const serialized = await this.account.signTransaction({
      chainId: sepolia.id,
      type: "legacy",
      to: SETTLEMENT,
      data,
      gas: BigInt(gasHex),
      gasPrice: BigInt(gasPriceHex),
      nonce: Number(BigInt(nonceHex)),
    });
    const transactionHash = await rpcHex("eth_sendRawTransaction", [serialized]);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== "success") throw new Error("Enrollment transaction reverted");
    return transactionHash;
  }
}

async function enrollmentService(): Promise<HostedEnrollmentService> {
  const sql = neon(requiredEnvironment("DATABASE_URL"));
  const repository = new NeonEnrollmentRepository({
    query: (query, params) => sql.query(query, params),
  });
  await repository.initialize();
  return new HostedEnrollmentService({
    origin: ORIGIN,
    chainId: sepolia.id,
    factory: FACTORY,
    round: ROUND,
    owner: CREATOR,
    sponsorSlot: 0,
    challengeTtlSeconds: 600,
    clock: () => Math.floor(Date.now() / 1_000),
    nonce: randomUUID,
    repository,
    enrollment: new SepoliaEnrollmentExecutor(),
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    return hostedEnrollmentResponse(request, await enrollmentService());
  } catch (error) {
    console.error("hosted enrollment initialization failed", error);
    return Response.json({ error: "enrollment_unavailable" }, { status: 503 });
  }
}
