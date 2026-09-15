/**
 * The shared store: state the service must agree on across instances.
 *
 * Vercel runs the fleet API as many short-lived instances. Until now every
 * guard that stops the operator paying twice lived in one instance's memory:
 * the idempotency results, the executed-slice set, the challenge-nonce burn,
 * and the per-wallet serialization of money operations. A retry that landed
 * on a second instance saw none of it. This port moves that state behind one
 * interface. The memory adapter is the previous behaviour and the default
 * when DATABASE_URL is absent; the Neon adapter (store-neon.ts) is the shared
 * one. Both meet the contract in test/fleet/store.test.ts.
 *
 * Owed spend is here too, ahead of its use: the charge a buy incurs will be
 * recorded, not queued, and a sweep will queue a shuffled batch later, so no
 * depositor-keyed transaction follows a campaign-keyed one (PROGRESS: phase 2).
 */
import type { Address, Hex, Uint } from "./types.js";

export type IdempotencyRecord = { payloadHash: Hex; result: unknown };

export type OwedSpend = { id: string; depositor: Address; amount: Uint; incurredAt: string };

export type StorePort = {
  /** Creates what the adapter needs; idempotent. */
  initialize(): Promise<void>;
  idempotency: {
    get(key: string): Promise<IdempotencyRecord | undefined>;
    put(key: string, record: IdempotencyRecord): Promise<void>;
  };
  /** True for the first claimant of `key` and for nobody else until release. */
  claimSlice(key: string): Promise<boolean>;
  releaseSlice(key: string): Promise<void>;
  /**
   * True the first time `nonce` is presented before `expiresAt`; false after.
   * `now` is passed in so the caller's clock is the only clock.
   */
  burnNonce(nonce: string, expiresAt: number, now: number): Promise<boolean>;
  /** Runs `work` while holding the named lock; waiters run in arrival order. */
  withLock<T>(name: string, work: () => Promise<T>): Promise<T>;
  recordOwed(entry: OwedSpend): Promise<void>;
  /** Leases up to `limit` unqueued rows to this caller; a leased row is not offered again until released. */
  takeOwed(limit: number): Promise<OwedSpend[]>;
  /** The leased rows made it into a queue transaction; they are the chain's now. */
  confirmOwed(ids: readonly string[], txHash: Hex): Promise<void>;
  /** The batch did not land; the rows go back to the next sweep. */
  releaseOwed(ids: readonly string[]): Promise<void>;
  /** Recorded and not yet confirmed, so the balance can subtract it before the chain knows. */
  owedFor(depositor: Address): Promise<Uint>;
};

/** Default lease on an operator lock: long enough for a five-account buy with receipts, short enough that a dead instance frees it. */
export const LOCK_TTL_MS = 120_000;

type OwedRow = OwedSpend & { leased: boolean; confirmed: boolean };

export const createMemoryStore = (): StorePort => {
  const results = new Map<string, IdempotencyRecord>();
  const slices = new Set<string>();
  const nonces = new Map<string, number>();
  const locks = new Map<string, Promise<unknown>>();
  const owed = new Map<string, OwedRow>();

  const pruneNonces = (now: number): void => {
    for (const [nonce, expiresAt] of nonces) if (expiresAt <= now) nonces.delete(nonce);
  };

  return {
    async initialize() {},
    idempotency: {
      async get(key) { return results.get(key); },
      async put(key, record) { results.set(key, record); },
    },
    async claimSlice(key) {
      if (slices.has(key)) return false;
      slices.add(key);
      return true;
    },
    async releaseSlice(key) { slices.delete(key); },
    async burnNonce(nonce, expiresAt, now) {
      pruneNonces(now);
      if (nonces.has(nonce)) return false;
      nonces.set(nonce, expiresAt);
      return true;
    },
    // The same shape CampaignRouter#serialized had: chain onto the previous
    // holder's settlement, whether it resolved or threw.
    async withLock(name, work) {
      const previous = locks.get(name) ?? Promise.resolve();
      const run = previous.then(work, work);
      const settled = run.then(() => undefined, () => undefined);
      locks.set(name, settled);
      try {
        return await run;
      } finally {
        if (locks.get(name) === settled) locks.delete(name);
      }
    },
    async recordOwed(entry) { owed.set(entry.id, { ...entry, leased: false, confirmed: false }); },
    async takeOwed(limit) {
      const rows = [...owed.values()].filter((r) => !r.leased && !r.confirmed).slice(0, limit);
      for (const row of rows) row.leased = true;
      return rows.map(({ id, depositor, amount, incurredAt }) => ({ id, depositor, amount, incurredAt }));
    },
    async confirmOwed(ids) {
      for (const id of ids) { const row = owed.get(id); if (row) row.confirmed = true; }
    },
    async releaseOwed(ids) {
      for (const id of ids) { const row = owed.get(id); if (row) row.leased = false; }
    },
    async owedFor(depositor) {
      let sum = 0n;
      for (const row of owed.values()) {
        if (!row.confirmed && row.depositor.toLowerCase() === depositor.toLowerCase()) sum += BigInt(row.amount);
      }
      return sum.toString();
    },
  };
};
