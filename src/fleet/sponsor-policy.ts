/**
 * Gas sponsorship: the sponsor's policy, and the checks it implies.
 *
 * A sponsor is a dapp that prepays gas for its users. Its policy says which
 * of its contracts and which functions Chit may sponsor calls to, how much
 * one operation may cost, and how much one user and the sponsor as a whole
 * may spend in a day. Every request for sponsorship is checked against all
 * of it before anything is signed (spec FR-002, SC-003); a refusal names its
 * reason and never a free-text message.
 *
 * Pure: nothing here reads a chain or a store. The service feeds it the
 * numbers and it answers.
 */

import { decodeFunctionData, parseAbi, type Hex } from "viem";

import { FleetValidationError, isAddress, isUint, normalizeAddress, type Address, type Uint } from "./types.js";

export type SponsorTarget = {
  address: Address;
  /** Four-byte selectors the sponsor allows on this target; empty means any function of it. */
  selectors: Hex[];
};

export type SponsorPolicy = {
  targets: SponsorTarget[];
  /** Ceiling on one operation's charge (cost plus fee), in wei. */
  maxCostPerOp: Uint;
  /** Ceiling on what one user may have sponsored in a UTC day, in wei. */
  maxPerUserPerDay: Uint;
  /** Ceiling on what the sponsor as a whole may have sponsored in a UTC day, in wei. */
  maxPerSponsorPerDay: Uint;
};

export const MAX_TARGETS = 32;
export const MAX_SELECTORS = 64;

const SELECTOR = /^0x[0-9a-fA-F]{8}$/;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Validates a policy as a sponsor submits it. Throws FleetValidationError with a stable reason. */
export const parseSponsorPolicy = (value: unknown): SponsorPolicy => {
  const record = asRecord(value);
  const rawTargets = record["targets"];
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) throw new FleetValidationError("targets_required");
  if (rawTargets.length > MAX_TARGETS) throw new FleetValidationError("too_many_targets");
  const targets: SponsorTarget[] = rawTargets.map((raw) => {
    const target = asRecord(raw);
    if (!isAddress(target["address"])) throw new FleetValidationError("invalid_target");
    const rawSelectors = target["selectors"] ?? [];
    if (!Array.isArray(rawSelectors) || rawSelectors.length > MAX_SELECTORS) throw new FleetValidationError("invalid_selectors");
    const selectors = rawSelectors.map((s) => {
      if (typeof s !== "string" || !SELECTOR.test(s)) throw new FleetValidationError("invalid_selector");
      return s.toLowerCase() as Hex;
    });
    return { address: normalizeAddress(target["address"]), selectors };
  });
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.address)) throw new FleetValidationError("duplicate_target");
    seen.add(t.address);
  }
  const wei = (key: string): Uint => {
    const v = record[key];
    if (!isUint(v) || BigInt(v) === 0n) throw new FleetValidationError(`invalid_${key}`);
    return v;
  };
  const policy = {
    targets,
    maxCostPerOp: wei("maxCostPerOp"),
    maxPerUserPerDay: wei("maxPerUserPerDay"),
    maxPerSponsorPerDay: wei("maxPerSponsorPerDay"),
  };
  if (BigInt(policy.maxCostPerOp) > BigInt(policy.maxPerUserPerDay)) throw new FleetValidationError("op_ceiling_over_user_cap");
  if (BigInt(policy.maxPerUserPerDay) > BigInt(policy.maxPerSponsorPerDay)) throw new FleetValidationError("user_cap_over_sponsor_cap");
  return policy;
};

/** The one call a sponsored account makes: SimpleAccount's and FleetAccount's `execute`. */
const EXECUTE_ABI = parseAbi(["function execute(address target, uint256 value, bytes data)"]);

export type SponsoredCall = { target: Address; value: bigint; selector: Hex | null };

/**
 * Reads the target, value and inner selector out of an account's callData.
 * Null when the callData is not a single `execute`: batches, upgrades and
 * anything else are not sponsored, whatever the request says (FR-010).
 */
export const decodeSponsoredCall = (callData: Hex): SponsoredCall | null => {
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: EXECUTE_ABI, data: callData }) as typeof decoded;
  } catch {
    return null;
  }
  if (decoded.functionName !== "execute") return null;
  const [target, value, data] = decoded.args as [Address, bigint, Hex];
  const selector = data.length >= 10 ? (data.slice(0, 10).toLowerCase() as Hex) : null;
  return { target: normalizeAddress(target), value, selector };
};

export type Refusal =
  | "call_not_execute"
  | "value_not_zero"
  | "target_not_allowed"
  | "selector_not_allowed"
  | "cost_over_ceiling"
  | "user_daily_cap"
  | "sponsor_daily_cap"
  | "budget_short"
  | "sponsor_paused"
  | "sponsor_closed"
  | "sponsor_unknown";

export type PolicyFacts = {
  /** What this op would charge the budget at most: the EntryPoint prefund plus the fee. */
  maxCharged: bigint;
  /** Already sponsored today for this user, at the ceiling of each op. */
  userSpentToday: bigint;
  /** Already sponsored today for the sponsor, at the ceiling of each op. */
  sponsorSpentToday: bigint;
  /** The escrow's unused budget right now. */
  budgetUnused: bigint;
};

/**
 * Every check the policy implies, in the order a sponsor would want them
 * reported: the call itself first, then the ceilings, then the caps, then
 * the money. The first failure is the answer (SC-003 wants them all refused
 * before a signature; it does not need them all listed).
 */
export const checkSponsorship = (
  policy: SponsorPolicy,
  call: SponsoredCall | null,
  facts: PolicyFacts,
): Refusal | null => {
  if (!call) return "call_not_execute";
  if (call.value !== 0n) return "value_not_zero";
  const target = policy.targets.find((t) => t.address === call.target);
  if (!target) return "target_not_allowed";
  if (target.selectors.length > 0 && (!call.selector || !target.selectors.includes(call.selector))) return "selector_not_allowed";
  if (facts.maxCharged > BigInt(policy.maxCostPerOp)) return "cost_over_ceiling";
  if (facts.userSpentToday + facts.maxCharged > BigInt(policy.maxPerUserPerDay)) return "user_daily_cap";
  if (facts.sponsorSpentToday + facts.maxCharged > BigInt(policy.maxPerSponsorPerDay)) return "sponsor_daily_cap";
  if (facts.budgetUnused < facts.maxCharged) return "budget_short";
  return null;
};

/** The UTC day a moment falls in, as the ledger keys it. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** The charge for a gas cost under a fee in basis points; mirrors FleetPaymaster.charged. */
export const chargedWithFee = (gasCost: bigint, feeBps: number): bigint => gasCost + (gasCost * BigInt(feeBps)) / 10_000n;
