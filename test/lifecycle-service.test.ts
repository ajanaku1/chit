import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  RoundLifecycleService,
  type LifecycleActionRecord,
  type LifecycleReconciliation,
} from "../src/lifecycle-service.js";
import { UnknownTransactionOutcomeError } from "../src/live-adapters.js";
import { PolicyStore } from "../src/policy-store.js";
import {
  InviteCodec,
  buildRequestMessage,
  hashRequestBody,
} from "../src/service-crypto.js";
import { type WalletProof } from "../src/operator-service.js";

const ORIGIN = "https://chit.example";
const CHAIN_ID = 11_155_111;
const FACTORY = `0x${"11".repeat(20)}` as Address;
const ROUND = `0x${"22".repeat(32)}`;
const ACCOUNT = `0x${"33".repeat(20)}` as Address;
const CLOSED_BLOCK_HASH = `0x${"44".repeat(32)}` as Hex;
const TRANSACTION_HASH = `0x${"55".repeat(32)}` as Hex;
const creator = privateKeyToAccount(`0x${"66".repeat(32)}`);
const owner = privateKeyToAccount(`0x${"77".repeat(32)}`);
const sponsor = privateKeyToAccount(`0x${"88".repeat(32)}`);
const temporaryDirectories: string[] = [];

class RecordingLifecycleAdapters {
  enrollments = 0;
  settlements = 0;
  recoveries = 0;
  outcome: "confirmed" | "unknown" | "failed" = "confirmed";
  reconciliation: LifecycleReconciliation = { status: "unresolved" };
  nextEpoch = 3n;
  resultEpoch = 3n;

  async enroll(input: { account: Address; sponsorSlot: number; signal: AbortSignal }) {
    this.enrollments += 1;
    assert.equal(input.account, ACCOUNT);
    assert.equal(input.sponsorSlot, 2);
    return { transactionHash: TRANSACTION_HASH };
  }

  async nextSettlementEpoch(): Promise<bigint> {
    return this.nextEpoch;
  }

  async settle(input: { round: string; signal: AbortSignal }) {
    this.settlements += 1;
    if (this.outcome === "unknown") {
      throw new UnknownTransactionOutcomeError(TRANSACTION_HASH);
    }
    if (this.outcome === "failed") throw new Error("settlement reverted");
    return {
      epoch: this.resultEpoch,
      settlementTransactionHash: TRANSACTION_HASH,
    };
  }

  async recover(): Promise<{
    transactionHash: Hex;
    recoveredValue: bigint;
    retainedGas: bigint;
  }> {
    this.recoveries += 1;
    return {
      transactionHash: TRANSACTION_HASH,
      recoveredValue: 90n,
      retainedGas: 10n,
    };
  }

  async reconcile(_record: LifecycleActionRecord): Promise<LifecycleReconciliation> {
    return this.reconciliation;
  }
}

interface Fixture {
  readonly adapters: RecordingLifecycleAdapters;
  readonly codec: InviteCodec;
  readonly service: RoundLifecycleService;
  readonly store: PolicyStore;
}

function createFixture(path?: string): Fixture {
  const directory = path ?? mkdtempSync(join(tmpdir(), "chit-lifecycle-"));
  if (path === undefined) temporaryDirectories.push(directory);
  const store = new PolicyStore({
    path: join(directory, "policy.sqlite"),
    encryptionKey: Buffer.alloc(32, 19),
  });
  const codec = new InviteCodec({
    masterSecret: Buffer.alloc(32, 23),
    origin: ORIGIN,
    chainId: CHAIN_ID,
    factory: FACTORY,
  });
  const adapters = new RecordingLifecycleAdapters();
  const service = new RoundLifecycleService({
    origin: ORIGIN,
    chainId: CHAIN_ID,
    factory: FACTORY,
    creator: creator.address,
    round: ROUND,
    clock: () => 1_900_000_000,
    store,
    inviteCodec: codec,
    enrollment: adapters,
    settlement: adapters,
    recovery: adapters,
    reconciler: adapters,
  });
  return { adapters, codec, service, store };
}

async function proof(
  signer: PrivateKeyAccount,
  body: object,
  nonce: string,
): Promise<WalletProof> {
  const expiresAt = 2_000_000_000;
  return {
    nonce,
    expiresAt,
    signature: await signer.signMessage({
      message: buildRequestMessage({
        origin: ORIGIN,
        chainId: CHAIN_ID,
        factory: FACTORY,
        round: ROUND,
        bodyHash: hashRequestBody(body),
        nonce,
        expiresAt,
      }),
    }),
  };
}

function invite(codec: InviteCodec): string {
  return codec.issue({
    round: ROUND,
    sponsor: sponsor.address,
    sponsorSlot: 2,
    owner: owner.address,
    account: ACCOUNT,
    expiresAt: 2_000_000_000,
    nonce: "invite-1",
    action: "counter.increment",
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("round lifecycle service", () => {
  it("requires the invited owner to authorize exact enrollment fields", async () => {
    const fixture = createFixture();
    const token = invite(fixture.codec);
    const body = {
      action: "enroll-account",
      token,
      owner: owner.address,
      account: ACCOUNT,
    };

    const result = await fixture.service.enrollAccount({
      round: ROUND,
      token,
      owner: owner.address,
      account: ACCOUNT,
      ownerProof: await proof(owner, body, "enroll-1"),
    }, AbortSignal.timeout(1_000));

    assert.deepEqual(result, {
      kind: "enrollment",
      transactionHash: TRANSACTION_HASH,
    });
    assert.equal(fixture.adapters.enrollments, 1);
    fixture.store.close();
  });

  it("rejects a changed enrollment account before invoking Nox", async () => {
    const fixture = createFixture();
    const token = invite(fixture.codec);
    const body = {
      action: "enroll-account",
      token,
      owner: owner.address,
      account: ACCOUNT,
    };

    await assert.rejects(
      fixture.service.enrollAccount({
        round: ROUND,
        token,
        owner: owner.address,
        account: `0x${"99".repeat(20)}`,
        ownerProof: await proof(owner, body, "enroll-tampered"),
      }, AbortSignal.timeout(1_000)),
      /signature/i,
    );

    assert.equal(fixture.adapters.enrollments, 0);
    fixture.store.close();
  });

  it("persists a confirmed enrollment and returns it without a second write", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chit-lifecycle-durable-"));
    temporaryDirectories.push(directory);
    const first = createFixture(directory);
    const token = invite(first.codec);
    const body = {
      action: "enroll-account",
      token,
      owner: owner.address,
      account: ACCOUNT,
    };
    const request = {
      round: ROUND,
      token,
      owner: owner.address,
      account: ACCOUNT,
      ownerProof: await proof(owner, body, "enroll-durable"),
    };

    await first.service.enrollAccount(request, AbortSignal.timeout(1_000));
    assert.equal(first.adapters.enrollments, 1);
    first.store.close();

    const second = createFixture(directory);
    const replay = await second.service.enrollAccount(
      request,
      AbortSignal.timeout(1_000),
    );

    assert.deepEqual(replay, {
      kind: "enrollment",
      transactionHash: TRANSACTION_HASH,
    });
    assert.equal(second.adapters.enrollments, 0);
    second.store.close();
  });

  it("reconciles an unknown settlement instead of broadcasting it twice", async () => {
    const fixture = createFixture();
    fixture.adapters.outcome = "unknown";
    const body = { action: "settle-round" };
    const request = {
      round: ROUND,
      creatorProof: await proof(creator, body, "settle-unknown"),
    };

    await assert.rejects(
      fixture.service.settleRound(request, AbortSignal.timeout(1_000)),
      /unknown/i,
    );
    assert.equal(fixture.adapters.settlements, 1);

    fixture.adapters.reconciliation = {
      status: "confirmed",
      result: {
        kind: "settlement",
        epoch: "3",
        settlementTransactionHash: TRANSACTION_HASH,
      },
    };
    const reconciled = await fixture.service.settleRound(
      request,
      AbortSignal.timeout(1_000),
    );

    assert.equal(fixture.adapters.settlements, 1);
    assert.deepEqual(reconciled, fixture.adapters.reconciliation.result);
    fixture.store.close();
  });

  it("supports background reconciliation without replaying a signed request", async () => {
    const fixture = createFixture();
    fixture.adapters.outcome = "unknown";
    const body = { action: "settle-round" };
    const request = {
      round: ROUND,
      creatorProof: await proof(creator, body, "settle-background"),
    };
    await assert.rejects(
      fixture.service.settleRound(request, AbortSignal.timeout(1_000)),
      /unknown/i,
    );
    fixture.adapters.reconciliation = {
      status: "confirmed",
      result: {
        kind: "settlement",
        epoch: "3",
        settlementTransactionHash: TRANSACTION_HASH,
      },
    };

    const summary = await fixture.service.reconcilePending(
      AbortSignal.timeout(1_000),
    );
    const replay = await fixture.service.settleRound(
      request,
      AbortSignal.timeout(1_000),
    );

    assert.deepEqual(summary, { confirmed: 1, retrySafe: 0, unresolved: 0 });
    assert.deepEqual(replay, fixture.adapters.reconciliation.result);
    assert.equal(fixture.adapters.settlements, 1);
    fixture.store.close();
  });

  it("retries a write only after reconciliation proves it is safe", async () => {
    const fixture = createFixture();
    fixture.adapters.outcome = "unknown";
    const body = { action: "settle-round" };
    const request = {
      round: ROUND,
      creatorProof: await proof(creator, body, "settle-retry-safe"),
    };
    await assert.rejects(
      fixture.service.settleRound(request, AbortSignal.timeout(1_000)),
      /unknown/i,
    );
    fixture.adapters.reconciliation = { status: "retry-safe" };

    const summary = await fixture.service.reconcilePending(
      AbortSignal.timeout(1_000),
    );
    fixture.adapters.outcome = "confirmed";
    const result = await fixture.service.settleRound(
      request,
      AbortSignal.timeout(1_000),
    );

    assert.deepEqual(summary, { confirmed: 0, retrySafe: 1, unresolved: 0 });
    assert.equal(result.kind, "settlement");
    assert.equal(fixture.adapters.settlements, 2);
    fixture.store.close();
  });

  it("rejects a settlement result outside its pinned epoch identity", async () => {
    const fixture = createFixture();
    fixture.adapters.resultEpoch = 4n;
    const body = { action: "settle-round" };

    await assert.rejects(
      fixture.service.settleRound({
        round: ROUND,
        creatorProof: await proof(creator, body, "settle-race"),
      }, AbortSignal.timeout(1_000)),
      /epoch.*identity/i,
    );

    assert.equal(fixture.adapters.settlements, 1);
    fixture.store.close();
  });

  it("binds gas recovery to the creator and exact closed block", async () => {
    const fixture = createFixture();
    const body = {
      action: "recover-operator-gas",
      closedBlockHash: CLOSED_BLOCK_HASH,
    };
    const creatorProof = await proof(creator, body, "recover-1");

    await assert.rejects(
      fixture.service.recoverOperatorGas({
        round: ROUND,
        closedBlockHash: `0x${"aa".repeat(32)}`,
        creatorProof,
      }, AbortSignal.timeout(1_000)),
      /signature/i,
    );
    assert.equal(fixture.adapters.recoveries, 0);

    const result = await fixture.service.recoverOperatorGas({
      round: ROUND,
      closedBlockHash: CLOSED_BLOCK_HASH,
      creatorProof,
    }, AbortSignal.timeout(1_000));
    assert.deepEqual(result, {
      kind: "operator-gas-recovery",
      transactionHash: TRANSACTION_HASH,
      recoveredValue: "90",
      retainedGas: "10",
    });
    fixture.store.close();
  });
});
