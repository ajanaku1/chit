import {
  concatHex,
  encodeAbiParameters,
  padHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  getUserOperationHash,
  toPackedUserOperation,
  type PackedUserOperation,
  type UserOperation,
} from "viem/account-abstraction";

const UINT128_MAX = (1n << 128n) - 1n;
const UINT48_MAX = 2 ** 48 - 1;

function bounded(value: bigint, maximum: bigint, field: string): bigint {
  if (value < 0n || value > maximum) {
    throw new RangeError(`${field} is outside its unsigned integer range`);
  }
  return value;
}

function uint128(value: bigint, field: string): Hex {
  return padHex(toHex(bounded(value, UINT128_MAX, field)), { size: 16 });
}

export function buildPaymasterPrefix(
  paymaster: Address,
  verificationGasLimit: bigint,
  postOpGasLimit: bigint,
): Hex {
  return concatHex([
    paymaster,
    uint128(verificationGasLimit, "paymasterVerificationGasLimit"),
    uint128(postOpGasLimit, "paymasterPostOpGasLimit"),
  ]);
}

export function buildPaymasterAndData(
  paymaster: Address,
  verificationGasLimit: bigint,
  postOpGasLimit: bigint,
  validUntil: number,
  verifierSignature: Hex,
): Hex {
  const prefix = buildPaymasterPrefix(
    paymaster,
    verificationGasLimit,
    postOpGasLimit,
  );
  const tail = encodeAbiParameters(
    [{ type: "uint48" }, { type: "bytes" }],
    [validUint48(validUntil), verifierSignature],
  );
  return concatHex([prefix, tail]);
}

function validUint48(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT48_MAX) {
    throw new RangeError("validUntil is outside its uint48 range");
  }
  return value;
}

export function packChitUserOperation(
  userOperation: UserOperation<"0.7">,
): PackedUserOperation {
  return toPackedUserOperation(userOperation);
}

export function userOperationHash(
  userOperation: UserOperation<"0.7">,
  entryPointAddress: Address,
  chainId: number,
): Hex {
  return getUserOperationHash({
    userOperation,
    entryPointAddress,
    entryPointVersion: "0.7",
    chainId,
  });
}
