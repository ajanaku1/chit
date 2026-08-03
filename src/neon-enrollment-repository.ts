import { getAddress, isHex, size, type Hex } from "viem";
import {
  type BeginEnrollment,
  type EnrollmentChallengeRecord,
  type EnrollmentIdentity,
  type EnrollmentRepository,
  type EnrollmentState,
} from "./hosted-enrollment.js";

interface EnrollmentSql {
  query(
    query: string,
    params?: unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS hosted_enrollments (
    nonce TEXT PRIMARY KEY,
    round TEXT NOT NULL,
    owner TEXT NOT NULL,
    account TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ready', 'pending', 'failed', 'confirmed')),
    transaction_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (round, owner, account)
  );
`;

function stateValue(value: unknown): EnrollmentState {
  switch (value) {
    case "ready":
    case "pending":
    case "failed":
    case "confirmed":
      return value;
    default:
      throw new Error("Enrollment state is invalid");
  }
}

function textValue(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Enrollment ${field} is invalid`);
  }
  return value;
}

function transactionHash(value: unknown): Hex | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || !isHex(value) || size(value) !== 32) {
    throw new Error("Enrollment transaction hash is invalid");
  }
  return value;
}

function enrollmentRecord(row: Record<string, unknown>): EnrollmentChallengeRecord {
  const expiresAt = Number(row.expires_at);
  if (!Number.isSafeInteger(expiresAt)) throw new Error("Enrollment expiry is invalid");
  const hash = transactionHash(row.transaction_hash);
  return {
    round: textValue(row, "round"),
    owner: getAddress(textValue(row, "owner")),
    account: getAddress(textValue(row, "account")),
    nonce: textValue(row, "nonce"),
    expiresAt,
    state: stateValue(row.state),
    ...(hash === undefined ? {} : { transactionHash: hash }),
  };
}

export class NeonEnrollmentRepository implements EnrollmentRepository {
  constructor(private readonly sql: EnrollmentSql) {}

  async initialize(): Promise<void> {
    await this.sql.query(SCHEMA);
  }

  async create(record: EnrollmentChallengeRecord): Promise<void> {
    await this.sql.query(
      `INSERT INTO hosted_enrollments
       (nonce, round, owner, account, expires_at, state)
       VALUES ($1, $2, $3, $4, $5, 'ready')
       ON CONFLICT (round, owner, account) DO UPDATE SET
         nonce = EXCLUDED.nonce,
         expires_at = EXCLUDED.expires_at,
         state = 'ready',
         transaction_hash = NULL,
         updated_at = NOW()`,
      [record.nonce, record.round.toLowerCase(), record.owner.toLowerCase(),
        record.account.toLowerCase(), record.expiresAt],
    );
  }

  async begin(identity: EnrollmentIdentity): Promise<BeginEnrollment | undefined> {
    const rows = await this.sql.query(
      `WITH started AS (
         UPDATE hosted_enrollments SET state = 'pending', updated_at = NOW()
         WHERE nonce = $1 AND round = $2 AND owner = $3 AND account = $4
           AND expires_at = $5 AND expires_at >= $6 AND state IN ('ready', 'failed')
         RETURNING *, TRUE AS started
       )
       SELECT * FROM started
       UNION ALL
       SELECT *, FALSE AS started FROM hosted_enrollments
       WHERE nonce = $1 AND round = $2 AND owner = $3 AND account = $4
         AND expires_at = $5 AND NOT EXISTS (SELECT 1 FROM started)
       LIMIT 1`,
      [identity.nonce, identity.round.toLowerCase(), identity.owner.toLowerCase(),
        identity.account.toLowerCase(), identity.expiresAt, Math.floor(Date.now() / 1_000)],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return { started: row.started === true, record: enrollmentRecord(row) };
  }

  async complete(nonce: string, hash: Hex): Promise<void> {
    const rows = await this.sql.query(
      `UPDATE hosted_enrollments
       SET state = 'confirmed', transaction_hash = $2, updated_at = NOW()
       WHERE nonce = $1 AND state = 'pending' RETURNING nonce`,
      [nonce, hash.toLowerCase()],
    );
    if (rows.length !== 1) throw new Error("Pending enrollment was not found");
  }

  async fail(nonce: string): Promise<void> {
    await this.sql.query(
      `UPDATE hosted_enrollments SET state = 'failed', updated_at = NOW()
       WHERE nonce = $1 AND state = 'pending'`,
      [nonce],
    );
  }
}
