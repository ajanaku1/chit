/**
 * The queue mark on Neon, so a cold instance does not read the queue from the
 * start. Two tables: where the mark stands for each pool, and the final
 * charges that were never posted. Both hold only what the chain published;
 * the sealed depositor is stored sealed (see pool-reads.ts).
 *
 * Every write is one statement that is safe to repeat and only moves forward,
 * so two instances advancing at once meet at the database and agree. Expired
 * rows go in before the mark moves: a reader must never see a mark that is
 * past a charge whose row is not there yet.
 */
import type { PoolQueued } from "./chain-pool.js";
import type { ExpiredCharge, PoolReadCache, QueueMark } from "./pool-reads.js";
import type { StoreSql } from "./store-neon.js";
import type { Hex } from "./types.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fleet_pool_queue_mark (
     pool TEXT PRIMARY KEY,
     final_below BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS fleet_pool_queue_expired (
     pool TEXT NOT NULL,
     idx BIGINT NOT NULL,
     id TEXT NOT NULL,
     enc_depositor TEXT NOT NULL,
     amount TEXT NOT NULL,
     due_at BIGINT NOT NULL,
     queued_at BIGINT NOT NULL,
     PRIMARY KEY (pool, idx)
   )`,
];

/** BIGINT comes back as a string from Neon and as a bigint or number elsewhere. */
const big = (value: unknown): bigint => BigInt(String(value));

const chargeRow = (row: Record<string, unknown>): ExpiredCharge => {
  const entry: PoolQueued = {
    id: String(row["id"]) as Hex,
    encDepositor: String(row["enc_depositor"]) as Hex,
    amount: big(row["amount"]),
    dueAt: big(row["due_at"]),
    queuedAt: big(row["queued_at"]),
    posted: false, // by definition: only the unposted ones are kept
  };
  return { index: Number(big(row["idx"])), entry };
};

export const createNeonReadCache = (sql: StoreSql): PoolReadCache => {
  let ready: Promise<void> | undefined;
  const ensure = (): Promise<void> =>
    (ready ??= (async () => {
      for (const statement of SCHEMA) await sql.query(statement);
    })().catch((error: unknown) => {
      ready = undefined; // a failed start is tried again by the next caller
      throw error;
    }));

  return {
    async load(key): Promise<QueueMark | undefined> {
      await ensure();
      const [mark] = await sql.query("SELECT final_below FROM fleet_pool_queue_mark WHERE pool = $1", [key]);
      if (!mark) return undefined;
      const rows = await sql.query(
        "SELECT idx, id, enc_depositor, amount, due_at, queued_at FROM fleet_pool_queue_expired WHERE pool = $1 ORDER BY idx",
        [key],
      );
      return { cursor: Number(big(mark["final_below"])), expired: rows.map(chargeRow) };
    },

    async advance(key, cursor, expired) {
      await ensure();
      for (const { index, entry } of expired) {
        await sql.query(
          `INSERT INTO fleet_pool_queue_expired (pool, idx, id, enc_depositor, amount, due_at, queued_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (pool, idx) DO NOTHING`,
          [key, index, entry.id, entry.encDepositor, entry.amount.toString(), entry.dueAt.toString(), entry.queuedAt.toString()],
        );
      }
      await sql.query(
        `INSERT INTO fleet_pool_queue_mark (pool, final_below) VALUES ($1, $2)
         ON CONFLICT (pool) DO UPDATE SET final_below = GREATEST(fleet_pool_queue_mark.final_below, EXCLUDED.final_below)`,
        [key, cursor],
      );
    },
  };
};
