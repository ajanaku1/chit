/**
 * Control Room reporting (FR-010, FR-011, SC-003, SC-004).
 *
 * Aggregates per-account buy results into the fleet-level view the trader
 * sees: how many buys were sponsored, how many rejected, and where the ETH
 * budget stands. The report is built from public facts only and always carries
 * the narrow privacy claim — never an overclaim.
 */

import { FLEET_PRIVACY_CLAIM, POOL_PRIVACY_CLAIM } from "./index.js";

type Hex = `0x${string}`;

export type BudgetView = { funded: string; reserved: string; spent: string; unused: string };

export type AccountBuyResult = {
  account: Hex;
  status: "sponsored" | "rejected";
  budget: BudgetView;
  userOpHash?: Hex;
};

export type BuyReport = {
  sponsored: number;
  rejected: number;
  budget: BudgetView;
  rows: { account: Hex; status: "sponsored" | "rejected"; userOpHash?: Hex }[];
  privacyNote: string;
};

const EMPTY_BUDGET: BudgetView = { funded: "0", reserved: "0", spent: "0", unused: "0" };

export type CampaignState =
  | "Draft" | "Awaiting recovery confirmation" | "Awaiting funding" | "Activating"
  | "Active" | "Paused" | "Revoked" | "Depleted" | "Expired" | "Closed";

export type ControlAction = "pause" | "resume" | "revoke" | "close" | "topUp";

/** A campaign's claim on the trader's pool balance (Stage 2). */
export type DrawView = {
  amount: string;
  spent: string;
  remaining: string;
  dueAt: string;
  state: "Pending" | "Funded" | "Closed";
};

export type ControlRoomInput = {
  campaign: string;
  state: CampaignState;
  budget: BudgetView;
  returnedEth?: string;
  /** Present for a pooled campaign; the draw is its budget, not the escrow. */
  draw?: DrawView;
  balance?: { available: string };
  pool?: { paused: boolean };
  creditedToBalance?: string;
};

export type ControlRoomView = {
  campaign: string;
  state: CampaignState;
  stateNote: string;
  availableActions: ControlAction[];
  terminal: boolean;
  budget: BudgetView;
  returnedEth?: string;
  draw?: DrawView;
  balance?: { available: string };
  poolPaused?: boolean;
  poolNote?: string;
  creditedToBalance?: string;
  privacyNote: string;
};

/** Actions each state legally offers (FR-012, FR-013, FR-015). */
const ACTIONS_BY_STATE: Record<CampaignState, ControlAction[]> = {
  Draft: [],
  "Awaiting recovery confirmation": [],
  "Awaiting funding": [],
  Activating: [],
  Active: ["pause", "revoke", "close"],
  Paused: ["resume", "revoke", "close"],
  Revoked: ["close"],
  Depleted: ["close"],
  Expired: ["close"],
  Closed: [],
};

const TERMINAL_STATES: readonly CampaignState[] = ["Revoked", "Depleted", "Expired", "Closed"];

/** What each state means once a pool, not an escrow, holds the money. */
const POOLED_STATE_NOTES: Partial<Record<CampaignState, string>> = {
  Activating: "Funding your fleet. The wait is deliberate: it keeps your deposit and your fleet from lining up in time.",
  Depleted: "This fleet has spent its draw. Top up from your balance to keep trading, or close it.",
  Closed: "Closed. Everything this fleet did not spend went back to your balance; nothing was paid out on chain.",
};

const STATE_NOTES: Partial<Record<CampaignState, string>> = {
  Active: "Sponsorship is live within the campaign policy.",
  Paused: "Sponsorship is blocked until you resume.",
  Revoked: "Revoked campaigns cannot resume or rotate a session key. Close to recover unused ETH; further activity needs a new campaign.",
  Depleted: "The remaining budget cannot fund another request. Close to recover it.",
  Expired: "The campaign reached its expiry. Close to recover unused ETH.",
  Closed: "The campaign is closed and its unused ETH was returned to you.",
};

/** The trader-facing lifecycle view: state, legal actions, budget, and claims. */
export function buildControlRoomView(input: ControlRoomInput): ControlRoomView {
  const pooled = input.draw !== undefined;
  const actions = ACTIONS_BY_STATE[input.state];
  return {
    campaign: input.campaign,
    state: input.state,
    stateNote:
      (pooled ? POOLED_STATE_NOTES[input.state] : undefined) ??
      STATE_NOTES[input.state] ??
      "Complete the setup journey to activate.",
    // A depleted pooled campaign is not finished: its balance can refill it.
    availableActions: pooled && input.state === "Depleted" ? ["topUp", ...actions] : actions,
    terminal: TERMINAL_STATES.includes(input.state),
    budget: input.budget,
    ...(input.returnedEth === undefined ? {} : { returnedEth: input.returnedEth }),
    ...(input.draw === undefined ? {} : { draw: input.draw }),
    ...(input.balance === undefined ? {} : { balance: input.balance }),
    ...(input.pool === undefined
      ? {}
      : {
          poolPaused: input.pool.paused,
          ...(input.pool.paused
            ? { poolNote: "Chit has paused the pool. Deposits and new fleet funding are stopped; your self-serve exit still works." }
            : {}),
        }),
    ...(input.creditedToBalance === undefined ? {} : { creditedToBalance: input.creditedToBalance }),
    privacyNote: pooled ? POOL_PRIVACY_CLAIM : FLEET_PRIVACY_CLAIM,
  };
}

/** Actions that cannot be taken back ask first; the rest just happen. */
export const confirmationFor = (action: ControlAction): { title: string; body: string; confirm: string } | undefined =>
  action === "revoke"
    ? { title: "Stop this fleet for good?", body: "Sponsorship ends now and cannot be resumed. Close is the only action left afterwards.", confirm: "Stop for good" }
    : action === "close"
      ? { title: "Close this fleet?", body: "Whatever it did not spend goes back to your Chit balance.", confirm: "Close fleet" }
      : undefined;

/** States with something happening right now, which earn the live dot. */
export const isLiveState = (state: string): boolean => state === "Active" || state === "Activating";

export function buildBuyReport(results: readonly AccountBuyResult[]): BuyReport {
  const last = results[results.length - 1];
  return {
    sponsored: results.filter((entry) => entry.status === "sponsored").length,
    rejected: results.filter((entry) => entry.status === "rejected").length,
    // Budgets are cumulative snapshots; the final row is the campaign's state.
    budget: last ? last.budget : EMPTY_BUDGET,
    rows: results.map((entry) => ({
      account: entry.account,
      status: entry.status,
      ...(entry.userOpHash ? { userOpHash: entry.userOpHash } : {}),
    })),
    privacyNote: FLEET_PRIVACY_CLAIM,
  };
}
