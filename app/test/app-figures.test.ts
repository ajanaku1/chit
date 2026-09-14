import assert from "node:assert/strict";
import test from "node:test";

import { balanceDelta, capShare, capUsed, countFrame, DRAW_CAP, drawShare, freshPoolStatus, fundingProgress, poolStatus, TRADER_CAP } from "../src/fleet/balance.js";
import { confirmationFor, isLiveState } from "../src/fleet/control-room.js";

test("the status pill says nothing until the pool's state has been read", () => {
  assert.equal(poolStatus(undefined), undefined);
});

test("a paused pool is never shown as live", () => {
  assert.deepEqual(poolStatus({ pool: { paused: true } }), { text: "Pool paused by the operator", live: false });
});

test("a readable, unpaused pool is live on testnet 46630", () => {
  assert.deepEqual(poolStatus({ pool: { paused: false } }), { text: "Pool live · testnet 46630", live: true });
});

test("the headroom meter shows how much of the 0.5 ETH limit is taken", () => {
  assert.equal(capShare(TRADER_CAP, TRADER_CAP), 0);
  assert.equal(capShare("450000000000000000", TRADER_CAP), 0.1);
  assert.equal(capShare("0", TRADER_CAP), 1);
});

test("the balance change is measured against what this page last showed", () => {
  assert.equal(balanceDelta(undefined, "50000000000000000"), undefined, "no history, no change");
  assert.equal(balanceDelta("50000000000000000", "50000000000000000"), undefined);
  assert.deepEqual(balanceDelta("0", "50000000000000000"), { up: true, eth: "0.05" });
  assert.deepEqual(balanceDelta("50000000000000000", "30000000000000000"), { up: false, eth: "0.02" });
});

test("the headroom note never reads below zero, even if the contract reports more room than the cap", () => {
  assert.equal(capUsed("450000000000000000", TRADER_CAP), "50000000000000000");
  assert.equal(capUsed(TRADER_CAP, TRADER_CAP), "0");
  assert.equal(capUsed("600000000000000000", TRADER_CAP), "0");
});

test("the funding gauge measures the wait against its 15-minute ceiling", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  assert.equal(fundingProgress("2026-09-14T12:15:00Z", now), 0);
  assert.equal(fundingProgress("2026-09-14T12:07:30Z", now), 0.5);
  assert.equal(fundingProgress("2026-09-14T11:59:00Z", now), 1);
  assert.equal(fundingProgress("not a date", now), 0);
});

test("the draw meter fills against the 0.2 ETH cap and stops there", () => {
  assert.equal(drawShare("20000000000000000"), 0.1);
  assert.equal(drawShare(DRAW_CAP), 1);
  assert.equal(drawShare("300000000000000000"), 1);
});

test("only actions that cannot be undone ask for confirmation", () => {
  assert.ok(confirmationFor("revoke"));
  assert.ok(confirmationFor("close"));
  for (const action of ["pause", "resume", "topUp"] as const) assert.equal(confirmationFor(action), undefined);
  assert.match(confirmationFor("revoke")!.body, /cannot be resumed/);
});

test("the balance lands on its exact figure, never a rounded one", () => {
  assert.equal(countFrame(0.049979, 0.049979, "0.049979"), "0.049979");
  assert.equal(countFrame(0.02, 0.049979, "0.049979"), "0.020000", "mid-count frames keep the final figure's width");
  assert.equal(countFrame(1, 1, "1"), "1");
});

test("the pool pill speaks only from a read young enough to trust", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  const read = { pool: { paused: false } };
  assert.equal(freshPoolStatus(undefined, now), undefined);
  assert.deepEqual(freshPoolStatus({ ...read, savedAt: now.getTime() - 60_000 }, now), { text: "Pool live · testnet 46630", live: true });
  assert.equal(freshPoolStatus({ ...read, savedAt: now.getTime() - 11 * 60_000 }, now), undefined, "a stale read must not say live");
  assert.equal(freshPoolStatus(read, now), undefined, "a read with no time on it is not fresh");
});

test("only a running or funding fleet carries the live dot", () => {
  assert.equal(isLiveState("Active"), true);
  assert.equal(isLiveState("Activating"), true);
  for (const state of ["Paused", "Revoked", "Closed", "Depleted", "Expired", "Pending service"]) assert.equal(isLiveState(state), false);
});
