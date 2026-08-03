import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  http,
  isHex,
  parseAbi,
  parseGwei,
  recoverMessageAddress,
  size,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { entryPoint07Abi, type UserOperation } from "viem/account-abstraction";
import { sepolia } from "viem/chains";
import {
  buildFixedUserOperation,
  contractInteger,
  FIXED_BUNDLER_GAS,
  FIXED_OPERATION_GAS,
  hostedOperationReservationDigest,
  parseSerializedUserOperation,
  serializeUserOperation,
  verifyOwnerOperationSignature,
} from "../src/fixed-user-operation.js";
import { deriveSimpleAccountSalt } from "../src/operator-service.js";
import {
  operationFingerprint,
  requiredPrefund,
  validatePreparedOperation,
} from "../src/operation-policy.js";
import { deriveOperatorAccount, PaymasterAuthorizer } from "../src/service-crypto.js";
import { parseSecretHex } from "../src/service-role-rotation.js";
import { packChitUserOperation, userOperationHash } from "../src/user-operation.js";

const RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const FACTORY = "0xae9f63B7E7b0aC875AaDBEC56efCccFb88Ea87e6" satisfies Address;
const ROUND = "0xdf1b4073be7e71e17e9b09eaa4f203b80f801e9639b7fbbd3f07b2c0f8643478" satisfies Hex;
const ROUND_SALT = "0xb9be72f85c2b3ac09d3d42436be640ca215a01058043ee348e6081ba4aa425c1";
const CREATOR = "0x34b0Ba20669f3ec4F1056853780c381e5e35F724" satisfies Address;
const OPERATOR = "0x527e7Bdc2ef3eA0A10592Cc1B2DC40B974CD8c2F" satisfies Address;
const ACCOUNT = "0x3671cb6675484DD48747F39Ed9110dc360CB633F" satisfies Address;
const ACCOUNT_FACTORY = "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985" satisfies Address;
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" satisfies Address;
const COUNTER = "0x13283ab8e1f2bc4297e9ec6480c80c59674af554" satisfies Address;
const PAYMASTER = "0x9f4A6871D8cb2be0A02e180901b65AEA9033f022" satisfies Address;
const SETTLEMENT = "0xcc25c854C5c2745987302b2E7797C46C3019a46a" satisfies Address;
const VAULT = "0x1eA6D0c25C6b144a110d83C493cf8DC8a17d8C1b" satisfies Address;
const AUTHORIZATION_TTL_SECONDS = 3_600;
const CONFIRMED_TRANSACTION = "0x4585cd9e21ce2189bd77ee3edccaa020968068a714ce3507fe0df399a7c13176" satisfies Hex;
const CONFIRMED_USER_OPERATION = "0x0c034ba35073117fcb0367699024e19266c898c48965ea13e566a92617370571" satisfies Hex;
const ACCOUNT_FACTORY_ABI = parseAbi([
  "function getAddress(address owner,uint256 salt) view returns (address)",
  "function createAccount(address owner,uint256 salt) returns (address account)",
]);
const SETTLEMENT_ABI = parseAbi(["function enrolled(address account) view returns (bool)"]);
const VAULT_ABI = parseAbi(["function sponsorCount() view returns (uint256)"]);
const PAYMASTER_ABI = parseAbi([
  "function currentEpoch() view returns (uint256)",
  "function claim(uint256 epoch,address account) view returns (uint256)",
  "function paused() view returns (bool)",
  "function roundState() view returns (uint8)",
  "function verifier() view returns (address)",
]);
const ACCOUNT_ABI = parseAbi(["function owner() view returns (address)"]);
const COUNTER_ABI = parseAbi(["function count() view returns (uint256)"]);

interface RpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown };
}

interface LiveFacts {
  readonly deployed: boolean;
  readonly nonce: bigint;
  readonly currentEpochClaim: bigint;
  readonly counterCount: bigint;
  readonly factoryData: Hex;
}

function serviceAccount(): ReturnType<typeof deriveOperatorAccount> {
  const account = deriveOperatorAccount(serviceSecret(), {
    chainId: sepolia.id,
    factory: FACTORY,
    creator: CREATOR,
    roundSalt: ROUND_SALT,
  });
  if (getAddress(account.address) !== getAddress(OPERATOR)) {
    throw new Error("Derived operator does not match the protected service role");
  }
  return account;
}

function serviceSecret(): Uint8Array {
  const value = process.env.SERVICE_MASTER_SECRET;
  if (value === undefined) throw new Error("SERVICE_MASTER_SECRET is not configured");
  return hexToBytes(parseSecretHex(value, "SERVICE_MASTER_SECRET"));
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
      : `${method} failed`;
    throw new Error(message);
  }
  return payload.result;
}

async function rpcHex(method: string, params: readonly unknown[]): Promise<Hex> {
  const result = await rpc(method, params);
  if (typeof result !== "string" || !isHex(result)) {
    throw new Error(`${method} returned invalid hex`);
  }
  return result;
}

async function call(address: Address, data: Hex): Promise<Hex> {
  return rpcHex("eth_call", [{ to: address, data }, "latest"]);
}

async function readContract<abi extends readonly unknown[]>(
  address: Address,
  contractAbi: abi,
  functionName: string,
  args?: readonly unknown[],
): Promise<unknown> {
  const data = encodeFunctionData({
    abi: contractAbi,
    functionName,
    ...(args === undefined ? {} : { args }),
  } as never);
  const result = await call(address, data);
  return decodeFunctionResult({ abi: contractAbi, functionName, data: result } as never);
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid`);
  return value;
}

function asAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return getAddress(value);
}

async function liveFacts(): Promise<LiveFacts> {
  const salt = deriveSimpleAccountSalt(sepolia.id, ROUND, CREATOR);
  const factoryData = encodeFunctionData({
    abi: ACCOUNT_FACTORY_ABI,
    functionName: "createAccount",
    args: [CREATOR, salt],
  });
  const [predicted, code, nonce, enrolled, epoch, sponsors, paused, state, verifier, counter] =
    await Promise.all([
      readContract(ACCOUNT_FACTORY, ACCOUNT_FACTORY_ABI, "getAddress", [CREATOR, salt]),
      rpcHex("eth_getCode", [ACCOUNT, "latest"]),
      readContract(ENTRY_POINT, entryPoint07Abi, "getNonce", [ACCOUNT, 0n]),
      readContract(SETTLEMENT, SETTLEMENT_ABI, "enrolled", [ACCOUNT]),
      readContract(PAYMASTER, PAYMASTER_ABI, "currentEpoch"),
      readContract(VAULT, VAULT_ABI, "sponsorCount"),
      readContract(PAYMASTER, PAYMASTER_ABI, "paused"),
      readContract(PAYMASTER, PAYMASTER_ABI, "roundState"),
      readContract(PAYMASTER, PAYMASTER_ABI, "verifier"),
      readContract(COUNTER, COUNTER_ABI, "count"),
    ]);
  if (asAddress(predicted, "predicted account") !== getAddress(ACCOUNT)) {
    throw new Error("Canonical SimpleAccount prediction changed");
  }
  if (!asBoolean(enrolled, "enrollment")) throw new Error("Account is not enrolled");
  if (contractInteger(sponsors, "sponsor count") < 2n) throw new Error("Two sponsors are required");
  if (asBoolean(paused, "paymaster pause") || contractInteger(state, "round state") !== 1n) {
    throw new Error("Round is not active");
  }
  if (asAddress(verifier, "paymaster verifier") !== getAddress(OPERATOR)) {
    throw new Error("Protected verifier role changed");
  }
  const deployed = code !== "0x";
  if (deployed) {
    const owner = await readContract(ACCOUNT, ACCOUNT_ABI, "owner");
    if (asAddress(owner, "account owner") !== getAddress(CREATOR)) {
      throw new Error("SimpleAccount owner changed");
    }
  }
  const currentEpoch = contractInteger(epoch, "current epoch");
  const claim = await readContract(PAYMASTER, PAYMASTER_ABI, "claim", [currentEpoch, ACCOUNT]);
  return {
    deployed,
    nonce: contractInteger(nonce, "account nonce"),
    currentEpochClaim: contractInteger(claim, "current epoch claim"),
    counterCount: contractInteger(counter, "counter count"),
    factoryData,
  };
}

function operationPolicy(
  operation: UserOperation<"0.7">,
  facts: LiveFacts,
  validUntil: number,
) {
  return {
    account: ACCOUNT,
    expectedNonce: facts.nonce,
    accountDeployed: facts.deployed,
    accountFactory: ACCOUNT_FACTORY,
    accountFactoryData: facts.factoryData,
    expectedCallData: operation.callData,
    paymaster: PAYMASTER,
    maximumCost: requiredPrefund(operation),
    validUntil,
    now: Math.floor(Date.now() / 1_000),
    currentEpochClaim: facts.currentEpochClaim,
    gasCeilings: {
      call: FIXED_OPERATION_GAS.callGasLimit,
      verification: FIXED_OPERATION_GAS.verificationGasLimit,
      preVerification: FIXED_OPERATION_GAS.preVerificationGas,
      paymasterVerification: FIXED_OPERATION_GAS.paymasterVerificationGasLimit,
      paymasterPostOp: FIXED_OPERATION_GAS.paymasterPostOpGasLimit,
      feePerGas: operation.maxFeePerGas,
      priorityFeePerGas: operation.maxPriorityFeePerGas,
    },
  };
}

function authorizer() {
  return new PaymasterAuthorizer({
    masterSecret: serviceSecret(),
    operatorContext: {
      chainId: sepolia.id,
      factory: FACTORY,
      creator: CREATOR,
      roundSalt: ROUND_SALT,
    },
    entryPoint: ENTRY_POINT,
    paymaster: PAYMASTER,
  });
}

async function prepare(): Promise<Response> {
  const [facts, gasPriceHex] = await Promise.all([
    liveFacts(),
    rpcHex("eth_gasPrice", []),
  ]);
  if (facts.currentEpochClaim !== 0n) {
    throw new Error("This account already has a sponsored claim in the current epoch");
  }
  const liveGasPrice = BigInt(gasPriceHex) * 2n;
  const maxFeePerGas = liveGasPrice > parseGwei("2") ? liveGasPrice : parseGwei("2");
  const unsigned = buildFixedUserOperation({
    sender: ACCOUNT,
    nonce: facts.nonce,
    deployed: facts.deployed,
    factory: ACCOUNT_FACTORY,
    factoryData: facts.factoryData,
    counter: COUNTER,
    paymaster: PAYMASTER,
    maxFeePerGas,
  });
  const validUntil = Math.floor(Date.now() / 1_000) + AUTHORIZATION_TTL_SECONDS;
  const authorization = await authorizer().authorize(
    unsigned,
    operationPolicy(unsigned, facts, validUntil),
  );
  const operation = { ...unsigned, paymasterData: authorization.paymasterData };
  const hash = userOperationHash(operation, ENTRY_POINT, sepolia.id);
  const reservationDigest = hostedOperationReservationDigest(hash, validUntil);
  const reservationSignature = await serviceAccount().signMessage({
    message: { raw: reservationDigest },
  });
  return Response.json({
    operation: serializeUserOperation(operation),
    hash,
    validUntil,
    reservationSignature,
    counterBefore: facts.counterCount.toString(),
  }, { headers: { "cache-control": "no-store" } });
}

function exactSubmitBody(value: unknown): {
  readonly operation: UserOperation<"0.7">;
  readonly signature: Hex;
  readonly validUntil: number;
  readonly reservationSignature: Hex;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request body is invalid");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join() !==
      "action,operation,reservationSignature,signature,validUntil" ||
      body.action !== "submit" || !Number.isSafeInteger(body.validUntil) ||
      typeof body.signature !== "string" || !isHex(body.signature) || size(body.signature) !== 65 ||
      typeof body.reservationSignature !== "string" ||
      !isHex(body.reservationSignature) || size(body.reservationSignature) !== 65) {
    throw new Error("Request body is invalid");
  }
  return {
    operation: parseSerializedUserOperation(body.operation),
    signature: body.signature,
    validUntil: Number(body.validUntil),
    reservationSignature: body.reservationSignature,
  };
}

async function validateSubmission(
  submitted: ReturnType<typeof exactSubmitBody>,
): Promise<{ readonly operation: UserOperation<"0.7">; readonly hash: Hex }> {
  const facts = await liveFacts();
  const operation = submitted.operation;
  if (operation.signature !== "0x") throw new Error("Operation signature field must be empty");
  const unsigned = { ...operation, paymasterData: "0x" as const };
  const expected = buildFixedUserOperation({
    sender: ACCOUNT,
    nonce: facts.nonce,
    deployed: facts.deployed,
    factory: ACCOUNT_FACTORY,
    factoryData: facts.factoryData,
    counter: COUNTER,
    paymaster: PAYMASTER,
    maxFeePerGas: operation.maxFeePerGas,
  });
  if (operationFingerprint(unsigned) !== operationFingerprint(expected)) {
    throw new Error("UserOperation changed from the fixed action");
  }
  const policy = operationPolicy(unsigned, facts, submitted.validUntil);
  validatePreparedOperation(unsigned, policy);
  const expectedAuthorization = await authorizer().authorize(unsigned, policy);
  if (expectedAuthorization.paymasterData.toLowerCase() !== operation.paymasterData?.toLowerCase()) {
    throw new Error("Paymaster authorization changed");
  }
  const hash = userOperationHash(operation, ENTRY_POINT, sepolia.id);
  const reservationSigner = await recoverMessageAddress({
    message: { raw: hostedOperationReservationDigest(hash, submitted.validUntil) },
    signature: submitted.reservationSignature,
  });
  if (reservationSigner.toLowerCase() !== OPERATOR.toLowerCase()) {
    throw new Error("Hosted operation reservation is invalid");
  }
  await verifyOwnerOperationSignature(operation, submitted.signature, CREATOR, ENTRY_POINT, sepolia.id);
  return { operation: { ...operation, signature: submitted.signature }, hash };
}

async function submit(body: unknown): Promise<Response> {
  const submitted = exactSubmitBody(body);
  const validated = await validateSubmission(submitted);
  const account = serviceAccount();
  const data = encodeFunctionData({
    abi: entryPoint07Abi,
    functionName: "handleOps",
    args: [[packChitUserOperation(validated.operation)], OPERATOR],
  });
  await rpcHex("eth_call", [{
    from: OPERATOR,
    to: ENTRY_POINT,
    data,
    gas: toHex(FIXED_BUNDLER_GAS),
  }, "latest"]);
  const [nonceHex, gasPriceHex] = await Promise.all([
    rpcHex("eth_getTransactionCount", [OPERATOR, "pending"]),
    rpcHex("eth_gasPrice", []),
  ]);
  const serialized = await account.signTransaction({
    chainId: sepolia.id,
    type: "legacy",
    to: ENTRY_POINT,
    data,
    gas: FIXED_BUNDLER_GAS,
    gasPrice: BigInt(gasPriceHex) * 2n,
    nonce: Number(BigInt(nonceHex)),
  });
  const transactionHash = await rpcHex("eth_sendRawTransaction", [serialized]);
  const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
  const receipt = await client.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== "success") throw new Error("EntryPoint transaction reverted");
  const facts = await liveFacts();
  if (facts.currentEpochClaim === 0n) throw new Error("Sponsored claim was not recorded");
  return Response.json({
    transactionHash,
    userOperationHash: validated.hash,
    claimWei: facts.currentEpochClaim.toString(),
    counterAfter: facts.counterCount.toString(),
  }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body) &&
        Object.keys(body).sort().join() === "action" &&
        Reflect.get(body, "action") === "prepare") {
      return await prepare();
    }
    return await submit(body);
  } catch (error) {
    console.error("fixed UserOperation request failed", error);
    const message = error instanceof Error ? error.message : "UserOperation service failed";
    return Response.json({ error: message }, { status: 503 });
  }
}

export async function GET(): Promise<Response> {
  try {
    const facts = await liveFacts();
    return Response.json({
      confirmed: facts.deployed && facts.nonce > 0n && facts.currentEpochClaim > 0n,
      transactionHash: CONFIRMED_TRANSACTION,
      userOperationHash: CONFIRMED_USER_OPERATION,
      claimWei: facts.currentEpochClaim.toString(),
      counterAfter: facts.counterCount.toString(),
      nonce: facts.nonce.toString(),
      accountDeployed: facts.deployed,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("fixed UserOperation status failed", error);
    return Response.json({ error: "user_operation_status_unavailable" }, { status: 503 });
  }
}
