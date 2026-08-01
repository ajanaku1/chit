import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LOW_STAKE_PROFILE,
  assertLowStakeBalance,
  clearFailedFactoryDeployment,
  missingInitializationSteps,
  nextLowStakeAction,
  parseFactoryBytecode,
  parseLowStakeRound,
  parseRecoveryCheckpoint,
} from "../src/low-stake-round.js";

describe("low-stake Sepolia round", () => {
  it("orders recovery actions without replaying completed chain state", () => {
    assert.deepEqual(nextLowStakeAction({ pending: true, factory: false }), {
      kind: "reconcile-pending",
    });
    assert.deepEqual(nextLowStakeAction({ pending: false, factory: false }), {
      kind: "deploy-factory",
    });
    assert.deepEqual(nextLowStakeAction({
      pending: false,
      factory: true,
      round: false,
    }), { kind: "begin-round" });
    assert.deepEqual(nextLowStakeAction({
      pending: false,
      factory: true,
      round: true,
      initializationMask: 0b00101,
      roundState: 0,
    }), { kind: "initialize", step: 1 });
    assert.deepEqual(nextLowStakeAction({
      pending: false,
      factory: true,
      round: true,
      initializationMask: 31,
      roundState: 0,
    }), { kind: "activate" });
    assert.deepEqual(nextLowStakeAction({
      pending: false,
      factory: true,
      round: true,
      initializationMask: 31,
      roundState: 1,
    }), { kind: "complete" });
  });

  it("pins an honestly disclosed profile that fits the measured wallet budget", () => {
    assert.deepEqual(LOW_STAKE_PROFILE, {
      minimumStake: 100_000_000_000_000_000n,
      paymasterDeposit: 10_000_000_000_000_000n,
      operatorGas: 1_000_000_000_000_000n,
      unstakeDelay: 86_400,
      minimumWalletBalance: 130_000_000_000_000_000n,
    });
    assert.doesNotThrow(() =>
      assertLowStakeBalance(LOW_STAKE_PROFILE.minimumWalletBalance),
    );
    assert.throws(
      () => assertLowStakeBalance(LOW_STAKE_PROFILE.minimumWalletBalance - 1n),
      /0\.13.*Sepolia ETH/i,
    );
  });

  it("resumes only unfinished initialization steps", () => {
    assert.deepEqual(missingInitializationSteps(0), [0, 1, 2, 3, 4]);
    assert.deepEqual(missingInitializationSteps(0b00101), [1, 3, 4]);
    assert.deepEqual(missingInitializationSteps(0b11111), []);
    assert.throws(() => missingInitializationSteps(32), /mask/i);
  });

  it("accepts only a deployable factory artifact", () => {
    assert.equal(parseFactoryBytecode({ bytecode: "0x60006000" }), "0x60006000");
    assert.throws(() => parseFactoryBytecode({ bytecode: "0x" }), /bytecode/i);
    assert.throws(() => parseFactoryBytecode({}), /bytecode/i);
  });

  it("parses only a complete factory round tuple", () => {
    const round = {
      creator: "0x1111111111111111111111111111111111111111",
      operator: "0x2222222222222222222222222222222222222222",
      verifier: "0x3333333333333333333333333333333333333333",
      auditor: "0x4444444444444444444444444444444444444444",
      vault: "0x5555555555555555555555555555555555555555",
      settlement: "0x6666666666666666666666666666666666666666",
      paymaster: "0x7777777777777777777777777777777777777777",
      initializedSteps: 7,
    };
    assert.deepEqual(parseLowStakeRound(round), round);
    assert.throws(
      () => parseLowStakeRound({ ...round, paymaster: "0x12" }),
      /paymaster/i,
    );
    assert.throws(
      () => parseLowStakeRound({ ...round, initializedSteps: 32 }),
      /initializedSteps/i,
    );
  });

  it("loads only public resumability fields from browser storage", () => {
    const checkpoint = {
      factory: "0x1111111111111111111111111111111111111111",
      factoryDeployTx: `0x${"22".repeat(32)}`,
      pendingHash: `0x${"33".repeat(32)}`,
      pendingLabel: "initialize 2",
      lastHash: `0x${"44".repeat(32)}`,
    };
    assert.deepEqual(parseRecoveryCheckpoint(checkpoint), checkpoint);
    assert.throws(
      () => parseRecoveryCheckpoint({ ...checkpoint, pendingHash: "0x12" }),
      /pendingHash/i,
    );
    assert.throws(
      () => parseRecoveryCheckpoint({ factory: checkpoint.factory }),
      /factoryDeployTx/i,
    );
  });

  it("clears only the matching failed factory deployment", () => {
    const failedHash = `0x${"55".repeat(32)}` as const;
    const otherHash = `0x${"66".repeat(32)}` as const;
    const checkpoint = parseRecoveryCheckpoint({
      factory: "0x1111111111111111111111111111111111111111",
      factoryDeployTx: failedHash,
      lastHash: failedHash,
    });

    assert.deepEqual(clearFailedFactoryDeployment(checkpoint, otherHash), checkpoint);
    assert.deepEqual(clearFailedFactoryDeployment(checkpoint, failedHash), {
      lastHash: failedHash,
    });
  });
});
