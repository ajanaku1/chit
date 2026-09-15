/**
 * Fleet service authentication, idempotency, and redaction (FR-006, FR-011, FR-014).
 *
 * Implements the envelope rules in `specs/001-fleet-mission/contracts/fleet-api.md`.
 * Three defences live here because every route needs all three: a domain-separated
 * single-use challenge, an action and body-hash check that runs before signature
 * recovery, and a redaction pass that keeps credential material, recovery
 * ciphertext, raw signatures, and the primary-to-fleet mapping out of responses
 * and logs.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { keccak256, recoverMessageAddress, stringToBytes } from "viem";

import { createMemoryStore, type StorePort } from "./store.js";
import type { Address, ApiErrorCode, AuthEnvelope, Hex } from "./types.js";

export const CHALLENGE_VERSION = "fleet-mission-v1";

const IDEMPOTENCY_KEY = /^fleet-[A-Za-z0-9_-]{16,128}$/;

export type ServiceConfig = { origin: string; chainId: number; maxTtlSeconds: number };
export type ChallengeInput = { primaryWallet: Address; action: string; payloadHash: Hex };
export type Challenge = {
  nonce: string;
  issuedAt: string;
  challenge: string;
  expiresAt: string;
  maxTtlSeconds: number;
};
export type IdempotencyScope = { primaryWallet: Address; action: string; campaign: string };

export class ServiceError extends Error {
  readonly code: ApiErrorCode;
  readonly reason: string;

  constructor(code: ApiErrorCode, reason: string) {
    super(`${code}: ${reason}`);
    this.name = "ServiceError";
    this.code = code;
    this.reason = reason;
  }
}

/** Recursively key-sorted JSON with no whitespace: the only bytes a payload hash is taken over. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, entry]) => `${JSON.stringify(name)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const payloadHash = (body: unknown): Hex => keccak256(stringToBytes(canonicalJson(body)));

/** The versioned ASCII field order a primary wallet signs (EIP-191 `personal_sign`). */
export const challengeBytes = (
  config: ServiceConfig,
  auth: Pick<AuthEnvelope, "primaryWallet" | "nonce" | "issuedAt" | "expiresAt" | "action" | "payloadHash">,
): string =>
  [
    CHALLENGE_VERSION,
    config.origin,
    String(config.chainId),
    auth.primaryWallet.toLowerCase(),
    auth.nonce,
    auth.issuedAt,
    auth.expiresAt,
    auth.action,
    auth.payloadHash,
  ].join("|");

export const isIdempotencyKey = (value: unknown): boolean =>
  typeof value === "string" && IDEMPOTENCY_KEY.test(value);

/** Field names that must never be persisted, returned, or logged. */
const REDACTED_FIELDS = new Set([
  "privateKey",
  "mnemonic",
  "seed",
  "keystore",
  "signature",
  "payloadCiphertext",
  "wrappedDek",
  "dek",
  "kek",
  "mapping",
]);

/** Field names a request body may never carry at all. A raw signature is legitimate in `auth`. */
const FORBIDDEN_BODY_FIELDS = new Set([...REDACTED_FIELDS].filter((name) => name !== "signature"));

const SECRET_NAME = /(secret|private|mnemonic|seed|passphrase)/i;

/** Replaces credential, recovery, and primary-to-fleet material with `[redacted]`. */
export const redactForLog = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactForLog);
  if (typeof value !== "object" || value === null) return value;

  const output: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    output[name] = REDACTED_FIELDS.has(name) || SECRET_NAME.test(name) ? "[redacted]" : redactForLog(entry);
  }
  return output;
};

/** Throws when a request body carries a field it must never contain. */
export const assertNoSecrets = (value: unknown, seen = new WeakSet<object>()): void => {
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) assertNoSecrets(entry, seen);
    return;
  }

  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_BODY_FIELDS.has(name) || SECRET_NAME.test(name)) {
      throw new ServiceError("challenge_invalid", `forbidden_field:${name}`);
    }
    assertNoSecrets(entry, seen);
  }
};

type IssuedNonce = { primaryWallet: string; action: string; payloadHash: Hex; expiresAt: number; consumed: boolean };

export class CampaignService {
  readonly #config: ServiceConfig;
  readonly #now: () => Date;
  readonly #nonces = new Map<string, IssuedNonce>();
  /** Idempotency results and the burn of MAC nonces: shared across instances when the store is. */
  readonly #store: StorePort;

  /**
   * With a secret, nonces are HMACs over the challenge fields, so any service
   * instance holding the same secret verifies a challenge another instance
   * issued (stateless across serverless functions). Without one, nonces are
   * random and live only in this instance's memory.
   */
  constructor(
    config: ServiceConfig,
    deps: { now?: () => Date; randomNonce?: () => string; nonceSecret?: string; store?: StorePort } = {},
  ) {
    this.#config = config;
    this.#now = deps.now ?? (() => new Date());
    this.#randomNonce = deps.randomNonce ?? (() => crypto.randomUUID());
    this.#nonceSecret = deps.nonceSecret;
    this.#store = deps.store ?? createMemoryStore();
  }

  readonly #randomNonce: () => string;
  readonly #nonceSecret: string | undefined;

  #macNonce(fields: { primaryWallet: string; action: string; payloadHash: Hex; issuedAt: string }): string {
    return createHmac("sha256", this.#nonceSecret ?? "")
      .update([CHALLENGE_VERSION, this.#config.origin, fields.primaryWallet.toLowerCase(), fields.action, fields.payloadHash, fields.issuedAt].join("|"))
      .digest("hex");
  }

  /** Stateless verification: the nonce and the expiry must both derive from the signed fields. */
  #verifyMacNonce(auth: AuthEnvelope): void {
    const expected = this.#macNonce(auth);
    const given = Buffer.from(auth.nonce, "utf8");
    if (given.length !== expected.length || !timingSafeEqual(given, Buffer.from(expected, "utf8"))) {
      throw new ServiceError("challenge_invalid", "nonce_unknown");
    }
    const issued = Date.parse(auth.issuedAt);
    if (Number.isNaN(issued) || new Date(issued + this.#config.maxTtlSeconds * 1000).toISOString() !== auth.expiresAt) {
      throw new ServiceError("challenge_invalid", "expiry_mismatch");
    }
    if (issued + this.#config.maxTtlSeconds * 1000 <= this.#now().getTime()) {
      throw new ServiceError("challenge_invalid", "challenge_expired");
    }
    // The burn itself happens after signature recovery (see verify): a forged
    // signature must not spend the real signer's nonce.
  }

  /** Drops challenges that can no longer be presented, consumed or not. */
  #sweepExpiredNonces(): void {
    const now = this.#now().getTime();
    for (const [nonce, issued] of this.#nonces) {
      if (issued.expiresAt <= now) this.#nonces.delete(nonce);
    }
  }

  issueChallenge(input: ChallengeInput): Challenge {
    this.#sweepExpiredNonces();
    const issued = this.#now();
    const expires = new Date(issued.getTime() + this.#config.maxTtlSeconds * 1000);
    const issuedAt = issued.toISOString();
    const nonce = this.#nonceSecret
      ? this.#macNonce({ primaryWallet: input.primaryWallet, action: input.action, payloadHash: input.payloadHash, issuedAt })
      : this.#randomNonce();
    const auth = {
      primaryWallet: input.primaryWallet,
      nonce,
      issuedAt: issued.toISOString(),
      expiresAt: expires.toISOString(),
      action: input.action,
      payloadHash: input.payloadHash,
    };

    this.#nonces.set(nonce, {
      primaryWallet: input.primaryWallet.toLowerCase(),
      action: input.action,
      payloadHash: input.payloadHash,
      expiresAt: expires.getTime(),
      consumed: false,
    });

    return {
      nonce,
      issuedAt: auth.issuedAt,
      challenge: challengeBytes(this.#config, auth),
      expiresAt: auth.expiresAt,
      maxTtlSeconds: this.#config.maxTtlSeconds,
    };
  }

  /**
   * Verifies one signed action and burns its nonce.
   *
   * The outer action and the recomputed body hash are checked first, so a request
   * that renames its action or swaps its body is refused before any signature
   * recovery happens.
   */
  async verify(action: string, request: { auth: AuthEnvelope; body: unknown }): Promise<string> {
    const { auth, body } = request;
    if (action !== auth.action) throw new ServiceError("challenge_invalid", "action_mismatch");
    if (payloadHash(body) !== auth.payloadHash) {
      throw new ServiceError("challenge_invalid", "payload_hash_mismatch");
    }

    if (this.#nonceSecret) {
      this.#verifyMacNonce(auth);
    } else {
      this.#verifyIssuedNonce(auth);
    }

    const recovered = await recoverMessageAddress({
      message: challengeBytes(this.#config, auth),
      signature: auth.signature,
    });
    if (recovered.toLowerCase() !== auth.primaryWallet.toLowerCase()) {
      throw new ServiceError("challenge_invalid", "signature_mismatch");
    }

    // The replay guard for MAC nonces lives in the store, so the instance that
    // verifies a challenge is not the only one that remembers it did.
    if (this.#nonceSecret && !(await this.#store.burnNonce(auth.nonce, Date.parse(auth.expiresAt), this.#now().getTime()))) {
      throw new ServiceError("challenge_invalid", "nonce_used");
    }

    // Kept, marked, rather than deleted: a replay must report reuse, not an
    // unknown challenge, until the entry ages out with its own expiry.
    this.#nonces.set(auth.nonce, {
      primaryWallet: auth.primaryWallet.toLowerCase(), action: auth.action, payloadHash: auth.payloadHash,
      expiresAt: Date.parse(auth.expiresAt), consumed: true,
    });
    return auth.primaryWallet.toLowerCase();
  }

  #verifyIssuedNonce(auth: AuthEnvelope): void {
    const issued = this.#nonces.get(auth.nonce);
    if (!issued) throw new ServiceError("challenge_invalid", "nonce_unknown");
    if (issued.consumed) throw new ServiceError("challenge_invalid", "nonce_used");
    if (issued.expiresAt <= this.#now().getTime()) {
      this.#nonces.delete(auth.nonce);
      throw new ServiceError("challenge_invalid", "challenge_expired");
    }
    if (issued.action !== auth.action) throw new ServiceError("challenge_invalid", "action_mismatch");
    if (issued.payloadHash !== auth.payloadHash) {
      throw new ServiceError("challenge_invalid", "payload_hash_mismatch");
    }
    if (issued.primaryWallet !== auth.primaryWallet.toLowerCase()) {
      throw new ServiceError("challenge_invalid", "wallet_mismatch");
    }
  }

  /**
   * Runs `action` at most once per key, wallet, action, and campaign.
   *
   * A failed action records nothing, so it stays retryable and consumes neither
   * the service fee nor campaign ETH.
   */
  async runIdempotent<T>(
    key: string,
    scope: IdempotencyScope,
    body: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!isIdempotencyKey(key)) throw new ServiceError("idempotency_conflict", "malformed_key");

    const scoped = [key, scope.primaryWallet.toLowerCase(), scope.action, scope.campaign].join("|");
    const hash = payloadHash(body);
    const existing = await this.#store.idempotency.get(scoped);
    if (existing) {
      if (existing.payloadHash !== hash) throw new ServiceError("idempotency_conflict", "payload_changed");
      return existing.result as T;
    }

    const result = await action();
    await this.#store.idempotency.put(scoped, { payloadHash: hash, result });
    return result;
  }
}

/** Marks a recovered wallet for the record type the service stores. */
export type VerifiedWallet = Lowercase<Address>;
