/**
 * Set up's live panel: the fleet policy as the trader builds it, one row per
 * commitment, in the order the wizard asks for them. Pure, so the panel's
 * wording is tested without a browser; the page only paints these rows.
 */

import { DRAW_CAP, toEth } from "./balance.js";

export type PolicyInput = {
  wallet: string | undefined;
  wallets: number;
  budgetEth: string;
  days: number;
  /** The size step was accepted, not merely typed into. */
  sized: boolean;
  backup: "none" | "saved" | "verified";
  drawEth: string;
  launched: boolean;
  /** The service's own words about the funding wait, once a fleet is launched. */
  funding: { message: string; done: boolean } | undefined;
};

export type PolicyRow = { key: "wallet" | "size" | "backup" | "draw" | "funding"; value: string; done: boolean };

const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

const DURATIONS: Record<number, string> = { 1: "1 day", 7: "1 week", 30: "1 month" };

const BACKUP: Record<PolicyInput["backup"], string> = {
  none: "Not saved yet",
  saved: "Saved. Prove it opens.",
  verified: "Saved, and it opens",
};

export const policyRows = (input: PolicyInput): PolicyRow[] => [
  { key: "wallet", value: input.wallet ? shortAddress(input.wallet) : "Not connected", done: input.wallet !== undefined },
  {
    key: "size",
    value: `${input.wallets} wallets · ${input.budgetEth.trim() || "0"} ETH gas · ${DURATIONS[input.days] ?? `${input.days} days`}`,
    done: input.sized,
  },
  { key: "backup", value: BACKUP[input.backup], done: input.backup === "verified" },
  { key: "draw", value: `${input.drawEth.trim() || "0"} of ${toEth(DRAW_CAP)} ETH`, done: input.launched },
  { key: "funding", value: input.funding?.message ?? "1–15 min after launch", done: input.funding?.done ?? false },
];

/** The row the trader is on: the first one not yet done. */
export const currentRow = (rows: PolicyRow[]): PolicyRow["key"] | undefined => rows.find((row) => !row.done)?.key;
