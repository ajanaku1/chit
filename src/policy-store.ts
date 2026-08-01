import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { type Hex } from "viem";
import {
  type LifecycleActionRecord,
  type LifecycleActionState,
  type LifecycleResult,
} from "./lifecycle-types.js";

interface PolicyStoreOptions {
  readonly path: string;
  readonly encryptionKey: Uint8Array;
}

export interface SponsorRegistration {
  readonly round: string;
  readonly sponsor: string;
  readonly slot: number;
  readonly registrationTx: string;
  readonly declaredBudget: bigint;
  readonly confirmedFunding: bigint;
}

export interface InviteRegistration {
  readonly round: string;
  readonly sponsor: string;
  readonly slot: number;
  readonly owner: string;
  readonly account: string;
  readonly inviteNonce: string;
  readonly expiresAt: number;
  readonly action: string;
}

export interface ReservationRequest {
  readonly operationKey: string;
  readonly round: string;
  readonly account: string;
  readonly maximumCost: bigint;
  readonly expiresAt: number;
  readonly preparedFingerprint: string;
}

export interface RequestNonce {
  readonly scope: string;
  readonly round: string;
  readonly signer: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

export interface BeginLifecycleAction {
  readonly actionKey: string;
  readonly kind: LifecycleResult["kind"];
  readonly round: string;
  readonly requestHash: Hex;
  readonly authorization: RequestNonce;
}

export interface BegunLifecycleAction {
  readonly created: boolean;
  readonly record: LifecycleActionRecord;
}

export interface SponsorPolicy {
  readonly declaredBudget: bigint;
  readonly claimed: bigint;
  readonly reserved: bigint;
  readonly slot: number;
}

interface StoredSponsorPolicy {
  readonly declaredBudget: string;
  readonly claimed: string;
  readonly reserved: string;
  readonly slot: number;
}

interface StoredAccountPolicy {
  readonly sponsor: string;
  readonly slot: number;
  readonly owner: string;
  readonly inviteNonce: string;
  readonly expiresAt: number;
  readonly action: string;
}

interface StoredReservation {
  readonly round: string;
  readonly account: string;
  readonly maximumCost: string;
  readonly expiresAt: number;
  readonly preparedFingerprint: string;
}

interface PolicyRow {
  readonly policy: Uint8Array;
}

interface OperationRow extends PolicyRow {
  readonly status: ReservationState;
}

interface LifecycleActionRow {
  readonly action_key: string;
  readonly kind: LifecycleResult["kind"];
  readonly round: string;
  readonly status: LifecycleActionState;
  readonly request_hash: Hex;
  readonly request_scope: string;
  readonly signer: string;
  readonly nonce: string;
  readonly transaction_hash: Hex | null;
  readonly result: string | null;
}

type ReservationState = "reserved" | "unknown" | "failed" | "confirmed";

export interface Reservation {
  readonly operationKey: string;
  readonly state: ReservationState;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const RECORD_VERSION = 1;
const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sponsors (
    round TEXT NOT NULL,
    sponsor TEXT NOT NULL,
    registration_tx TEXT NOT NULL,
    policy BLOB NOT NULL,
    PRIMARY KEY (round, sponsor),
    UNIQUE (round, registration_tx)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS accounts (
    round TEXT NOT NULL,
    account TEXT NOT NULL,
    policy BLOB NOT NULL,
    PRIMARY KEY (round, account)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS operations (
    operation_key TEXT PRIMARY KEY,
    round TEXT NOT NULL,
    account TEXT NOT NULL,
    status TEXT NOT NULL,
    policy BLOB NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS operations_round_status
    ON operations (round, status);
  CREATE UNIQUE INDEX IF NOT EXISTS operations_account_pending
    ON operations (round, account)
    WHERE status IN ('reserved', 'unknown');
  CREATE TABLE IF NOT EXISTS request_nonces (
    scope TEXT NOT NULL,
    round TEXT NOT NULL,
    signer TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (scope, round, signer, nonce)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS lifecycle_actions (
    action_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    round TEXT NOT NULL,
    status TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    request_scope TEXT NOT NULL,
    signer TEXT NOT NULL,
    nonce TEXT NOT NULL,
    transaction_hash TEXT,
    result TEXT,
    UNIQUE (request_scope, round, signer, nonce)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS lifecycle_actions_round_status
    ON lifecycle_actions (round, status);
`;

function canonical(value: string): string {
  return value.toLowerCase();
}

function sponsorAad(round: string, sponsor: string): string {
  return `sponsor:${round}:${sponsor}`;
}

function accountAad(round: string, account: string): string {
  return `account:${round}:${account}`;
}

function operationAad(operationKey: string): string {
  return `operation:${operationKey}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lifecycleResult(value: string): LifecycleResult {
  return JSON.parse(value) as LifecycleResult;
}

function lifecycleRecord(row: LifecycleActionRow): LifecycleActionRecord {
  return {
    actionKey: row.action_key,
    kind: row.kind,
    round: row.round,
    state: row.status,
    requestHash: row.request_hash,
    requestScope: row.request_scope,
    signer: row.signer,
    nonce: row.nonce,
    ...(row.transaction_hash === null
      ? {}
      : { transactionHash: row.transaction_hash }),
    ...(row.result === null ? {} : { result: lifecycleResult(row.result) }),
  };
}

export class PolicyStore {
  private readonly database: DatabaseSync;
  private readonly encryptionKey: Buffer;

  constructor(options: PolicyStoreOptions) {
    if (options.encryptionKey.byteLength !== 32) {
      throw new RangeError("Policy encryption key must be 32 bytes");
    }
    this.encryptionKey = Buffer.from(options.encryptionKey);
    this.database = new DatabaseSync(options.path);
    this.initializeSchema();
  }

  close(): void {
    this.database.close();
  }

  registerSponsor(input: SponsorRegistration): void {
    this.insertSponsor(input);
  }

  registerSponsorAuthorized(
    input: SponsorRegistration,
    nonces: readonly RequestNonce[],
  ): void {
    this.transaction(() => {
      for (const nonce of nonces) this.insertRequestNonce(nonce);
      this.insertSponsor(input);
    });
  }

  private insertSponsor(input: SponsorRegistration): void {
    if (input.declaredBudget <= 0n || input.confirmedFunding < 0n) {
      throw new Error("Sponsor budget and funding must be positive");
    }
    if (!Number.isSafeInteger(input.slot) || input.slot < 0) {
      throw new Error("Sponsor slot must be a non-negative integer");
    }
    if (input.declaredBudget > input.confirmedFunding) {
      throw new Error("Declared budget exceeds confirmed funding");
    }
    const round = canonical(input.round);
    const sponsor = canonical(input.sponsor);
    const policy = this.seal(sponsorAad(round, sponsor), {
      declaredBudget: input.declaredBudget.toString(),
      claimed: "0",
      reserved: "0",
      slot: input.slot,
    } satisfies StoredSponsorPolicy);
    this.database
      .prepare(
        "INSERT INTO sponsors (round, sponsor, registration_tx, policy) VALUES (?, ?, ?, ?)",
      )
      .run(round, sponsor, canonical(input.registrationTx), policy);
  }

  registerInvite(input: InviteRegistration): void {
    this.insertInvite(input);
  }

  registerInviteAuthorized(
    input: InviteRegistration,
    nonce: RequestNonce,
  ): void {
    this.transaction(() => {
      this.insertRequestNonce(nonce);
      this.insertInvite(input);
    });
  }

  private insertInvite(input: InviteRegistration): void {
    const round = canonical(input.round);
    const sponsor = canonical(input.sponsor);
    const sponsorPolicy = this.readSponsorPolicy(round, sponsor);
    if (sponsorPolicy.slot !== input.slot) {
      throw new Error("Invite slot does not match registered sponsor");
    }
    const account = canonical(input.account);
    const policy = this.seal(accountAad(round, account), {
      sponsor,
      slot: input.slot,
      owner: canonical(input.owner),
      inviteNonce: input.inviteNonce,
      expiresAt: input.expiresAt,
      action: input.action,
    } satisfies StoredAccountPolicy);
    try {
      this.database
        .prepare("INSERT INTO accounts (round, account, policy) VALUES (?, ?, ?)")
        .run(round, account, policy);
    } catch (error) {
      if (errorMessage(error).includes("UNIQUE constraint")) {
        throw new Error("Round account is already assigned", { cause: error });
      }
      throw error;
    }
  }

  readSponsorPolicy(roundValue: string, sponsorValue: string): SponsorPolicy {
    const round = canonical(roundValue);
    const sponsor = canonical(sponsorValue);
    const row = this.policyRow(
      "SELECT policy FROM sponsors WHERE round = ? AND sponsor = ?",
      round,
      sponsor,
    );
    const stored = this.open<StoredSponsorPolicy>(
      sponsorAad(round, sponsor),
      row.policy,
    );
    return {
      declaredBudget: BigInt(stored.declaredBudget),
      claimed: BigInt(stored.claimed),
      reserved: BigInt(stored.reserved),
      slot: stored.slot,
    };
  }

  availableAllowance(round: string, sponsor: string): bigint {
    const policy = this.readSponsorPolicy(round, sponsor);
    return policy.declaredBudget - policy.claimed - policy.reserved;
  }

  reserve(input: ReservationRequest): Reservation {
    return this.transaction(() => this.reserveWithinTransaction(input));
  }

  markUnknown(operationKeyValue: string): void {
    const operationKey = canonical(operationKeyValue);
    const result = this.database
      .prepare(
        "UPDATE operations SET status = 'unknown' WHERE operation_key = ? AND status = 'reserved'",
      )
      .run(operationKey);
    if (result.changes !== 1) throw new Error("Operation is not reserved");
  }

  releaseKnownFailure(operationKey: string): void {
    this.transaction(() => this.releaseReservation(operationKey, "failed"));
  }

  confirmClaim(operationKey: string, actualClaim: bigint): void {
    this.transaction(() => this.confirmWithinTransaction(operationKey, actualClaim));
  }

  releaseExpired(operationKey: string, landed: boolean): void {
    if (landed) {
      throw new Error("Landed operation requires claim reconciliation");
    }
    const reservation = this.readReservation(operationKey);
    if (reservation.expiresAt > Math.floor(Date.now() / 1_000)) {
      throw new Error("Operation reservation has not expired");
    }
    this.releaseKnownFailure(operationKey);
  }

  isSettlementReady(roundValue: string): boolean {
    const row = this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM operations WHERE round = ? AND status IN ('reserved', 'unknown')",
      )
      .get(canonical(roundValue)) as { count: number } | undefined;
    return row?.count === 0;
  }

  readPreparedFingerprint(operationKey: string): string {
    return this.readReservation(operationKey).preparedFingerprint;
  }

  reservationState(operationKeyValue: string): ReservationState {
    return this.requiredOperationRow(canonical(operationKeyValue)).status;
  }

  consumeRequestNonce(input: RequestNonce): void {
    this.insertRequestNonce(input);
  }

  beginLifecycleAction(input: BeginLifecycleAction): BegunLifecycleAction {
    return this.transaction(() => this.beginLifecycleWithinTransaction(input));
  }

  findLifecycleActionByNonce(
    authorization: RequestNonce,
  ): LifecycleActionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM lifecycle_actions
         WHERE request_scope = ? AND round = ? AND signer = ? AND nonce = ?`,
      )
      .get(
        authorization.scope,
        canonical(authorization.round),
        canonical(authorization.signer),
        authorization.nonce,
      ) as LifecycleActionRow | undefined;
    return row === undefined ? undefined : lifecycleRecord(row);
  }

  readLifecycleAction(actionKey: string): LifecycleActionRecord {
    return lifecycleRecord(this.requiredLifecycleRow(actionKey));
  }

  unresolvedLifecycleActions(round: string): readonly LifecycleActionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM lifecycle_actions
         WHERE round = ? AND status IN ('pending', 'unknown')
         ORDER BY action_key`,
      )
      .all(canonical(round)) as unknown as LifecycleActionRow[];
    return rows.map(lifecycleRecord);
  }

  markLifecycleUnknown(actionKey: string, transactionHash?: Hex): void {
    this.updateLifecycleState(actionKey, "unknown", transactionHash);
  }

  markLifecycleFailed(actionKey: string): void {
    this.updateLifecycleState(actionKey, "failed");
  }

  markLifecyclePending(actionKey: string): void {
    this.updateLifecycleState(actionKey, "pending");
  }

  confirmLifecycleAction(actionKey: string, result: LifecycleResult): void {
    const row = this.requiredLifecycleRow(actionKey);
    if (row.status === "confirmed") return;
    this.database
      .prepare(
        `UPDATE lifecycle_actions
         SET status = 'confirmed', result = ?
         WHERE action_key = ?`,
      )
      .run(JSON.stringify(result), canonical(actionKey));
  }

  private insertRequestNonce(input: RequestNonce): void {
    if (input.expiresAt < Math.floor(Date.now() / 1_000)) {
      throw new Error("Request nonce has expired");
    }
    try {
      this.database
        .prepare(
          "INSERT INTO request_nonces (scope, round, signer, nonce, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          input.scope,
          canonical(input.round),
          canonical(input.signer),
          input.nonce,
          input.expiresAt,
        );
    } catch (error) {
      if (errorMessage(error).includes("UNIQUE constraint")) {
        throw new Error("Request nonce has already been consumed", {
          cause: error,
        });
      }
      throw error;
    }
  }

  private beginLifecycleWithinTransaction(
    input: BeginLifecycleAction,
  ): BegunLifecycleAction {
    const existing = this.lifecycleRow(input.actionKey);
    if (existing !== undefined) {
      this.requireMatchingLifecycle(existing, input);
      return { created: false, record: lifecycleRecord(existing) };
    }
    this.insertRequestNonce(input.authorization);
    this.insertLifecycleAction(input);
    return {
      created: true,
      record: lifecycleRecord(this.requiredLifecycleRow(input.actionKey)),
    };
  }

  private insertLifecycleAction(input: BeginLifecycleAction): void {
    this.database
      .prepare(
        `INSERT INTO lifecycle_actions
         (action_key, kind, round, status, request_hash, request_scope, signer, nonce)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        canonical(input.actionKey),
        input.kind,
        canonical(input.round),
        input.requestHash.toLowerCase(),
        input.authorization.scope,
        canonical(input.authorization.signer),
        input.authorization.nonce,
      );
  }

  private requireMatchingLifecycle(
    row: LifecycleActionRow,
    input: BeginLifecycleAction,
  ): void {
    const authorization = input.authorization;
    const matches =
      row.kind === input.kind &&
      row.round === canonical(input.round) &&
      row.request_hash === input.requestHash.toLowerCase() &&
      row.request_scope === authorization.scope &&
      row.signer === canonical(authorization.signer) &&
      row.nonce === authorization.nonce;
    if (!matches) throw new Error("Lifecycle action belongs to another request");
  }

  private updateLifecycleState(
    actionKey: string,
    state: Exclude<LifecycleActionState, "confirmed">,
    transactionHash?: Hex,
  ): void {
    const row = this.requiredLifecycleRow(actionKey);
    if (row.status === "confirmed") {
      throw new Error("Lifecycle action is already confirmed");
    }
    this.database
      .prepare(
        "UPDATE lifecycle_actions SET status = ?, transaction_hash = ? WHERE action_key = ?",
      )
      .run(state, transactionHash?.toLowerCase() ?? null, canonical(actionKey));
  }

  private lifecycleRow(actionKey: string): LifecycleActionRow | undefined {
    return this.database
      .prepare("SELECT * FROM lifecycle_actions WHERE action_key = ?")
      .get(canonical(actionKey)) as LifecycleActionRow | undefined;
  }

  private requiredLifecycleRow(actionKey: string): LifecycleActionRow {
    const row = this.lifecycleRow(actionKey);
    if (row === undefined) throw new Error("Lifecycle action was not found");
    return row;
  }

  private initializeSchema(): void {
    this.database.exec(SCHEMA);
  }

  private reserveWithinTransaction(input: ReservationRequest): Reservation {
    if (input.maximumCost <= 0n) {
      throw new Error("Maximum cost must be positive");
    }
    const operationKey = canonical(input.operationKey);
    const existing = this.operationRow(operationKey, false);
    if (existing !== undefined) {
      return this.existingReservation(operationKey, existing, input);
    }
    const round = canonical(input.round);
    const account = canonical(input.account);
    const accountPolicy = this.readAccountPolicy(round, account);
    const sponsorPolicy = this.readSponsorPolicy(round, accountPolicy.sponsor);
    const available =
      sponsorPolicy.declaredBudget - sponsorPolicy.claimed - sponsorPolicy.reserved;
    if (input.maximumCost > available) {
      throw new Error("Maximum cost exceeds available sponsor allowance");
    }
    this.writeSponsorPolicy(round, accountPolicy.sponsor, {
      ...sponsorPolicy,
      reserved: sponsorPolicy.reserved + input.maximumCost,
    });
    this.insertReservation(operationKey, round, account, input);
    return { operationKey, state: "reserved" };
  }

  private insertReservation(
    operationKey: string,
    round: string,
    account: string,
    input: ReservationRequest,
  ): void {
    const stored = {
      round,
      account,
      maximumCost: input.maximumCost.toString(),
      expiresAt: input.expiresAt,
      preparedFingerprint: input.preparedFingerprint,
    } satisfies StoredReservation;
    try {
      this.database
        .prepare(
          "INSERT INTO operations (operation_key, round, account, status, policy) VALUES (?, ?, ?, 'reserved', ?)",
        )
        .run(operationKey, round, account, this.seal(operationAad(operationKey), stored));
    } catch (error) {
      if (errorMessage(error).includes("UNIQUE constraint")) {
        throw new Error("Account already has a pending operation", { cause: error });
      }
      throw error;
    }
  }

  private existingReservation(
    operationKey: string,
    existing: OperationRow,
    input: ReservationRequest,
  ): Reservation {
    const stored = this.open<StoredReservation>(
      operationAad(operationKey),
      existing.policy,
    );
    const matches =
      stored.round === canonical(input.round) &&
      stored.account === canonical(input.account) &&
      stored.maximumCost === input.maximumCost.toString() &&
      stored.expiresAt === input.expiresAt;
    const fingerprintMatches =
      stored.preparedFingerprint === input.preparedFingerprint;
    if (!matches || !fingerprintMatches) {
      throw new Error("Operation key belongs to another request");
    }
    return { operationKey, state: existing.status };
  }

  private releaseReservation(
    operationKeyValue: string,
    nextState: "failed",
  ): void {
    const operationKey = canonical(operationKeyValue);
    const row = this.requiredOperationRow(operationKey);
    if (row.status === nextState) return;
    if (row.status !== "reserved" && row.status !== "unknown") {
      throw new Error("Operation reservation is already resolved");
    }
    const reservation = this.open<StoredReservation>(
      operationAad(operationKey),
      row.policy,
    );
    this.updateSponsorReservation(reservation, -BigInt(reservation.maximumCost), 0n);
    this.updateOperationState(operationKey, nextState);
  }

  private confirmWithinTransaction(
    operationKeyValue: string,
    actualClaim: bigint,
  ): void {
    const operationKey = canonical(operationKeyValue);
    const row = this.requiredOperationRow(operationKey);
    if (row.status !== "reserved" && row.status !== "unknown") {
      throw new Error("Operation reservation is already resolved");
    }
    const reservation = this.open<StoredReservation>(
      operationAad(operationKey),
      row.policy,
    );
    const maximumCost = BigInt(reservation.maximumCost);
    if (actualClaim < 0n || actualClaim > maximumCost) {
      throw new Error("Actual claim exceeds reserved maximum cost");
    }
    this.updateSponsorReservation(reservation, -maximumCost, actualClaim);
    this.updateOperationState(operationKey, "confirmed");
  }

  private updateSponsorReservation(
    reservation: StoredReservation,
    reservedDelta: bigint,
    claimedDelta: bigint,
  ): void {
    const account = this.readAccountPolicy(reservation.round, reservation.account);
    const sponsor = this.readSponsorPolicy(reservation.round, account.sponsor);
    this.writeSponsorPolicy(reservation.round, account.sponsor, {
      ...sponsor,
      reserved: sponsor.reserved + reservedDelta,
      claimed: sponsor.claimed + claimedDelta,
    });
  }

  private updateOperationState(
    operationKey: string,
    state: ReservationState,
  ): void {
    this.database
      .prepare("UPDATE operations SET status = ? WHERE operation_key = ?")
      .run(state, operationKey);
  }

  private readAccountPolicy(round: string, account: string): StoredAccountPolicy {
    const row = this.policyRow(
      "SELECT policy FROM accounts WHERE round = ? AND account = ?",
      round,
      account,
    );
    return this.open(accountAad(round, account), row.policy);
  }

  private readReservation(operationKeyValue: string): StoredReservation {
    const operationKey = canonical(operationKeyValue);
    const row = this.requiredOperationRow(operationKey);
    return this.open(operationAad(operationKey), row.policy);
  }

  private writeSponsorPolicy(
    round: string,
    sponsor: string,
    policy: SponsorPolicy,
  ): void {
    const stored = {
      declaredBudget: policy.declaredBudget.toString(),
      claimed: policy.claimed.toString(),
      reserved: policy.reserved.toString(),
      slot: policy.slot,
    } satisfies StoredSponsorPolicy;
    this.database
      .prepare("UPDATE sponsors SET policy = ? WHERE round = ? AND sponsor = ?")
      .run(this.seal(sponsorAad(round, sponsor), stored), round, sponsor);
  }

  private operationRow(
    operationKey: string,
    required: boolean,
  ): OperationRow | undefined {
    const row = this.database
      .prepare("SELECT status, policy FROM operations WHERE operation_key = ?")
      .get(operationKey) as OperationRow | undefined;
    if (required && row === undefined) throw new Error("Operation was not found");
    return row;
  }

  private requiredOperationRow(operationKey: string): OperationRow {
    const row = this.operationRow(operationKey, true);
    if (row === undefined) throw new Error("Operation was not found");
    return row;
  }

  private policyRow(sql: string, ...values: string[]): PolicyRow {
    const row = this.statement(sql).get(...values) as PolicyRow | undefined;
    if (row === undefined) throw new Error("Policy record was not found");
    return row;
  }

  private statement(sql: string): StatementSync {
    return this.database.prepare(sql);
  }

  private transaction<Output>(operation: () => Output): Output {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const output = operation();
      this.database.exec("COMMIT");
      return output;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private seal(aad: string, value: object): Uint8Array {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([
      Buffer.from([RECORD_VERSION]),
      nonce,
      cipher.getAuthTag(),
      ciphertext,
    ]);
  }

  private open<Output>(aad: string, record: Uint8Array): Output {
    const bytes = Buffer.from(record);
    if (bytes[0] !== RECORD_VERSION) throw new Error("Unknown policy record version");
    const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
    const tag = bytes.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
    const ciphertext = bytes.subarray(1 + NONCE_BYTES + TAG_BYTES);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, nonce);
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8")) as Output;
    } catch (error) {
      throw new Error("Unable to authenticate or decrypt policy record", {
        cause: error,
      });
    }
  }
}
