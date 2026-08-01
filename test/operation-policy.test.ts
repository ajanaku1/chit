import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Address, type Hex } from "viem";
import { type UserOperation } from "viem/account-abstraction";
import {
  assertSubmittedOperationMatches,
  validatePreparedOperation,
  type OperationPolicy,
} from "../src/operation-policy.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const FACTORY = "0x2222222222222222222222222222222222222222";
const PAYMASTER = "0x3333333333333333333333333333333333333333";
const FACTORY_DATA = "0x1234";
const CALL_DATA = "0x5678";

const operation: UserOperation<"0.7"> = {
  sender: ACCOUNT,
  nonce: 7n,
  factory: FACTORY,
  factoryData: FACTORY_DATA,
  callData: CALL_DATA,
  callGasLimit: 150_000n,
  verificationGasLimit: 400_000n,
  preVerificationGas: 70_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  paymaster: PAYMASTER,
  paymasterVerificationGasLimit: 200_000n,
  paymasterPostOpGasLimit: 80_000n,
  paymasterData: "0x",
  signature: "0x",
};

const policy: OperationPolicy = {
  account: ACCOUNT,
  expectedNonce: 7n,
  accountDeployed: false,
  accountFactory: FACTORY,
  accountFactoryData: FACTORY_DATA,
  expectedCallData: CALL_DATA,
  paymaster: PAYMASTER,
  maximumCost: 1_800_000_000_000_000n,
  validUntil: 2_000_000_000,
  now: 1_900_000_000,
  currentEpochClaim: 0n,
  gasCeilings: {
    call: 200_000n,
    verification: 500_000n,
    preVerification: 100_000n,
    paymasterVerification: 250_000n,
    paymasterPostOp: 100_000n,
    feePerGas: 3_000_000_000n,
    priorityFeePerGas: 2_000_000_000n,
  },
};

type OperationOverride = Partial<
  Omit<UserOperation<"0.7">, "sender"> & { sender: Address }
>;

function withOperation(
  overrides: OperationOverride,
): UserOperation<"0.7"> {
  return { ...operation, ...overrides };
}

function rejects(
  overrides: OperationOverride,
  policyOverrides: Partial<OperationPolicy> = {},
  pattern: RegExp,
): void {
  assert.throws(
    () =>
      validatePreparedOperation(withOperation(overrides), {
        ...policy,
        ...policyOverrides,
      }),
    pattern,
  );
}

describe("prepared UserOperation policy", () => {
  it("accepts only the exact undeployed SimpleAccount counter operation", () => {
    assert.doesNotThrow(() => validatePreparedOperation(operation, policy));
  });

  it("rejects a different enrolled account or nonce", () => {
    rejects(
      { sender: "0x4444444444444444444444444444444444444444" },
      {},
      /sender/i,
    );
    rejects({ nonce: 8n }, {}, /nonce/i);
  });

  it("rejects malicious or missing counterfactual deployment data", () => {
    rejects(
      { factory: "0x4444444444444444444444444444444444444444" },
      {},
      /factory/i,
    );
    rejects({ factoryData: "0xbeef" }, {}, /factory data/i);
    rejects({ factory: undefined, factoryData: undefined }, {}, /factory/i);
  });

  it("requires empty deployment data for an existing account", () => {
    const deployedPolicy = { ...policy, accountDeployed: true };

    assert.doesNotThrow(() =>
      validatePreparedOperation(
        withOperation({ factory: undefined, factoryData: undefined }),
        deployedPolicy,
      ),
    );
    rejects({}, deployedPolicy, /deployed account.*factory/i);
  });

  it("rejects any call or paymaster outside the fixed round policy", () => {
    rejects({ callData: "0xbeef" }, {}, /call data/i);
    rejects(
      { paymaster: "0x4444444444444444444444444444444444444444" },
      {},
      /paymaster/i,
    );
    rejects({ paymaster: undefined }, {}, /paymaster/i);
    rejects({ paymasterData: "0xabcd" }, {}, /paymaster data/i);
    rejects({ signature: "0xab" }, {}, /account signature/i);
  });

  it("rejects every gas ceiling and the computed maximum cost", () => {
    rejects({ callGasLimit: 200_001n }, {}, /call gas/i);
    rejects({ verificationGasLimit: 500_001n }, {}, /verification gas/i);
    rejects({ preVerificationGas: 100_001n }, {}, /pre-verification gas/i);
    rejects(
      { paymasterVerificationGasLimit: 250_001n },
      {},
      /paymaster verification gas/i,
    );
    rejects({ paymasterPostOpGasLimit: 100_001n }, {}, /paymaster post-op gas/i);
    rejects({ maxFeePerGas: 3_000_000_001n }, {}, /fee per gas/i);
    rejects(
      { maxPriorityFeePerGas: 2_000_000_001n },
      {},
      /priority fee/i,
    );
    rejects({}, { maximumCost: 1n }, /maximum cost/i);
    rejects(
      {},
      { maximumCost: policy.maximumCost + 1n },
      /maximum cost/i,
    );
  });

  it("rejects expired or already-claimed epoch authorization", () => {
    rejects({}, { now: policy.validUntil + 1 }, /expired/i);
    rejects({}, { currentEpochClaim: 1n }, /already.*claim/i);
  });
});

describe("submitted UserOperation immutability", () => {
  it("permits only the owner account signature to be added", () => {
    const signed = withOperation({ signature: `0x${"ab".repeat(65)}` as Hex });

    assert.doesNotThrow(() => assertSubmittedOperationMatches(operation, signed));
  });

  it("rejects an absent signature or mutation of any reserved field", () => {
    assert.throws(
      () => assertSubmittedOperationMatches(operation, operation),
      /signature/i,
    );
    assert.throws(
      () =>
        assertSubmittedOperationMatches(
          operation,
          withOperation({
            callGasLimit: operation.callGasLimit + 1n,
            signature: "0xab",
          }),
        ),
      /reserved/i,
    );
    assert.throws(
      () =>
        assertSubmittedOperationMatches(
          operation,
          withOperation({ paymasterData: "0xbeef", signature: "0xab" }),
        ),
      /reserved/i,
    );
  });
});
