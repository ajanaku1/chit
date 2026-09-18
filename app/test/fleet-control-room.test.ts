import assert from "node:assert/strict";
import test from "node:test";

import { FLEET_PRIVACY_CLAIM } from "../src/fleet/index.js";
import { buildControlRoomView, type ControlRoomInput } from "../src/fleet/control-room.js";

const budget = { funded: "1000", reserved: "0", spent: "240", unused: "760" };

const view = (state: ControlRoomInput["state"], extra: Partial<ControlRoomInput> = {}) =>
  buildControlRoomView({ campaign: "c-1", state, budget, ...extra });

test("each lifecycle state offers exactly its legal actions (FR-012, FR-015)", () => {
  assert.deepEqual(view("Draft").availableActions, []);
  assert.deepEqual(view("Awaiting recovery confirmation").availableActions, []);
  assert.deepEqual(view("Awaiting funding").availableActions, []);
  assert.deepEqual(view("Activating").availableActions, []);
  assert.deepEqual(view("Active").availableActions, ["pause", "revoke", "close"]);
  assert.deepEqual(view("Paused").availableActions, ["resume", "revoke", "close"]);
  assert.deepEqual(view("Depleted").availableActions, ["close"]);
  assert.deepEqual(view("Expired").availableActions, ["close"]);
  assert.deepEqual(view("Closed").availableActions, []);
});

test("Revoked offers close and nothing else (FR-013, SC-010)", () => {
  const revoked = view("Revoked");
  assert.deepEqual(revoked.availableActions, ["close"]);
  assert.equal(revoked.terminal, true);
  assert.match(revoked.stateNote, /cannot resume/i);
  assert.match(revoked.stateNote, /new campaign/i);
});

test("terminal flags match the terminal states", () => {
  for (const state of ["Revoked", "Depleted", "Expired", "Closed"] as const) {
    assert.equal(view(state).terminal, true, state);
  }
  for (const state of ["Active", "Paused", "Draft"] as const) {
    assert.equal(view(state).terminal, false, state);
  }
});

test("the view shows the budget and, when closed, the returned ETH (FR-016)", () => {
  const open = view("Active");
  assert.deepEqual(open.budget, budget);
  assert.equal(open.returnedEth, undefined);

  const closed = view("Closed", { returnedEth: "760" });
  assert.equal(closed.returnedEth, "760");
  assert.match(closed.stateNote, /returned/i);
});

test("every view carries the narrow privacy claim and no overclaim", () => {
  for (const state of ["Active", "Paused", "Revoked", "Closed"] as const) {
    const current = view(state);
    assert.equal(current.privacyNote, FLEET_PRIVACY_CLAIM);
    assert.equal(current.privacyNote.toLowerCase().includes("unlinkab"), false);
  }
});

test("the view is public-fact only and safe to render", () => {
  const serialized = JSON.stringify(view("Active"));
  assert.equal(serialized.includes("privateKey"), false);
  assert.equal(serialized.includes("signature"), false);
});

/**
 * Stage 2 additions: a fleet spends a draw from the trader's balance, so the
 * Control Room must show what this fleet is holding, what closing gives back,
 * and whether the pool itself has stopped.
 */

const draw = {
  amount: "20000000000000000",
  spent: "5000000000000000",
  remaining: "15000000000000000",
  dueAt: "2026-09-08T12:05:00.000Z",
  state: "Funded" as const,
};

const pooled = (over: Partial<ControlRoomInput> = {}): ControlRoomInput => ({
  campaign: "c-1",
  state: "Active",
  budget: { funded: "0", reserved: "0", spent: "0", unused: "0" },
  draw,
  balance: { available: "80000000000000000" },
  pool: { paused: false },
  ...over,
});

test("a pooled campaign reports its draw rather than an escrow budget", () => {
  const view = buildControlRoomView(pooled());
  assert.equal(view.draw?.remaining, "15000000000000000");
  assert.equal(view.balance?.available, "80000000000000000");
});

/**
 * The Control Room showed "Spent 0 ETH, Left 0.005 ETH" in the gas budget
 * right under a strip reading 0.001211 spent and 0.003788 left: the budget was
 * copied from the draw once and never again. A pooled fleet's budget is its draw.
 */
test("a pooled campaign's gas budget is its live draw, so the two cards agree", () => {
  const stale = { funded: draw.amount, reserved: "0", spent: "0", unused: draw.amount };
  const view = buildControlRoomView(pooled({ budget: stale }));
  assert.deepEqual(view.budget, { funded: draw.amount, reserved: "0", spent: draw.spent, unused: draw.remaining });
});

test("closing a pooled campaign promises the balance, not a refund", () => {
  const view = buildControlRoomView(pooled({ state: "Closed", creditedToBalance: "15000000000000000" }));
  assert.equal(view.creditedToBalance, "15000000000000000");
  assert.match(view.stateNote, /balance/i);
  assert.doesNotMatch(view.stateNote, /returned to you/i);
});

test("a depleted pooled campaign can top up instead of only closing", () => {
  const view = buildControlRoomView(pooled({ state: "Depleted" }));
  assert.deepEqual(view.availableActions, ["topUp", "close"]);
  assert.match(view.stateNote, /top up|add more/i);
});

test("a depleted campaign without a pool still only closes", () => {
  const view = buildControlRoomView({
    campaign: "c-1",
    state: "Depleted",
    budget: { funded: "1", reserved: "0", spent: "1", unused: "0" },
  });
  assert.deepEqual(view.availableActions, ["close"]);
});

test("a paused pool is announced, and stops every action that spends", () => {
  const view = buildControlRoomView(pooled({ pool: { paused: true } }));
  assert.equal(view.poolPaused, true);
  assert.match(view.poolNote ?? "", /paused/i);
  assert.deepEqual(view.availableActions, ["pause", "revoke", "close"], "stopping your own fleet still works");
});
