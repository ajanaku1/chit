import assert from "node:assert/strict";
import test from "node:test";

import {
  CampaignStateError,
  TERMINAL_STATES,
  canRotateSessionKey,
  canSponsor,
  isTerminal,
  transition,
} from "../../src/fleet/campaign-state.js";
import { CAMPAIGN_STATES } from "../../src/fleet/types.js";

const rejects = (run: () => unknown, code: "state_invalid" | "revoked_terminal"): string => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof CampaignStateError);
    assert.equal(error.code, code);
    return error.reason;
  }
  return assert.fail(`expected ${code}`);
};

test("the forward path runs Draft to Active in the specified order", () => {
  assert.equal(transition("Draft", "requestRecovery"), "Awaiting recovery confirmation");
  assert.equal(transition("Awaiting recovery confirmation", "confirmRecovery"), "Awaiting funding");
  assert.equal(transition("Awaiting funding", "fund"), "Activating");
  assert.equal(transition("Activating", "activate"), "Active");
});

test("funding and activation cannot skip recovery confirmation", () => {
  assert.equal(rejects(() => transition("Draft", "fund"), "state_invalid"), "fund_not_allowed_from:Draft");
  assert.equal(
    rejects(() => transition("Awaiting recovery confirmation", "fund"), "state_invalid"),
    "fund_not_allowed_from:Awaiting recovery confirmation",
  );
  assert.equal(rejects(() => transition("Awaiting funding", "activate"), "state_invalid"), "activate_not_allowed_from:Awaiting funding");
});

test("replaying a completed forward step is a no-op so reload and retry are safe", () => {
  assert.equal(transition("Awaiting funding", "confirmRecovery"), "Awaiting funding");
  assert.equal(transition("Activating", "fund"), "Activating");
  assert.equal(transition("Active", "activate"), "Active");
  assert.equal(transition("Paused", "pause"), "Paused");
  assert.equal(transition("Revoked", "revoke"), "Revoked");
  assert.equal(transition("Closed", "close"), "Closed");
});

test("pause blocks sponsorship and only Paused may resume", () => {
  assert.equal(transition("Active", "pause"), "Paused");
  assert.equal(transition("Paused", "resume"), "Active");
  assert.ok(canSponsor("Active"));
  for (const state of CAMPAIGN_STATES.filter((entry) => entry !== "Active")) {
    assert.equal(canSponsor(state), false, `${state} must not sponsor`);
  }
  assert.equal(rejects(() => transition("Depleted", "resume"), "state_invalid"), "resume_not_allowed_from:Depleted");
  assert.equal(rejects(() => transition("Expired", "resume"), "state_invalid"), "resume_not_allowed_from:Expired");
});

test("Revoked is terminal for sponsorship and Close is its only remaining action", () => {
  assert.equal(transition("Active", "revoke"), "Revoked");
  assert.equal(transition("Paused", "revoke"), "Revoked");
  assert.equal(transition("Revoked", "close"), "Closed");

  assert.equal(rejects(() => transition("Revoked", "resume"), "revoked_terminal"), "resume_after_revoke");
  assert.equal(rejects(() => transition("Revoked", "rotateSessionKey"), "revoked_terminal"), "rotate_after_revoke");
  assert.equal(rejects(() => transition("Revoked", "pause"), "revoked_terminal"), "pause_after_revoke");
  assert.equal(rejects(() => transition("Revoked", "activate"), "revoked_terminal"), "activate_after_revoke");

  assert.ok(canRotateSessionKey("Active"));
  assert.equal(canRotateSessionKey("Revoked"), false);
  assert.equal(canRotateSessionKey("Closed"), false);
});

test("depletion, expiry, and closure end sponsorship and Closed accepts nothing further", () => {
  assert.equal(transition("Active", "deplete"), "Depleted");
  assert.equal(transition("Paused", "expire"), "Expired");
  for (const state of ["Active", "Paused", "Revoked", "Depleted", "Expired"] as const) {
    assert.equal(transition(state, "close"), "Closed");
  }
  for (const event of ["resume", "pause", "revoke", "activate", "fund"] as const) {
    assert.equal(rejects(() => transition("Closed", event), "state_invalid"), `${event}_not_allowed_from:Closed`);
  }
});

test("the terminal set is exactly Revoked, Depleted, Expired, and Closed", () => {
  assert.deepEqual([...TERMINAL_STATES].sort(), ["Closed", "Depleted", "Expired", "Revoked"]);
  for (const state of CAMPAIGN_STATES) {
    assert.equal(isTerminal(state), (TERMINAL_STATES as readonly string[]).includes(state));
  }
});
