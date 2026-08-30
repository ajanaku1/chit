/**
 * Fleet dependency evidence validator.
 *
 * Implements `specs/001-fleet-mission/contracts/fleet-evidence.md`. A campaign may
 * only be activated against dependencies this validator accepts, so the demo can
 * never present an unverified or invented route as an established testnet fact
 * (FR-018).
 */

import { isAddress, normalizeAddress, type Address } from "./types.js";

export const EVIDENCE_ROLES = ["provider", "entryPoint", "paymaster", "router", "venue"] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

/** Roles that name an on-chain deployment; `provider` names an endpoint, never an address. */
const ADDRESS_ROLES: readonly EvidenceRole[] = ["entryPoint", "paymaster", "router", "venue"];

export type EvidenceMode = "live" | "fixture";
export type AllowedClaim = "verified-testnet" | "test-only-fixture";

export type DependencyRecord = {
  role: EvidenceRole;
  /** True when the record names a real deployment; false when it names a test double. */
  verified: boolean;
  address?: Address;
  source: string;
  provenance: string;
};

export type DependencyEvidence = {
  version: 1;
  mode: EvidenceMode;
  testOnly: boolean;
  chainId: number;
  verifiedAt: string;
  maxAgeSeconds: number;
  allowedClaim: AllowedClaim;
  dependencies: Record<EvidenceRole, DependencyRecord>;
};

/** The single fail-closed outcome for every malformed, stale, or overclaiming record. */
export class EvidenceInvalidError extends Error {
  readonly code = "evidence_invalid";
  readonly reason: string;

  constructor(reason: string) {
    super(`evidence_invalid: ${reason}`);
    this.name = "EvidenceInvalidError";
    this.reason = reason;
  }
}

const CLAIM_FOR_MODE: Record<EvidenceMode, AllowedClaim> = {
  live: "verified-testnet",
  fixture: "test-only-fixture",
};

const invalid = (reason: string): never => {
  throw new EvidenceInvalidError(reason);
};

const asRecord = (value: unknown, reason: string): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid(reason);

const nonEmptyString = (value: unknown, reason: string): string =>
  typeof value === "string" && value.length > 0 ? value : invalid(reason);

const parseRecord = (role: EvidenceRole, value: unknown, mode: EvidenceMode): DependencyRecord => {
  const fields = asRecord(value, `role_malformed:${role}`);
  if (fields["role"] !== role) invalid(`role_mismatch:${role}`);
  if (typeof fields["verified"] !== "boolean") invalid(`field_missing:${role}.verified`);

  const verified = fields["verified"] as boolean;
  if (mode === "live" && !verified) invalid(`live_role_unverified:${role}`);

  const parsed: DependencyRecord = {
    role,
    verified,
    source: nonEmptyString(fields["source"], `field_missing:${role}.source`),
    provenance: nonEmptyString(fields["provenance"], `field_missing:${role}.provenance`),
  };

  const address = fields["address"];
  if (address === undefined) {
    // A verified deployment must be locatable; a double must not look like one.
    if (verified && ADDRESS_ROLES.includes(role)) invalid("address_required");
    return parsed;
  }

  if (!verified) invalid(`unverified_address_forbidden:${role}`);
  if (!ADDRESS_ROLES.includes(role)) invalid(`${role}_address_forbidden`);
  if (!isAddress(address)) invalid(`invalid_address:${role}`);
  return { ...parsed, address: normalizeAddress(address as string) };
};

/**
 * Parses and validates a dependency evidence record.
 *
 * Live records must name a positive freshness window and are rejected once
 * `verifiedAt` is older than it. Fixture records describe locally deployed test
 * doubles rather than chain state, so they carry no address and no time bound;
 * `maxAgeSeconds: 0` is how a record declares that it is not time-bounded.
 */
export const parseDependencyEvidence = (input: unknown, now: Date): DependencyEvidence => {
  const fields = asRecord(input, "not_an_object");

  if (fields["version"] !== 1) invalid("unsupported_version");

  const mode = fields["mode"];
  if (mode !== "live" && mode !== "fixture") invalid("unsupported_mode");
  const evidenceMode = mode as EvidenceMode;

  const chainId = fields["chainId"];
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId < 1) invalid("invalid_chain_id");

  const verifiedAt = fields["verifiedAt"];
  if (typeof verifiedAt !== "string" || Number.isNaN(Date.parse(verifiedAt))) invalid("invalid_verified_at");

  const maxAgeSeconds = fields["maxAgeSeconds"];
  if (typeof maxAgeSeconds !== "number" || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    invalid("invalid_max_age_seconds");
  }

  if (fields["allowedClaim"] !== CLAIM_FOR_MODE[evidenceMode]) invalid("claim_mode_mismatch");

  const testOnly = fields["testOnly"] === true;
  if (evidenceMode === "fixture") {
    if (!testOnly) invalid("fixture_not_test_only");
    if ((maxAgeSeconds as number) !== 0) invalid("fixture_freshness_forbidden");
  } else {
    if (testOnly) invalid("live_marked_test_only");
    if ((maxAgeSeconds as number) === 0) invalid("live_freshness_required");
    const ageSeconds = (now.getTime() - Date.parse(verifiedAt as string)) / 1000;
    if (ageSeconds < 0 || ageSeconds > (maxAgeSeconds as number)) invalid("evidence_stale");
  }

  const declared = asRecord(fields["dependencies"], "dependencies_malformed");
  for (const role of Object.keys(declared)) {
    if (!(EVIDENCE_ROLES as readonly string[]).includes(role)) invalid(`unknown_role:${role}`);
  }

  const dependencies = {} as Record<EvidenceRole, DependencyRecord>;
  for (const role of EVIDENCE_ROLES) {
    if (declared[role] === undefined) invalid(`role_missing:${role}`);
    dependencies[role] = parseRecord(role, declared[role], evidenceMode);
  }

  // A fixture must actually contain a double. Otherwise it is understating a
  // fully verified record, and the weaker claim would be the wrong one.
  if (evidenceMode === "fixture" && EVIDENCE_ROLES.every((role) => dependencies[role].verified)) {
    invalid("fixture_without_double");
  }

  return {
    version: 1,
    mode: evidenceMode,
    testOnly,
    chainId: chainId as number,
    verifiedAt: verifiedAt as string,
    maxAgeSeconds: maxAgeSeconds as number,
    allowedClaim: CLAIM_FOR_MODE[evidenceMode],
    dependencies,
  };
};

/** The only claim a record's mode entitles the product to publish. */
export const claimFor = (evidence: DependencyEvidence): AllowedClaim => evidence.allowedClaim;
