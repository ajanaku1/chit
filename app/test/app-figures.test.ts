import assert from "node:assert/strict";
import test from "node:test";

import { balanceDelta, capShare, capUsed, poolStatus, TRADER_CAP } from "../src/fleet/balance.js";

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
