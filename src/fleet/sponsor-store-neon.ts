/**
 * The sponsor store on Neon (Postgres), for the hosted service.
 *
 * Same contract as MemorySponsorStore, over two tables. Money columns are
 * NUMERIC(78) so a wei amount never rounds; addresses and hashes are lower
 * case text. The schema is applied on first use, idempotently, the way the
 * enrollment repository does it.
 */

import type { SponsorPolicy } from "./sponsor-policy.js";
import type { SponsorRecord, SponsorStore, SponsoredOpRecord } from "./sponsor-store.js";
import type { Address, Hex, Uint } from "./types.js";

export interface SponsorSql {
  query(query: string, params?: unknown[]): Promise<readonly Record<string, unknown>[]>;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS fleet_sponsors (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    policy JSONB NOT NULL,
    paused BOOLEAN NOT NULL DEFAULT FALSE,
    closed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    register_tx TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS fleet_sponsors_owner ON fleet_sponsors (owner);
  CREATE TABLE IF NOT EXISTS fleet_sponsored_ops (
    key TEXT PRIMARY KEY,
    sponsor TEXT NOT NULL REFERENCES fleet_sponsors (id),
    user_hash TEXT NOT NULL,
    sender TEXT NOT NULL,
    target TEXT NOT NULL,
    selector TEXT,
    max_charged NUMERIC(78) NOT NULL,
    signed_at TIMESTAMPTZ NOT NULL,
    valid_until BIGINT NOT NULL,
    user_op_hash TEXT,
    tx_hash TEXT,
    success BOOLEAN,
    charged NUMERIC(78),
    landed_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS fleet_sponsored_ops_day ON fleet_sponsored_ops (sponsor, user_hash, signed_at);
`;

const text = (v: unknown): string => String(v);
const wei = (v: unknown): Uint => (v === null || v === undefined ? "0" : String(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

const toSponsor = (row: Record<string, unknown>): SponsorRecord => ({
  id: text(row["id"]) as Hex,
  owner: text(row["owner"]) as Address,
  policy: (typeof row["policy"] === "string" ? JSON.parse(row["policy"]) : row["policy"]) as SponsorPolicy,
  paused: Boolean(row["paused"]),
  closed: Boolean(row["closed"]),
  createdAt: iso(row["created_at"]),
  registerTx: text(row["register_tx"]) as Hex,
});

const toOp = (row: Record<string, unknown>): SponsoredOpRecord => {
  const op: SponsoredOpRecord = {
    key: text(row["key"]) as Hex,
    sponsor: text(row["sponsor"]) as Hex,
    userHash: text(row["user_hash"]) as Hex,
    sender: text(row["sender"]) as Address,
    target: text(row["target"]) as Address,
    selector: row["selector"] === null || row["selector"] === undefined ? null : (text(row["selector"]) as Hex),
    maxCharged: wei(row["max_charged"]),
    signedAt: iso(row["signed_at"]),
    validUntil: Number(row["valid_until"]),
  };
  if (row["user_op_hash"]) op.userOpHash = text(row["user_op_hash"]) as Hex;
  if (row["tx_hash"]) op.txHash = text(row["tx_hash"]) as Hex;
  if (row["success"] !== null && row["success"] !== undefined) op.success = Boolean(row["success"]);
  if (row["charged"] !== null && row["charged"] !== undefined) op.charged = wei(row["charged"]);
  if (row["landed_at"]) op.landedAt = iso(row["landed_at"]);
  return op;
};

export class NeonSponsorStore implements SponsorStore {
  readonly #sql: SponsorSql;
  #ready: Promise<void> | undefined;

  constructor(sql: SponsorSql) {
    this.#sql = sql;
  }

  #init(): Promise<void> {
    this.#ready ??= this.#sql.query(SCHEMA).then(() => undefined);
    return this.#ready;
  }

  async getSponsor(id: Hex): Promise<SponsorRecord | undefined> {
    await this.#init();
    const rows = await this.#sql.query("SELECT * FROM fleet_sponsors WHERE id = $1", [id]);
    return rows[0] ? toSponsor(rows[0]) : undefined;
  }

  async putSponsor(r: SponsorRecord): Promise<void> {
    await this.#init();
    await this.#sql.query(
      `INSERT INTO fleet_sponsors (id, owner, policy, paused, closed, created_at, register_tx)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET policy = EXCLUDED.policy, paused = EXCLUDED.paused, closed = EXCLUDED.closed`,
      [r.id, r.owner, JSON.stringify(r.policy), r.paused, r.closed, r.createdAt, r.registerTx],
    );
  }

  async listSponsors(owner: Address): Promise<SponsorRecord[]> {
    await this.#init();
    const rows = await this.#sql.query("SELECT * FROM fleet_sponsors WHERE owner = $1 ORDER BY created_at DESC", [owner]);
    return rows.map(toSponsor);
  }

  async spentOn(sponsor: Hex, day: string, userHash?: Hex): Promise<bigint> {
    await this.#init();
    // A day is the UTC day of the landing when there is one, of the signing otherwise.
    const rows = await this.#sql.query(
      `SELECT COALESCE(SUM(COALESCE(charged, max_charged)), 0) AS total
       FROM fleet_sponsored_ops
       WHERE sponsor = $1
         AND ($2::text IS NULL OR user_hash = $2)
         AND (success IS DISTINCT FROM FALSE)
         AND to_char(COALESCE(landed_at, signed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $3`,
      [sponsor, userHash ?? null, day],
    );
    return BigInt(wei(rows[0]?.["total"]).split(".")[0] ?? "0");
  }

  async addOp(op: SponsoredOpRecord): Promise<void> {
    await this.#init();
    await this.#sql.query(
      `INSERT INTO fleet_sponsored_ops (key, sponsor, user_hash, sender, target, selector, max_charged, signed_at, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [op.key, op.sponsor, op.userHash, op.sender, op.target, op.selector, op.maxCharged, op.signedAt, op.validUntil],
    );
  }

  async getOp(key: Hex): Promise<SponsoredOpRecord | undefined> {
    await this.#init();
    const rows = await this.#sql.query("SELECT * FROM fleet_sponsored_ops WHERE key = $1", [key]);
    return rows[0] ? toOp(rows[0]) : undefined;
  }

  async updateOp(key: Hex, patch: Partial<SponsoredOpRecord>): Promise<void> {
    await this.#init();
    await this.#sql.query(
      `UPDATE fleet_sponsored_ops SET
         user_op_hash = COALESCE($2, user_op_hash),
         tx_hash = COALESCE($3, tx_hash),
         success = COALESCE($4, success),
         charged = COALESCE($5, charged),
         landed_at = COALESCE($6, landed_at)
       WHERE key = $1`,
      [key, patch.userOpHash ?? null, patch.txHash ?? null, patch.success ?? null, patch.charged ?? null, patch.landedAt ?? null],
    );
  }

  async listOps(sponsor: Hex, limit: number): Promise<SponsoredOpRecord[]> {
    await this.#init();
    const rows = await this.#sql.query(
      "SELECT * FROM fleet_sponsored_ops WHERE sponsor = $1 ORDER BY signed_at DESC LIMIT $2",
      [sponsor, limit],
    );
    return rows.map(toOp);
  }

  async staleKeys(sponsor: Hex, nowSeconds: number): Promise<Hex[]> {
    await this.#init();
    const rows = await this.#sql.query(
      "SELECT key FROM fleet_sponsored_ops WHERE sponsor = $1 AND landed_at IS NULL AND valid_until < $2",
      [sponsor, nowSeconds],
    );
    return rows.map((r) => text(r["key"]) as Hex);
  }
}
