import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeAbiParameters, sliceHex } from "viem";
import {
  getUserOperationHash,
  toPackedUserOperation,
  type UserOperation,
} from "viem/account-abstraction";
import {
  buildPaymasterAndData,
  buildPaymasterPrefix,
  packChitUserOperation,
  userOperationHash,
} from "../src/user-operation.js";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const PAYMASTER = "0x1111111111111111111111111111111111111111";
const SENDER = "0x2222222222222222222222222222222222222222";

const operation: UserOperation<"0.7"> = {
  sender: SENDER,
  nonce: 3n,
  factory: "0x3333333333333333333333333333333333333333",
  factoryData: "0x1234",
  callData: "0x5678",
  callGasLimit: 300_000n,
  verificationGasLimit: 700_000n,
  preVerificationGas: 80_000n,
  maxFeePerGas: 4_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  paymaster: PAYMASTER,
  paymasterVerificationGasLimit: 250_000n,
  paymasterPostOpGasLimit: 120_000n,
  paymasterData: "0xabcd",
  signature: "0xdead",
};

describe("packed EntryPoint v0.7 UserOperation", () => {
  it("matches viem's canonical packed representation byte-for-byte", () => {
    assert.deepEqual(
      packChitUserOperation(operation),
      toPackedUserOperation(operation),
    );
  });

  it("matches viem's canonical EntryPoint hash", () => {
    assert.equal(
      userOperationHash(operation, ENTRY_POINT, 11155111),
      getUserOperationHash({
        userOperation: operation,
        entryPointAddress: ENTRY_POINT,
        entryPointVersion: "0.7",
        chainId: 11155111,
      }),
    );
  });
});

describe("Chit paymaster payload", () => {
  it("packs the address and two uint128 gas limits into exactly 52 bytes", () => {
    const prefix = buildPaymasterPrefix(PAYMASTER, 250_000n, 120_000n);

    assert.equal(prefix.length, 2 + 52 * 2);
    assert.equal(sliceHex(prefix, 0, 20), PAYMASTER);
    assert.equal(BigInt(sliceHex(prefix, 20, 36)), 250_000n);
    assert.equal(BigInt(sliceHex(prefix, 36, 52)), 120_000n);
  });

  it("appends the exact Solidity ABI tail expected by ChitPaymaster", () => {
    const validUntil = 2_000_000_000;
    const signature = `0x${"ab".repeat(65)}` as const;
    const payload = buildPaymasterAndData(
      PAYMASTER,
      250_000n,
      120_000n,
      validUntil,
      signature,
    );
    const [decodedExpiry, decodedSignature] = decodeAbiParameters(
      [{ type: "uint48" }, { type: "bytes" }],
      sliceHex(payload, 52),
    );

    assert.equal(decodedExpiry, validUntil);
    assert.equal(decodedSignature, signature);
  });
});
