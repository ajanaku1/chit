/**
 * Shared Fleet Mission wire and domain types.
 *
 * The type surface mirrors `specs/001-fleet-mission/contracts/fleet-api.md`; the
 * runtime exports here are the validation the service, SDK, and browser share so
 * a single definition of "a well-formed fleet" applies on every side.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export type Uint = string;

export const CAMPAIGN_STATES = [
  "Draft",
  "Awaiting recovery confirmation",
  "Awaiting funding",
  "Activating",
  "Active",
  "Paused",
  "Revoked",
  "Depleted",
  "Expired",
  "Closed",
] as const;

export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export const MIN_FLEET_ACCOUNTS = 5;
export const MAX_FLEET_ACCOUNTS = 50;
export const DEMO_FLEET_ACCOUNTS = 5;

export type FleetAccountInit = { ownerAddress: Address; salt: Hex };

export type Policy = {
  chainId: number;
  accounts: number;
  router: Address;
  function: string;
  maxTradeValue: Uint;
  perAccountGas: Uint;
  totalGas: Uint;
  expiry: string;
};

export type AuthEnvelope = {
  primaryWallet: Address;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  action: string;
  payloadHash: Hex;
  signature: Hex;
};

export type Budget = { funded: Uint; reserved: Uint; spent: Uint; unused: Uint };
export type FeeQuote = {
  quoteId: string;
  threshold: Uint;
  baseFee: Uint;
  discount: Uint;
  netFee: Uint;
  eligible: boolean;
};
export type FeeCharge = FeeQuote & { feeAsset: string; recipient: string; chargeEvidence: string };
export type AccountResult = { account: Address; status: "sponsored" | "rejected"; budget: Budget };
export type CampaignResult = { campaign: string; state: CampaignState; fee?: FeeCharge; budget: Budget };
export type ActivationResult = CampaignResult & { accounts: Address[] };
export type BuyResult = { results: AccountResult[] };
export type ControlRoomResult = CampaignResult & { results: AccountResult[] };
export type ControlAction = "pause" | "resume" | "revoke" | "close";

export type ApiErrorCode =
  | "challenge_invalid"
  | "ineligible"
  | "policy_rejected"
  | "budget_exceeded"
  | "state_invalid"
  | "revoked_terminal"
  | "idempotency_conflict"
  | "dependency_evidence_invalid";

export type ApiError = { code: ApiErrorCode; retryable: boolean };

/** Every Fleet rejection carries a stable machine reason, never a free-text message. */
export class FleetValidationError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "FleetValidationError";
    this.reason = reason;
  }
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_UINT = /^(0|[1-9][0-9]*)$/;

export const isCampaignState = (value: unknown): value is CampaignState =>
  typeof value === "string" && (CAMPAIGN_STATES as readonly string[]).includes(value);

export const isAddress = (value: unknown): value is Address =>
  typeof value === "string" && HEX_ADDRESS.test(value);

export const isHex32 = (value: unknown): value is Hex => typeof value === "string" && HEX_32.test(value);

export const isUint = (value: unknown): value is Uint =>
  typeof value === "string" && DECIMAL_UINT.test(value);

export const normalizeAddress = (value: string): Address => value.toLowerCase() as Address;

const record = (value: unknown, reason: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FleetValidationError(reason);
  return value as Record<string, unknown>;
};

const positiveUint = (value: unknown, reason: string): Uint => {
  if (!isUint(value) || value === "0") throw new FleetValidationError(reason);
  return value;
};

/**
 * Validates a campaign's fleet initialization list: 5-50 entries with distinct
 * owner addresses and distinct salts, normalized to lowercase, and carrying no
 * field beyond the two public ones (FR-001, FR-005).
 */
export const parseFleetAccounts = (value: unknown): FleetAccountInit[] => {
  if (!Array.isArray(value)) throw new FleetValidationError("accounts_not_a_list");
  if (value.length < MIN_FLEET_ACCOUNTS || value.length > MAX_FLEET_ACCOUNTS) {
    throw new FleetValidationError("account_count_out_of_range");
  }

  const owners = new Set<string>();
  const salts = new Set<string>();
  return value.map((entry) => {
    const fields = record(entry, "invalid_account");
    if (!isAddress(fields["ownerAddress"])) throw new FleetValidationError("invalid_owner_address");
    if (!isHex32(fields["salt"])) throw new FleetValidationError("invalid_salt");

    const ownerAddress = normalizeAddress(fields["ownerAddress"]);
    const salt = fields["salt"].toLowerCase() as Hex;
    if (owners.has(ownerAddress)) throw new FleetValidationError("duplicate_owner_address");
    if (salts.has(salt)) throw new FleetValidationError("duplicate_salt");
    owners.add(ownerAddress);
    salts.add(salt);
    return { ownerAddress, salt };
  });
};

/** Validates the bounded campaign policy a trader must set before activation (FR-004, FR-007). */
export const parsePolicy = (value: unknown): Policy => {
  const fields = record(value, "invalid_policy");

  const chainId = fields["chainId"];
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId < 1) {
    throw new FleetValidationError("invalid_chain_id");
  }

  const accounts = fields["accounts"];
  if (
    typeof accounts !== "number" ||
    !Number.isSafeInteger(accounts) ||
    accounts < MIN_FLEET_ACCOUNTS ||
    accounts > MAX_FLEET_ACCOUNTS
  ) {
    throw new FleetValidationError("account_count_out_of_range");
  }

  if (!isAddress(fields["router"])) throw new FleetValidationError("invalid_router");
  const fn = fields["function"];
  if (typeof fn !== "string" || fn.length === 0) throw new FleetValidationError("invalid_function");

  const maxTradeValue = positiveUint(fields["maxTradeValue"], "invalid_max_trade_value");
  const perAccountGas = positiveUint(fields["perAccountGas"], "invalid_per_account_gas");
  const totalGas = positiveUint(fields["totalGas"], "invalid_total_gas");
  if (BigInt(totalGas) < BigInt(perAccountGas)) {
    throw new FleetValidationError("total_gas_below_per_account_gas");
  }

  const expiry = fields["expiry"];
  if (typeof expiry !== "string" || Number.isNaN(Date.parse(expiry))) {
    throw new FleetValidationError("invalid_expiry");
  }

  return {
    chainId,
    accounts,
    router: normalizeAddress(fields["router"]),
    function: fn,
    maxTradeValue,
    perAccountGas,
    totalGas,
    expiry,
  };
};
