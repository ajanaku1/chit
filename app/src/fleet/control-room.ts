/**
 * Control Room reporting (FR-010, FR-011, SC-003, SC-004).
 *
 * Aggregates per-account buy results into the fleet-level view the trader
 * sees: how many buys were sponsored, how many rejected, and where the ETH
 * budget stands. The report is built from public facts only and always carries
 * the narrow privacy claim — never an overclaim.
 */

import { FLEET_PRIVACY_CLAIM } from "./index.js";

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

export type ControlAction = "pause" | "resume" | "revoke" | "close";

export type ControlRoomInput = {
  campaign: string;
  state: CampaignState;
  budget: BudgetView;
  returnedEth?: string;
};

export type ControlRoomView = {
  campaign: string;
  state: CampaignState;
  stateNote: string;
  availableActions: ControlAction[];
  terminal: boolean;
  budget: BudgetView;
  returnedEth?: string;
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
  return {
    campaign: input.campaign,
    state: input.state,
    stateNote: STATE_NOTES[input.state] ?? "Complete the setup journey to activate.",
    availableActions: ACTIONS_BY_STATE[input.state],
    terminal: TERMINAL_STATES.includes(input.state),
    budget: input.budget,
    ...(input.returnedEth === undefined ? {} : { returnedEth: input.returnedEth }),
    privacyNote: FLEET_PRIVACY_CLAIM,
  };
}

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
