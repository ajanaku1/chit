import assert from "node:assert/strict";
import test from "node:test";

import { currentRow, policyRows, type PolicyInput } from "../src/fleet/policy.js";

const fresh: PolicyInput = {
  wallet: undefined,
  wallets: 5,
  budgetEth: "0.001",
  days: 7,
  sized: false,
  backup: "none",
  drawEth: "0.02",
  launched: false,
  funding: undefined,
};

test("the live policy starts empty and asks for the wallet first", () => {
  const rows = policyRows(fresh);
  assert.deepEqual(rows.map((row) => row.key), ["wallet", "size", "backup", "draw", "funding"]);
  assert.equal(rows[0]!.value, "Not connected");
  assert.equal(currentRow(rows), "wallet");
  assert.ok(rows.every((row) => !row.done));
});

test("each row fills in as the trader commits to it", () => {
  const rows = policyRows({ ...fresh, wallet: "0xa5a70000000000000000000000000000000f4265", wallets: 10, days: 30, sized: true, backup: "saved" });
  assert.equal(rows[0]!.value, "0xa5a7…4265");
  assert.equal(rows[1]!.value, "10 wallets · 0.001 ETH gas · 1 month");
  assert.equal(rows[2]!.value, "Saved. Prove it opens.");
  assert.equal(currentRow(rows), "backup", "a backup nobody has opened is not done");
});

test("the draw is measured against the per-fleet cap, and funding reads the service's own words", () => {
  const ready = { ...fresh, wallet: "0xa5a70000000000000000000000000000000f4265", sized: true, backup: "verified" as const, launched: true };
  const waiting = policyRows({ ...ready, funding: { message: "Funding in about 7 minutes.", done: false } });
  assert.equal(waiting[3]!.value, "0.02 of 0.2 ETH");
  assert.equal(waiting[4]!.value, "Funding in about 7 minutes.");
  assert.equal(currentRow(waiting), "funding");
  const live = policyRows({ ...ready, funding: { message: "Funded and live.", done: true } });
  assert.equal(currentRow(live), undefined, "nothing is left to do");
});
