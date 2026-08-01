import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canEditRoundLabel,
  deriveRoundSalt,
  nextRoundAction,
  parseRoundCheckpoint,
} from "../src/round-machine.js";

const CREATOR = "0x34b0Ba20669f3ec4F1056853780c381e5e35F724" as const;

describe("round identity", () => {
  it("derives the same salt from equivalent human labels", () => {
    const first = deriveRoundSalt("  Lagos Builders  ", CREATOR);
    const second = deriveRoundSalt("lagos   builders", CREATOR.toLowerCase());

    assert.equal(first, second);
    assert.match(first, /^0x[0-9a-f]{64}$/);
  });

  it("rejects an empty round label", () => {
    assert.throws(() => deriveRoundSalt("   ", CREATOR), /round name/i);
  });
});

describe("new round progression", () => {
  it("allows renaming only before round creation is pending or on-chain", () => {
    assert.equal(
      canEditRoundLabel({ pending: false, exists: false, initializationMask: 0 }),
      true,
    );
    assert.equal(
      canEditRoundLabel({ pending: true, exists: false, initializationMask: 0 }),
      false,
    );
    assert.equal(
      canEditRoundLabel({ pending: false, exists: true, initializationMask: 0 }),
      false,
    );
  });

  it("reconciles a pending transaction before planning another write", () => {
    assert.deepEqual(
      nextRoundAction({ pending: true, exists: false, initializationMask: 0 }),
      { kind: "reconcile" },
    );
  });

  it("begins a missing round", () => {
    assert.deepEqual(
      nextRoundAction({ pending: false, exists: false, initializationMask: 0 }),
      { kind: "begin" },
    );
  });

  it("selects the first missing Nox initialization bit", () => {
    assert.deepEqual(
      nextRoundAction({ pending: false, exists: true, initializationMask: 0b00101 }),
      { kind: "initialize", step: 1 },
    );
  });

  it("activates only after all five Nox states exist", () => {
    assert.deepEqual(
      nextRoundAction({
        pending: false,
        exists: true,
        initializationMask: 0b11111,
        roundState: 0,
      }),
      { kind: "activate" },
    );
  });

  it("stops once the round is active", () => {
    assert.deepEqual(
      nextRoundAction({
        pending: false,
        exists: true,
        initializationMask: 0b11111,
        roundState: 1,
      }),
      { kind: "complete" },
    );
  });
});

describe("round checkpoint", () => {
  it("rejects malformed persisted transaction data", () => {
    assert.throws(
      () => parseRoundCheckpoint({ label: "Builders", pendingHash: "0x1234" }),
      /pendingHash/i,
    );
  });

  it("accepts a valid resumable checkpoint", () => {
    const hash = `0x${"ab".repeat(32)}`;
    assert.deepEqual(
      parseRoundCheckpoint({
        label: "Builders",
        pendingHash: hash,
        pendingLabel: "round creation",
        lastHash: hash,
      }),
      {
        label: "Builders",
        pendingHash: hash,
        pendingLabel: "round creation",
        lastHash: hash,
      },
    );
  });

  it("rejects a malformed last confirmed hash", () => {
    assert.throws(
      () => parseRoundCheckpoint({ label: "Builders", lastHash: "0xbeef" }),
      /lastHash/i,
    );
  });
});
