/**
 * The shared store on Neon: the adapter every instance on chit.tools talks to.
 *
 * Every guard is one statement, so two instances racing meet at the database
 * and exactly one wins: a claim is an INSERT that returns nothing on conflict;
 * the lock is a lease row that a later INSERT ... ON CONFLICT may take only
 * once the previous lease has expired, so a dead holder frees it by waiting.
 * The port and its contract are in store.ts.
 */
import { randomUUID } from "node:crypto";

import { LOCK_TTL_MS, type IdempotencyRecord, type OwedSpend, type SentBatch, type StorePort } from "./store.js";
import type { Address, Hex, Uint } from "./types.js";

/** What `neon(url)` provides; typed here so tests can hand in a fake. */
export type StoreSql = {
  query(query: string, params?: unknown[]): Promise<readonly Record<string, unknown>[]>;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fleet_idempotency (
     key TEXT PRIMARY KEY,
     payload_hash TEXT NOT NULL,
     result JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS fleet_slices (
     key TEXT PRIMARY KEY,
     claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS fleet_nonces (
     nonce TEXT PRIMARY KEY,
     expires_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS fleet_locks (
     name TEXT PRIMARY KEY,
     holder TEXT NOT NULL,
     expires_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS fleet_owed_spend (
     id TEXT PRIMARY KEY,
     depositor TEXT NOT NULL,
     amount TEXT NOT NULL,
     incurred_at TIMESTAMPTZ NOT NULL,
     leased_until BIGINT NOT NULL DEFAULT 0,
     queued_tx TEXT
   )`,
  // The sent state (specs/003-mainnet-beta/data-model.md): the hash and nonce a row
  // was signed under, written before the broadcast; voided is a charge for a
  // payout that provably never happened. Additive, so a store from before reads on.
  `ALTER TABLE fleet_owed_spend ADD COLUMN IF NOT EXISTS tx_hash TEXT`,
  `ALTER TABLE fleet_owed_spend ADD COLUMN IF NOT EXISTS nonce BIGINT`,
  `ALTER TABLE fleet_owed_spend ADD COLUMN IF NOT EXISTS voided BOOLEAN NOT NULL DEFAULT FALSE`,
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const owedRow = (row: Record<string, unknown>): OwedSpend => ({
  id: String(row["id"]),
  depositor: String(row["depositor"]) as Address,
  amount: String(row["amount"]),
  incurredAt: row["incurred_at"] instanceof Date ? row["incurred_at"].toISOString() : String(row["incurred_at"]),
});

export const createNeonStore = (
  sql: StoreSql,
  options: { ttlMs?: number; pollMs?: number; now?: () => number } = {},
): StorePort => {
  const ttlMs = options.ttlMs ?? LOCK_TTL_MS;
  const pollMs = options.pollMs ?? 200;
  const now = options.now ?? (() => Date.now());

  return {
    async initialize() {
      for (const statement of SCHEMA) await sql.query(statement);
    },
    idempotency: {
      async get(key): Promise<IdempotencyRecord | undefined> {
        const [row] = await sql.query("SELECT payload_hash, result FROM fleet_idempotency WHERE key = $1", [key]);
        return row ? { payloadHash: String(row["payload_hash"]) as Hex, result: row["result"] } : undefined;
      },
      async put(key, record) {
        await sql.query(
          "INSERT INTO fleet_idempotency (key, payload_hash, result) VALUES ($1, $2, $3::jsonb) ON CONFLICT (key) DO NOTHING",
          [key, record.payloadHash, JSON.stringify(record.result)],
        );
      },
    },
    async claimSlice(key) {
      const rows = await sql.query("INSERT INTO fleet_slices (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key", [key]);
      return rows.length === 1;
    },
    async releaseSlice(key) {
      await sql.query("DELETE FROM fleet_slices WHERE key = $1", [key]);
    },
    async burnNonce(nonce, expiresAt, at) {
      await sql.query("DELETE FROM fleet_nonces WHERE expires_at <= $1", [at]);
      const rows = await sql.query(
        "INSERT INTO fleet_nonces (nonce, expires_at) VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING RETURNING nonce",
        [nonce, expiresAt],
      );
      return rows.length === 1;
    },
    async withLock(name, work) {
      const holder = randomUUID();
      const deadline = now() + ttlMs;
      for (;;) {
        const at = now();
        const rows = await sql.query(
          `INSERT INTO fleet_locks (name, holder, expires_at) VALUES ($1, $2, $3)
           ON CONFLICT (name) DO UPDATE SET holder = $2, expires_at = $3
           WHERE fleet_locks.expires_at < $4
           RETURNING holder`,
          [name, holder, at + ttlMs, at],
        );
        if (rows.length === 1) break;
        if (now() >= deadline) throw new Error(`lock_timeout:${name}`);
        await sleep(pollMs);
      }
      try {
        return await work();
      } finally {
        await sql.query("DELETE FROM fleet_locks WHERE name = $1 AND holder = $2", [name, holder]);
      }
    },
    async recordOwed(entry) {
      await sql.query(
        "INSERT INTO fleet_owed_spend (id, depositor, amount, incurred_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
        [entry.id, entry.depositor.toLowerCase(), entry.amount, entry.incurredAt],
      );
    },
    async takeOwed(limit) {
      const at = now();
      const rows = await sql.query(
        `UPDATE fleet_owed_spend SET leased_until = $1
         WHERE id IN (
           SELECT id FROM fleet_owed_spend
           WHERE queued_tx IS NULL AND tx_hash IS NULL AND NOT voided AND leased_until < $2
           ORDER BY incurred_at LIMIT $3
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, depositor, amount, incurred_at`,
        [at + ttlMs, at, limit],
      );
      return rows.map(owedRow);
    },
    async confirmOwed(ids, txHash) {
      if (ids.length === 0) return;
      await sql.query("UPDATE fleet_owed_spend SET queued_tx = $1 WHERE id = ANY($2::text[])", [txHash, [...ids]]);
    },
    async releaseOwed(ids) {
      if (ids.length === 0) return;
      await sql.query("UPDATE fleet_owed_spend SET leased_until = 0 WHERE id = ANY($1::text[])", [[...ids]]);
    },
    async owedFor(depositor): Promise<Uint> {
      const [row] = await sql.query(
        "SELECT COALESCE(SUM(amount::numeric), 0)::text AS owed FROM fleet_owed_spend WHERE depositor = $1 AND queued_tx IS NULL AND NOT voided",
        [depositor.toLowerCase()],
      );
      return String(row?.["owed"] ?? "0");
    },
    async markSent(ids, txHash, nonce) {
      if (ids.length === 0) return;
      await sql.query("UPDATE fleet_owed_spend SET tx_hash = $1, nonce = $2 WHERE id = ANY($3::text[])", [txHash, nonce, [...ids]]);
    },
    async sentBatches(): Promise<SentBatch[]> {
      const rows = await sql.query(
        `SELECT tx_hash, nonce, array_agg(id ORDER BY id) AS ids FROM fleet_owed_spend
         WHERE tx_hash IS NOT NULL AND queued_tx IS NULL AND NOT voided
         GROUP BY tx_hash, nonce ORDER BY nonce`,
      );
      return rows.map((row) => ({ txHash: String(row["tx_hash"]) as Hex, nonce: Number(row["nonce"]), ids: (row["ids"] as string[]).map(String) }));
    },
    async resolveSent(ids, to) {
      if (ids.length === 0) return;
      const set = to === "confirmed" ? "queued_tx = tx_hash" : to === "void" ? "voided = TRUE" : "tx_hash = NULL, nonce = NULL, leased_until = 0";
      await sql.query(`UPDATE fleet_owed_spend SET ${set} WHERE id = ANY($1::text[])`, [[...ids]]);
    },
  };
};
