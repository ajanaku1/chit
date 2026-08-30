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
