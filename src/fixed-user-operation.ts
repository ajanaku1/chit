import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isHex,
  keccak256,
  parseAbi,
  recoverMessageAddress,
  size,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { type UserOperation } from "viem/account-abstraction";
import { userOperationHash } from "./user-operation.js";

const ACCOUNT_ABI = parseAbi([
  "function execute(address dest,uint256 value,bytes func)",
]);
const COUNTER_ABI = parseAbi(["function increment()"]);
const HOSTED_RESERVATION_TYPEHASH = keccak256(
  toHex("ChitHostedOperation(bytes32 userOperationHash,uint48 validUntil)"),
);
const SERIALIZED_FIELDS = [
  "sender",
  "nonce",
  "factory",
  "factoryData",
  "callData",
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "paymaster",
  "paymasterVerificationGasLimit",
  "paymasterPostOpGasLimit",
  "paymasterData",
  "signature",
] as const;

export const FIXED_OPERATION_GAS = {
  callGasLimit: 300_000n,
  verificationGasLimit: 1_000_000n,
  preVerificationGas: 120_000n,
  paymasterVerificationGasLimit: 300_000n,
  paymasterPostOpGasLimit: 250_000n,
} as const;

export const FIXED_BUNDLER_GAS = 5_000_000n;

interface FixedOperationInput {
  readonly sender: Address;
  readonly nonce: bigint;
  readonly deployed: boolean;
  readonly factory: Address;
  readonly factoryData: Hex;
  readonly counter: Address;
  readonly paymaster: Address;
  readonly maxFeePerGas: bigint;
}

export type SerializedUserOperation = Readonly<Record<string, string>>;

export function contractInteger(value: unknown, label: string): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error(`${label} is invalid`);
}

export function hostedOperationReservationDigest(
  operationHash: Hex,
  validUntil: number,
): Hex {
  if (!Number.isSafeInteger(validUntil) || validUntil < 0) {
    throw new Error("Reservation expiry is invalid");
  }
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint48" }],
    [HOSTED_RESERVATION_TYPEHASH, operationHash, validUntil],
  ));
}

export function buildFixedUserOperation(
  input: FixedOperationInput,
): UserOperation<"0.7"> {
  const increment = encodeFunctionData({
    abi: COUNTER_ABI,
    functionName: "increment",
  });
  const deployment = input.deployed
    ? {}
    : { factory: input.factory, factoryData: input.factoryData };
  return {
    sender: input.sender,
    nonce: input.nonce,
    ...deployment,
    callData: encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "execute",
      args: [input.counter, 0n, increment],
    }),
    ...FIXED_OPERATION_GAS,
    maxFeePerGas: input.maxFeePerGas,
    maxPriorityFeePerGas: input.maxFeePerGas,
    paymaster: input.paymaster,
    paymasterData: "0x",
    signature: "0x",
  };
}

export function serializeUserOperation(
  operation: UserOperation<"0.7">,
): SerializedUserOperation {
  const entries = Object.entries(operation).map(([key, value]) => [
    key,
    typeof value === "bigint" ? value.toString() : value,
  ]);
  return Object.fromEntries(entries) as SerializedUserOperation;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("UserOperation must be an object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) => !(SERIALIZED_FIELDS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) throw new Error("UserOperation contains unknown fields");
  return record;
}

function requireHex(record: Record<string, unknown>, key: string): Hex {
  const value = record[key];
  if (typeof value !== "string" || !isHex(value)) {
    throw new Error(`${key} must be hex`);
  }
  return value;
}

function optionalAddress(
  record: Record<string, unknown>,
  key: string,
): Address | undefined {
  return record[key] === undefined ? undefined : getAddress(requireHex(record, key));
}

function requireUnsignedInteger(
  record: Record<string, unknown>,
  key: string,
): bigint {
  const value = record[key];
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${key} must be an unsigned integer string`);
  }
  return BigInt(value);
}

export function parseSerializedUserOperation(
  value: unknown,
): UserOperation<"0.7"> {
  const record = requireRecord(value);
  const factory = optionalAddress(record, "factory");
  const factoryData = record.factoryData === undefined
    ? undefined
    : requireHex(record, "factoryData");
  if ((factory === undefined) !== (factoryData === undefined)) {
    throw new Error("factory and factoryData must be supplied together");
  }
  return {
    sender: getAddress(requireHex(record, "sender")),
    nonce: requireUnsignedInteger(record, "nonce"),
    ...(factory === undefined ? {} : { factory, factoryData }),
    callData: requireHex(record, "callData"),
    callGasLimit: requireUnsignedInteger(record, "callGasLimit"),
    verificationGasLimit: requireUnsignedInteger(record, "verificationGasLimit"),
    preVerificationGas: requireUnsignedInteger(record, "preVerificationGas"),
    maxFeePerGas: requireUnsignedInteger(record, "maxFeePerGas"),
    maxPriorityFeePerGas: requireUnsignedInteger(record, "maxPriorityFeePerGas"),
    paymaster: getAddress(requireHex(record, "paymaster")),
    paymasterVerificationGasLimit: requireUnsignedInteger(
      record,
      "paymasterVerificationGasLimit",
    ),
    paymasterPostOpGasLimit: requireUnsignedInteger(record, "paymasterPostOpGasLimit"),
    paymasterData: requireHex(record, "paymasterData"),
    signature: requireHex(record, "signature"),
  };
}

export async function verifyOwnerOperationSignature(
  operation: UserOperation<"0.7">,
  signature: Hex,
  owner: Address,
  entryPoint: Address,
  chainId: number,
): Promise<void> {
  if (size(signature) !== 65) throw new Error("Creator signature is invalid");
  const hash = userOperationHash(operation, entryPoint, chainId);
  const signer = await recoverMessageAddress({
    message: { raw: hash },
    signature,
  });
  if (signer.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Creator signature does not authorize this UserOperation");
  }
}
