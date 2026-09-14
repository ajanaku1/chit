import assert from "node:assert/strict";
import test from "node:test";

import { poolStatus } from "../src/fleet/balance.js";

test("the status pill says nothing until the pool's state has been read", () => {
  assert.equal(poolStatus(undefined), undefined);
});

test("a paused pool is never shown as live", () => {
  assert.deepEqual(poolStatus({ pool: { paused: true } }), { text: "Pool paused by the operator", live: false });
});

test("a readable, unpaused pool is live on testnet 46630", () => {
  assert.deepEqual(poolStatus({ pool: { paused: false } }), { text: "Pool live · testnet 46630", live: true });
});
