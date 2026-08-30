/**
 * Bounded session-key authorization (FR-007, FR-008, SC-006).
 *
 * One session key per campaign authorizes exactly one operation: the approved
 * buy, from a generated fleet account, on the campaign's chain, through the
 * campaign's router and function, inside its trade cap, per-account gas cap,
 * total gas budget, and expiry. Anything else is refused. This mirrors what
 * `contracts/fleet/FleetSessionPolicy.sol` enforces on chain, so the service can
 * refuse a request before it ever costs gas.
 */

import type { Address, CampaignState, Uint } from "./types.js";
import { canSponsor } from "./campaign-state.js";

/** The one operation a Fleet session key may authorize. */
export const SPONSORABLE_OPERATION = "buy" as const;

/** Operations the policy names explicitly so a refusal is never accidental. */
export type FleetOperation =
  | typeof SPONSORABLE_OPERATION
  | "transfer"
  | "transferOwnership"
  | "withdrawGas"
  | "authorizeKey"
  | "sell";

export type SessionKey = {
  campaign: string;
  chainId: number;
  accounts: readonly Address[];
  router: Address;
  function: string;
  maxTradeValue: Uint;
  perAccountGas: Uint;
  totalGas: Uint;
  expiry: string;
  revoked: boolean;
};

export type SponsorRequest = {
  campaign: string;
  chainId: number;
  account: Address;
  operation: FleetOperation;
  target: Address;
  function: string;
  value: Uint;
  gas: Uint;
};

export type AuthorizationInput = {
  session: SessionKey;
  request: SponsorRequest;
  state: CampaignState;
  /** Gas already committed against this campaign's budget. */
  spentGas: Uint;
  now: Date;
};

export type Authorization = { account: Address; gas: Uint; value: Uint };

export class PolicyRejection extends Error {
  readonly code = "policy_rejected";
  readonly reason: string;

  constructor(reason: string) {
    super(`policy_rejected: ${reason}`);
    this.name = "PolicyRejection";
    this.reason = reason;
  }
}

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const amount = (value: Uint, reason: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new PolicyRejection(reason);
  return BigInt(value);
};

export const authorize = ({ session, request, state, spentGas, now }: AuthorizationInput): Authorization => {
  if (!canSponsor(state)) throw new PolicyRejection(`state_not_sponsorable:${state}`);
  if (session.revoked) throw new PolicyRejection("session_revoked");
  if (Date.parse(session.expiry) <= now.getTime()) throw new PolicyRejection("campaign_expired");

  if (request.operation !== SPONSORABLE_OPERATION) {
    throw new PolicyRejection(`forbidden_operation:${request.operation}`);
  }

  if (request.campaign !== session.campaign) throw new PolicyRejection("campaign_mismatch");
  if (request.chainId !== session.chainId) throw new PolicyRejection("chain_mismatch");
  if (!session.accounts.some((account) => same(account, request.account))) {
    throw new PolicyRejection("unknown_account");
  }
  if (!same(request.target, session.router)) throw new PolicyRejection("unapproved_target");
  if (request.function !== session.function) throw new PolicyRejection("unapproved_function");

  const value = amount(request.value, "invalid_trade_value");
  if (value > amount(session.maxTradeValue, "invalid_max_trade_value")) {
    throw new PolicyRejection("trade_value_exceeded");
  }

  const gas = amount(request.gas, "invalid_gas");
  if (gas > amount(session.perAccountGas, "invalid_per_account_gas")) {
    throw new PolicyRejection("per_account_gas_exceeded");
  }
  if (amount(spentGas, "invalid_spent_gas") + gas > amount(session.totalGas, "invalid_total_gas")) {
    throw new PolicyRejection("total_gas_exceeded");
  }

  return { account: request.account, gas: request.gas, value: request.value };
};
