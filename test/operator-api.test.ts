import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Address, type Hex } from "viem";
import { type UserOperation } from "viem/account-abstraction";
import {
  OperatorApiRouter,
  type RoundApiContext,
} from "../src/operator-api.js";
import { type OperatorApiRequest } from "../src/http-service.js";

const ROUND = `0x${"11".repeat(32)}`;
const OTHER_ROUND = `0x${"22".repeat(32)}`;
const CREATOR = `0x${"33".repeat(20)}` as Address;
const SPONSOR = `0x${"44".repeat(20)}` as Address;
const OWNER = `0x${"55".repeat(20)}` as Address;
const ACCOUNT = `0x${"66".repeat(20)}` as Address;
const TRANSACTION_HASH = `0x${"77".repeat(32)}` as Hex;
const ROUND_SALT = `0x${"88".repeat(32)}` as Hex;
const OPERATION_KEY = `0x${"99".repeat(32)}` as Hex;
const proof = {
  nonce: "proof-1",
  expiresAt: 2_000_000_000,
  signature: `0x${"aa".repeat(65)}` as Hex,
};
const operation = {
  sender: ACCOUNT,
  nonce: 0n,
  callData: "0x" as Hex,
  callGasLimit: 1n,
  verificationGasLimit: 1n,
  preVerificationGas: 1n,
  maxFeePerGas: 1n,
  maxPriorityFeePerGas: 1n,
  paymaster: `0x${"bb".repeat(20)}` as Address,
  paymasterVerificationGasLimit: 1n,
  paymasterPostOpGasLimit: 1n,
  paymasterData: "0x" as Hex,
  signature: "0x" as Hex,
} satisfies UserOperation<"0.7">;

class RecordingRoundContext implements RoundApiContext {
  readonly round = ROUND;
  readonly calls: string[] = [];
  readonly operator = {
    registerSponsor: async () => { this.calls.push("register"); },
    issueInvite: async () => {
      this.calls.push("invite");
      return { account: ACCOUNT, token: "opaque" };
    },
    prepareUserOperation: async () => {
      this.calls.push("prepare");
      return { operationKey: OPERATION_KEY, validUntil: 2_000_000_000, operation };
    },
    submitUserOperation: async () => {
      this.calls.push("submit");
      return { status: "confirmed" as const, transactionHash: TRANSACTION_HASH, actualClaim: 1n };
    },
  };
  readonly lifecycle = {
    enrollAccount: async () => {
      this.calls.push("enroll");
      return { kind: "enrollment" as const, transactionHash: TRANSACTION_HASH };
    },
    settleRound: async () => {
      this.calls.push("settle");
      return {
        kind: "settlement" as const,
        epoch: "0",
        settlementTransactionHash: TRANSACTION_HASH,
      };
    },
    recoverOperatorGas: async () => {
      this.calls.push("recover");
      return {
        kind: "operator-gas-recovery" as const,
        transactionHash: TRANSACTION_HASH,
        recoveredValue: "90",
        retainedGas: "10",
      };
    },
  };

  async readPublicRound(): Promise<object> {
    this.calls.push("read");
    return { round: ROUND, state: "active" };
  }
}

function sponsorRequest(): OperatorApiRequest {
  return {
    kind: "register-sponsor",
    round: ROUND,
    body: {
      round: ROUND,
      sponsor: SPONSOR,
      slot: 1,
      registrationTx: TRANSACTION_HASH,
      declaredBudget: 100n,
      admission: proof,
      sponsorProof: proof,
    },
  };
}

function requests(): readonly OperatorApiRequest[] {
  return [
    { kind: "get-round", round: ROUND },
    sponsorRequest(),
    {
      kind: "issue-invite",
      round: ROUND,
      body: {
        round: ROUND,
        sponsor: SPONSOR,
        slot: 1,
        owner: OWNER,
        inviteNonce: "invite-1",
        inviteExpiresAt: 2_000_000_000,
        sponsorProof: proof,
      },
    },
    {
      kind: "prepare-operation",
      round: ROUND,
      body: { round: ROUND, token: "opaque", owner: OWNER, operation },
    },
    {
      kind: "submit-operation",
      round: ROUND,
      body: { operationKey: OPERATION_KEY, operation },
    },
    {
      kind: "enroll-account",
      round: ROUND,
      body: {
        round: ROUND,
        token: "opaque",
        owner: OWNER,
        account: ACCOUNT,
        ownerProof: proof,
      },
    },
    {
      kind: "settle-round",
      round: ROUND,
      body: { round: ROUND, creatorProof: proof },
    },
    {
      kind: "recover-operator-gas",
      round: ROUND,
      body: {
        round: ROUND,
        closedBlockHash: TRANSACTION_HASH,
        creatorProof: proof,
      },
    },
  ];
}

describe("operator API router", () => {
  it("dispatches every round command through the exact pinned context", async () => {
    const context = new RecordingRoundContext();
    const api = new OperatorApiRouter({
      rounds: { async get(round) { return round === ROUND ? context : undefined; } },
      deriver: { derive() { return CREATOR; } },
      health: { async read() { return { status: "ok" }; } },
    });
    const signal = AbortSignal.timeout(1_000);

    for (const request of requests()) {
      await api.execute(request, { requestId: "request-1", signal });
    }

    assert.deepEqual(context.calls, [
      "read", "register", "invite", "prepare", "submit", "enroll", "settle", "recover",
    ]);
  });

  it("rejects unknown and mismatched round contexts before executing a command", async () => {
    const context = new RecordingRoundContext();
    const missing = new OperatorApiRouter({
      rounds: { async get() { return undefined; } },
      deriver: { derive() { return CREATOR; } },
      health: { async read() { return { status: "ok" }; } },
    });
    await assert.rejects(
      missing.execute(sponsorRequest(), {
        requestId: "missing",
        signal: AbortSignal.timeout(1_000),
      }),
      /not found/i,
    );

    const mismatched = new OperatorApiRouter({
      rounds: {
        async get() {
          return {
            round: OTHER_ROUND,
            operator: context.operator,
            lifecycle: context.lifecycle,
            readPublicRound: context.readPublicRound.bind(context),
          };
        },
      },
      deriver: { derive() { return CREATOR; } },
      health: { async read() { return { status: "ok" }; } },
    });
    await assert.rejects(
      mismatched.execute(sponsorRequest(), {
        requestId: "mismatch",
        signal: AbortSignal.timeout(1_000),
      }),
      /pinned/i,
    );
    assert.deepEqual(context.calls, []);
  });

  it("exposes only a derived public address and delegated health state", async () => {
    const derived: Array<{ creator: Address; roundSalt: Hex }> = [];
    const api = new OperatorApiRouter({
      rounds: { async get() { return undefined; } },
      deriver: {
        derive(creator, roundSalt) {
          derived.push({ creator, roundSalt });
          return ACCOUNT;
        },
      },
      health: { async read() { return { status: "ok", rpc: "ok" }; } },
    });
    const context = { requestId: "public", signal: AbortSignal.timeout(1_000) };

    assert.deepEqual(await api.execute({ kind: "health" }, context), {
      status: "ok",
      rpc: "ok",
    });
    assert.deepEqual(await api.execute({
      kind: "derive-operator",
      body: { creator: CREATOR, roundSalt: ROUND_SALT },
    }, context), { operator: ACCOUNT });
    assert.deepEqual(derived, [{ creator: CREATOR, roundSalt: ROUND_SALT }]);
  });
});
