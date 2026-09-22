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

/**
 * Rows a signed transaction was to settle, by that transaction: its hash was
 * recorded before the broadcast and its fate has not been seen. The next
 * sweep resolves each by the hash, never by an exception.
 */
export type SentBatch = { txHash: Hex; nonce: number; ids: string[]; kind: SentKind };

/** What the transaction was: a queue batch (mined means the rows are the chain's) or a withdrawal payout (mined means the charge stands, to be queued later; anything else voids it). */
export type SentKind = "batch" | "payout";

/** Where a resolved `sent` row goes: the chain's (confirmed), the next batch's (owed), or nobody's (void: a charge for a payout that never happened). */
export type SentResolution = "confirmed" | "owed" | "void";

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
  /**
   * The leased rows are `sent`: this hash, signed with this nonce, carries them.
   * Written before the broadcast (the adapter's `record`), so a process that
   * dies next leaves rows with a name to resolve, not rows to queue again.
   */
  markSent(ids: readonly string[], txHash: Hex, nonce: number, kind: SentKind): Promise<void>;
  /** Every batch still `sent`, oldest nonce first, for the sweep to resolve. */
  sentBatches(): Promise<SentBatch[]>;
  /** What the hash came to. `sent --exception--> owed` is the transition that does not exist. */
  resolveSent(ids: readonly string[], to: SentResolution): Promise<void>;
  /**
   * The campaign failure counter (specs/003-mainnet-beta/data-model.md,
   * T069): buys that spent gas without completing, by campaign, and the
   * time until which the campaign takes no buys once three fell inside an
   * hour. Held here so a second instance counts the same failures. A refusal
   * that spent nothing is never recorded.
   */
  failures: {
    /** Records one gas-spending failure at `at`; returns the moment the campaign reopens when this was the third inside the window, else undefined. */
    record(campaign: string, at: number): Promise<number | undefined>;
    /** When the campaign accepts buys again, or undefined when it does now. */
    closedUntil(campaign: string, now: number): Promise<number | undefined>;
  };
};

/** Three gas-spending failures inside an hour close a campaign for an hour (FR-0xx, the spec's clarification). */
export const FAILURE_LIMIT = 3;
export const FAILURE_WINDOW_MS = 60 * 60_000;
export const COOLDOWN_MS = 60 * 60_000;

/** Default lease on an operator lock: long enough for a five-account buy with receipts, short enough that a dead instance frees it. */
export const LOCK_TTL_MS = 120_000;

type OwedRow = OwedSpend & { leased: boolean; confirmed: boolean; voided: boolean; txHash?: Hex; nonce?: number; kind?: SentKind };

export const createMemoryStore = (): StorePort => {
  const results = new Map<string, IdempotencyRecord>();
  const slices = new Set<string>();
  const nonces = new Map<string, number>();
  const locks = new Map<string, Promise<unknown>>();
  const owed = new Map<string, OwedRow>();
  const failures = new Map<string, number[]>();
  const cooldowns = new Map<string, number>();

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
    async recordOwed(entry) { owed.set(entry.id, { ...entry, leased: false, confirmed: false, voided: false }); },
    async takeOwed(limit) {
      const rows = [...owed.values()].filter((r) => !r.leased && !r.confirmed && !r.voided && r.txHash === undefined).slice(0, limit);
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
        if (!row.confirmed && !row.voided && row.depositor.toLowerCase() === depositor.toLowerCase()) sum += BigInt(row.amount);
      }
      return sum.toString();
    },
    async markSent(ids, txHash, nonce, kind) {
      for (const id of ids) { const row = owed.get(id); if (row) { row.txHash = txHash; row.nonce = nonce; row.kind = kind; } }
    },
    async sentBatches() {
      const byHash = new Map<Hex, SentBatch>();
      for (const row of owed.values()) {
        if (row.txHash === undefined || row.confirmed || row.voided) continue;
        const batch = byHash.get(row.txHash) ?? { txHash: row.txHash, nonce: row.nonce ?? 0, ids: [], kind: row.kind ?? "batch" };
        batch.ids.push(row.id);
        byHash.set(row.txHash, batch);
      }
      return [...byHash.values()].sort((a, b) => a.nonce - b.nonce);
    },
    async resolveSent(ids, to) {
      for (const id of ids) {
        const row = owed.get(id);
        if (!row) continue;
        if (to === "confirmed") row.confirmed = true;
        else if (to === "void") row.voided = true;
        else { delete row.txHash; delete row.nonce; delete row.kind; row.leased = false; }
      }
    },
    failures: {
      async record(campaign, at) {
        const recent = (failures.get(campaign) ?? []).filter((t) => t > at - FAILURE_WINDOW_MS);
        recent.push(at);
        failures.set(campaign, recent);
        if (recent.length < FAILURE_LIMIT) return undefined;
        const until = at + COOLDOWN_MS;
        cooldowns.set(campaign, until);
        failures.set(campaign, []);
        return until;
      },
      async closedUntil(campaign, now) {
        const until = cooldowns.get(campaign);
        return until !== undefined && until > now ? until : undefined;
      },
    },
  };
};
