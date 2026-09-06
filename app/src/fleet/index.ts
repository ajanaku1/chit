/**
 * Fleet Mission browser boundary.
 *
 * Two things must be true on every path out of the browser: the product only
 * claims what it can demonstrate (FR-011, FR-018), and locally generated
 * credential material never becomes part of a service request (FR-006, FR-017).
 * Both are enforced here so no feature module can quietly widen either one.
 */

/** Capabilities Fleet Mission deliberately does not have (FR-017). */
export const FLEET_EXCLUDED_CAPABILITIES = [
  "imported keys",
  "custody",
  "sells",
  "limit trading",
  "copy trading",
  "P&L",
  "charts",
  "Telegram",
  "mobile",
  "arbitrary calls",
  "hidden trades",
  "operator-blind attribution",
  "mainnet sponsorship",
  "Robinhood Nox",
  "staking",
  "revenue",
  "buybacks",
  "a new token",
  "manufactured volume",
  "market manipulation",
] as const;

/** What a public observer can always see (FR-011). */
export const FLEET_PUBLIC_FACTS = [
  "fleet accounts",
  "trades",
  "amounts",
  "timing",
  "gas",
  "the operator's gas payments",
] as const;

/** The single fact sponsorship withholds from a public observer (FR-011). */
export const FLEET_PRIVATE_FACT =
  "the primary-wallet-to-fleet relationship is not published on chain";

/** The exact claim the product is entitled to publish while the operator holds the mapping. */
export const FLEET_PRIVACY_CLAIM =
  "Fleet accounts, their trades, amounts, timing, gas, and the operator's gas payments stay publicly visible. " +
  "Only the primary-wallet-to-fleet relationship is withheld from the chain, and the operator knows it.";

/** Field names that identify local credential or recovery material. */
export const SERVICE_FORBIDDEN_FIELDS = [
  "privateKey",
  "mnemonic",
  "seed",
  "keystore",
  "signature",
  "payloadCiphertext",
  "wrappedDek",
  "dek",
  "kek",
] as const;

const FORBIDDEN = new Set<string>(SERVICE_FORBIDDEN_FIELDS);

/** A field whose name suggests it holds a secret, even under a name not listed above. */
const SECRET_NAME = /(secret|private|mnemonic|seed|passphrase)/i;

/** Rejections the browser raises before a request is ever sent. */
export class BoundaryViolationError extends Error {
  readonly code = "boundary_violation";
  readonly reason: string;

  constructor(reason: string) {
    super(`boundary_violation: ${reason}`);
    this.name = "BoundaryViolationError";
    this.reason = reason;
  }
}

/**
 * Throws unless `value` is safe to send to the service.
 *
 * Walks the whole payload rather than its top level, because a nested account
 * entry is exactly where credential material would otherwise slip through.
 */
export const assertServiceSafe = (value: unknown, seen = new WeakSet<object>()): void => {
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) assertServiceSafe(entry, seen);
    return;
  }

  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN.has(name) || SECRET_NAME.test(name)) {
      throw new BoundaryViolationError(`forbidden_field:${name}`);
    }
    assertServiceSafe(entry, seen);
  }
};

/** Returns `value` unchanged once it has passed the boundary, for use at a call site. */
export const serviceSafe = <T>(value: T): T => {
  assertServiceSafe(value);
  return value;
};
