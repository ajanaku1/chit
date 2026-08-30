import assert from "node:assert/strict";
import test from "node:test";

import { FLEET_PRIVACY_CLAIM } from "../src/fleet/index.js";
import { buildBuyReport, type AccountBuyResult } from "../src/fleet/control-room.js";

const owner = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;

const results: AccountBuyResult[] = [
  { account: owner(1), status: "sponsored", budget: { funded: "1000", reserved: "0", spent: "120", unused: "880" } },
  { account: owner(2), status: "sponsored", budget: { funded: "1000", reserved: "0", spent: "240", unused: "760" } },
  { account: owner(3), status: "rejected", budget: { funded: "1000", reserved: "0", spent: "240", unused: "760" } },
];

test("the buy report aggregates sponsored and rejected counts and the final budget", () => {
  const report = buildBuyReport(results);
  assert.equal(report.sponsored, 2);
  assert.equal(report.rejected, 1);
  assert.equal(report.budget.spent, "240");
  assert.equal(report.budget.unused, "760");
  assert.equal(report.rows.length, 3);
  assert.deepEqual(report.rows.map((row) => row.account), [owner(1), owner(2), owner(3)]);
});

test("an empty result set reports zeros instead of failing", () => {
  const report = buildBuyReport([]);
  assert.equal(report.sponsored, 0);
  assert.equal(report.rejected, 0);
  assert.deepEqual(report.budget, { funded: "0", reserved: "0", spent: "0", unused: "0" });
});

test("the report carries the narrow privacy claim and never an overclaim", () => {
  const report = buildBuyReport(results);
  assert.equal(report.privacyNote, FLEET_PRIVACY_CLAIM);
  for (const banned of ["unlinkab", "anonymous", "untraceable"]) {
    assert.equal(report.privacyNote.toLowerCase().includes(banned), false);
  }
});

test("the report is built from public facts only", () => {
  const serialized = JSON.stringify(buildBuyReport(results));
  assert.equal(serialized.includes("privateKey"), false);
  assert.equal(serialized.includes("signature"), false);
});
