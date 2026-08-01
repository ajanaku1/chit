import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { PolicyStore } from "../src/policy-store.js";

const ROUND = `0x${"11".repeat(32)}`;
const SPONSOR_A = `0x${"22".repeat(20)}`;
const SPONSOR_B = `0x${"33".repeat(20)}`;
const OWNER = `0x${"44".repeat(20)}`;
const ACCOUNT = `0x${"55".repeat(20)}`;
const REGISTRATION_A = `0x${"66".repeat(32)}`;
const REGISTRATION_B = `0x${"77".repeat(32)}`;
const KEY = Buffer.alloc(32, 7);
const temporaryDirectories: string[] = [];

function createStore(key: Uint8Array = KEY) {
  const directory = mkdtempSync(join(tmpdir(), "chit-policy-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "policy.sqlite");
  return { path, store: new PolicyStore({ path, encryptionKey: key }) };
}

function registerSponsor(
  store: PolicyStore,
  sponsor = SPONSOR_A,
  slot = 0,
  registrationTx = REGISTRATION_A,
  declaredBudget = 100n,
): void {
  store.registerSponsor({
    round: ROUND,
    sponsor,
    slot,
    registrationTx,
    declaredBudget,
    confirmedFunding: declaredBudget,
  });
}

function registerAccount(
  store: PolicyStore,
  sponsor = SPONSOR_A,
  slot = 0,
): void {
  store.registerInvite({
    round: ROUND,
    sponsor,
    slot,
    owner: OWNER,
    account: ACCOUNT,
    inviteNonce: "invite-1",
    expiresAt: 2_000_000_000,
    action: "counter.increment",
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("encrypted policy records", () => {
  it("encrypts the private graph and budget at rest with authenticated context", () => {
    const { path, store } = createStore();
    registerSponsor(store);
    registerAccount(store);

    const database = new DatabaseSync(path, { readOnly: true });
    const sponsorRow = database
      .prepare("SELECT policy FROM sponsors WHERE round = ? AND sponsor = ?")
      .get(ROUND, SPONSOR_A) as { policy: Uint8Array } | undefined;
    const accountRow = database
      .prepare("SELECT policy FROM accounts WHERE round = ? AND account = ?")
      .get(ROUND, ACCOUNT) as { policy: Uint8Array } | undefined;
    database.close();

    assert.ok(sponsorRow);
    assert.ok(accountRow);
    const sponsorCiphertext = Buffer.from(sponsorRow.policy).toString("utf8");
    const accountCiphertext = Buffer.from(accountRow.policy).toString("utf8");
    assert.equal(sponsorCiphertext.includes("100"), false);
    assert.equal(accountCiphertext.includes(SPONSOR_A), false);
    assert.equal(accountCiphertext.includes(OWNER), false);
    assert.deepEqual(store.readSponsorPolicy(ROUND, SPONSOR_A), {
      declaredBudget: 100n,
      claimed: 0n,
      reserved: 0n,
      slot: 0,
    });
    store.close();

    const wrongKey = new PolicyStore({
      path,
      encryptionKey: Buffer.alloc(32, 8),
    });
    assert.throws(
      () => wrongKey.readSponsorPolicy(ROUND, SPONSOR_A),
      /authenticate|decrypt/i,
    );
    wrongKey.close();
  });

  it("rejects a declaration above confirmed public funding", () => {
    const { store } = createStore();

    assert.throws(
      () =>
        store.registerSponsor({
          round: ROUND,
          sponsor: SPONSOR_A,
          slot: 0,
          registrationTx: REGISTRATION_A,
          declaredBudget: 101n,
          confirmedFunding: 100n,
        }),
      /confirmed funding/i,
    );
    assert.throws(
      () =>
        store.registerSponsor({
          round: ROUND,
          sponsor: SPONSOR_A,
          slot: 0,
          registrationTx: REGISTRATION_A,
          declaredBudget: -1n,
          confirmedFunding: 100n,
        }),
      /positive/i,
    );
    store.close();
  });

  it("rejects an encrypted record whose ciphertext was corrupted", () => {
    const { path, store } = createStore();
    registerSponsor(store);
    store.close();
    const database = new DatabaseSync(path);
    const row = database
      .prepare("SELECT policy FROM sponsors WHERE round = ? AND sponsor = ?")
      .get(ROUND, SPONSOR_A) as { policy: Uint8Array };
    const corrupted = Buffer.from(row.policy);
    corrupted[corrupted.length - 1] ^= 1;
    database
      .prepare("UPDATE sponsors SET policy = ? WHERE round = ? AND sponsor = ?")
      .run(corrupted, ROUND, SPONSOR_A);
    database.close();

    const reopened = new PolicyStore({ path, encryptionKey: KEY });
    assert.throws(
      () => reopened.readSponsorPolicy(ROUND, SPONSOR_A),
      /authenticate|decrypt/i,
    );
    reopened.close();
  });

  it("prevents one round account from being reassigned to another sponsor", () => {
    const { store } = createStore();
    registerSponsor(store);
    registerSponsor(store, SPONSOR_B, 1, REGISTRATION_B);
    registerAccount(store);

    assert.throws(() => registerAccount(store, SPONSOR_B, 1), /already assigned/i);
    store.close();
  });
});

describe("atomic policy reservations", () => {
  it("makes an operation key idempotent without reserving allowance twice", () => {
    const { store } = createStore();
    registerSponsor(store);
    registerAccount(store);
    const request = {
      operationKey: `0x${"88".repeat(32)}`,
      round: ROUND,
      account: ACCOUNT,
      maximumCost: 70n,
      expiresAt: 2_000_000_000,
      preparedFingerprint: "prepared-88",
    };

    assert.deepEqual(store.reserve(request), store.reserve(request));
    assert.throws(
      () =>
        store.reserve({
          ...request,
          operationKey: `0x${"87".repeat(32)}`,
          maximumCost: -1n,
        }),
      /positive/i,
    );
    assert.equal(store.availableAllowance(ROUND, SPONSOR_A), 30n);
    assert.throws(
      () => store.reserve({ ...request, maximumCost: 71n }),
      /operation key/i,
    );
    assert.throws(
      () =>
        store.reserve({
          ...request,
          operationKey: `0x${"99".repeat(32)}`,
          maximumCost: 31n,
        }),
      /allowance/i,
    );
    store.close();
  });

  it("allows only one of two concurrent reservations to consume the same allowance", async () => {
    const { store } = createStore();
    registerSponsor(store);
    registerAccount(store);
    const reserve = (operationKey: string) =>
      Promise.resolve().then(() =>
        store.reserve({
          operationKey,
          round: ROUND,
          account: ACCOUNT,
          maximumCost: 60n,
          expiresAt: 2_000_000_000,
          preparedFingerprint: operationKey,
        }),
      );

    const results = await Promise.allSettled([
      reserve(`0x${"aa".repeat(32)}`),
      reserve(`0x${"bb".repeat(32)}`),
    ]);

    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    assert.equal(store.availableAllowance(ROUND, SPONSOR_A), 40n);
    store.close();
  });

  it("retains unknown outcomes, releases known failures, and records actual claims", () => {
    const { store } = createStore();
    registerSponsor(store);
    registerAccount(store);
    const operationKey = `0x${"cc".repeat(32)}`;
    store.reserve({
      operationKey,
      round: ROUND,
      account: ACCOUNT,
      maximumCost: 80n,
      expiresAt: 2_000_000_000,
      preparedFingerprint: "prepared-cc",
    });

    store.markUnknown(operationKey);
    assert.equal(store.availableAllowance(ROUND, SPONSOR_A), 20n);
    assert.equal(store.isSettlementReady(ROUND), false);
    store.releaseKnownFailure(operationKey);
    assert.equal(store.availableAllowance(ROUND, SPONSOR_A), 100n);
    assert.equal(store.isSettlementReady(ROUND), true);

    const confirmedKey = `0x${"dd".repeat(32)}`;
    store.reserve({
      operationKey: confirmedKey,
      round: ROUND,
      account: ACCOUNT,
      maximumCost: 70n,
      expiresAt: 2_000_000_000,
      preparedFingerprint: "prepared-dd",
    });
    store.confirmClaim(confirmedKey, 40n);
    assert.equal(store.availableAllowance(ROUND, SPONSOR_A), 60n);
    assert.equal(store.isSettlementReady(ROUND), true);
    store.close();
  });

  it("releases expiry only after reconciliation proves the operation did not land", () => {
    const { store } = createStore();
    registerSponsor(store);
    registerAccount(store);
    const operationKey = `0x${"ee".repeat(32)}`;
    store.reserve({
      operationKey,
      round: ROUND,
      account: ACCOUNT,
      maximumCost: 50n,
      expiresAt: 1,
      preparedFingerprint: "prepared-ee",
    });

    assert.throws(
      () => store.releaseExpired(operationKey, true),
      /landed|reconcile/i,
    );
    assert.equal(store.availableAllowance(ROUND, SPONSOR_A), 50n);
    store.releaseExpired(operationKey, false);
    assert.equal(store.availableAllowance(ROUND, SPONSOR_A), 100n);
    store.close();
  });
});
