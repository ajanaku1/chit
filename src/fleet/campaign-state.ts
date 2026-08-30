/**
 * Campaign lifecycle (FR-012 to FR-016).
 *
 * Two properties matter more than the table itself. Revoked is terminal for
 * sponsorship, so it refuses resume and session-key rotation rather than
 * silently doing nothing (FR-013). And every forward step is idempotent, so a
 * reload or a retry re-runs a completed step without creating a second fleet,
 * session key, or funding reservation (FR-014).
 */

import type { CampaignState } from "./types.js";

export const TERMINAL_STATES = ["Revoked", "Depleted", "Expired", "Closed"] as const;

export type CampaignEvent =
  | "requestRecovery"
  | "confirmRecovery"
  | "fund"
  | "activate"
  | "pause"
  | "resume"
  | "revoke"
  | "deplete"
  | "expire"
  | "close"
  | "rotateSessionKey";

type Rule = {
  /** States the event may be applied from. */
  from: readonly CampaignState[];
  /** The resulting state, or `null` when the event does not move the campaign. */
  to: CampaignState | null;
  /** States in which this event's effect already holds, making it a no-op. */
  satisfiedBy: readonly CampaignState[];
};

const RULES: Record<CampaignEvent, Rule> = {
  requestRecovery: {
    from: ["Draft"],
    to: "Awaiting recovery confirmation",
    satisfiedBy: ["Awaiting recovery confirmation", "Awaiting funding", "Activating", "Active"],
  },
  confirmRecovery: {
    from: ["Awaiting recovery confirmation"],
    to: "Awaiting funding",
    satisfiedBy: ["Awaiting funding", "Activating", "Active"],
  },
  fund: { from: ["Awaiting funding"], to: "Activating", satisfiedBy: ["Activating", "Active"] },
  activate: { from: ["Activating"], to: "Active", satisfiedBy: ["Active"] },
  pause: { from: ["Active"], to: "Paused", satisfiedBy: ["Paused"] },
  resume: { from: ["Paused"], to: "Active", satisfiedBy: ["Active"] },
  revoke: { from: ["Active", "Paused"], to: "Revoked", satisfiedBy: ["Revoked"] },
  deplete: { from: ["Active", "Paused"], to: "Depleted", satisfiedBy: ["Depleted"] },
  expire: { from: ["Active", "Paused"], to: "Expired", satisfiedBy: ["Expired"] },
  close: {
    from: ["Active", "Paused", "Revoked", "Depleted", "Expired"],
    to: "Closed",
    satisfiedBy: ["Closed"],
  },
  rotateSessionKey: { from: ["Active", "Paused"], to: null, satisfiedBy: [] },
};

/** Events a revoked campaign still accepts. Everything else is refused outright. */
const ALLOWED_AFTER_REVOKE: readonly CampaignEvent[] = ["revoke", "close"];

/** How each refused event names itself in a post-revocation rejection. */
const REVOKED_REASON: Partial<Record<CampaignEvent, string>> = { rotateSessionKey: "rotate" };

export class CampaignStateError extends Error {
  readonly code: "state_invalid" | "revoked_terminal";
  readonly reason: string;

  constructor(code: "state_invalid" | "revoked_terminal", reason: string) {
    super(`${code}: ${reason}`);
    this.name = "CampaignStateError";
    this.code = code;
    this.reason = reason;
  }
}

export const isTerminal = (state: CampaignState): boolean =>
  (TERMINAL_STATES as readonly string[]).includes(state);

/** Only an Active campaign sponsors; pause, revocation, depletion, expiry, and closure all block it (FR-015). */
export const canSponsor = (state: CampaignState): boolean => state === "Active";

/** A revoked or closed campaign can never rotate its session key (FR-013). */
export const canRotateSessionKey = (state: CampaignState): boolean =>
  RULES.rotateSessionKey.from.includes(state);

export const transition = (state: CampaignState, event: CampaignEvent): CampaignState => {
  const rule = RULES[event];
  if (rule.satisfiedBy.includes(state)) return state;

  if (state === "Revoked" && !ALLOWED_AFTER_REVOKE.includes(event)) {
    throw new CampaignStateError("revoked_terminal", `${REVOKED_REASON[event] ?? event}_after_revoke`);
  }

  if (!rule.from.includes(state)) {
    throw new CampaignStateError("state_invalid", `${event}_not_allowed_from:${state}`);
  }

  return rule.to ?? state;
};
