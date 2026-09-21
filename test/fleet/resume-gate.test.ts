import assert from "node:assert/strict";
import test from "node:test";
import { parseEther } from "viem";

import { identityHolds, owedToDepositors, poolIsWhole, shortfall, type PoolCounters } from "../../src/fleet/pool-solvency.js";
import { resumeGate, type IncidentRecord } from "../../src/fleet/resume-gate.js";

/** T051, T052: the resume gate refuses while any condition is unmet, and what "whole" means from public views. */

const whole: PoolCounters = {
  // Two depositors put in 0.1 each; one was charged 0.03 and left with 0.07; 0.02 of outflow was charged to the other.
  everDeposited: parseEther("0.2"), totalDeposited: parseEther("0.1"), exitsPaid: parseEther("0.07"),
  totalPosted: parseEther("0.05"), totalOutflow: parseEther("0.02"), totalClaimed: 0n, donated: 0n,
  balance: parseEther("0.2") - parseEther("0.02") - parseEther("0.07"),
};
const incident: IncidentRecord = { id: "2026-09-21-charge-expired", trigger: "charge-expired", cause: "the sweep missed a window", fixedIn: "0921f71", test: "fixed_M3a", publishedAt: "the group, 2026-09-21" };
const exists = (name: string) => name === "fixed_M3a";

test("what the pool owes follows from the counters, and whole means it holds it", () => {
  assert.equal(identityHolds(whole), true);
  assert.equal(owedToDepositors(whole), parseEther("0.08"), "0.1 still deposited less the 0.02 charged to its depositor");
  assert.equal(shortfall(whole), 0n);
  assert.equal(poolIsWhole(whole), true);
  // The operator claimed the 0.03 surplus, then 0.02 of outflow expired unposted: the depositor is still owed
  // it and the pool no longer holds it. (While the surplus stands unclaimed it covers the hole, and the pool is whole.)
  const covered: PoolCounters = { ...whole, totalPosted: parseEther("0.03") };
  assert.equal(poolIsWhole(covered), true, "an unclaimed surplus covers an unposted outflow");
  const short: PoolCounters = { ...covered, totalClaimed: parseEther("0.03"), balance: covered.balance - parseEther("0.03") };
  assert.equal(owedToDepositors(short), parseEther("0.1"));
  assert.equal(shortfall(short), parseEther("0.02"));
  assert.equal(poolIsWhole(short), false);
  // A donation of exactly that makes it whole, crediting nobody.
  const donated: PoolCounters = { ...short, donated: parseEther("0.02"), balance: short.balance + parseEther("0.02") };
  assert.equal(poolIsWhole(donated), true);
  // ETH that left without being counted breaks the identity, whatever the balance.
  assert.equal(identityHolds({ ...whole, balance: whole.balance - 1n }), false);
});

test("the gate passes only with a complete record, an existing test, the identity, and no shortfall", () => {
  assert.deepEqual(resumeGate(incident, exists, whole), { ok: true, reasons: [] });
  assert.match(resumeGate(undefined, exists, whole).reasons[0]!, /no incident record/);
  assert.match(resumeGate({ ...incident, cause: "" }, exists, whole).reasons[0]!, /no cause/);
  assert.match(resumeGate({ ...incident, fixedIn: "soon" }, exists, whole).reasons[0]!, /not a commit/);
  assert.match(resumeGate({ ...incident, test: "test_nothing" }, exists, whole).reasons[0]!, /no test named test_nothing/);
  const short: PoolCounters = { ...whole, totalPosted: parseEther("0.03"), totalClaimed: parseEther("0.03"), balance: whole.balance - parseEther("0.03") };
  assert.match(resumeGate(incident, exists, short).reasons[0]!, /short by 20000000000000000 wei/);
  assert.match(resumeGate(incident, exists, { ...whole, balance: whole.balance + 1n }).reasons[0]!, /does not match its counters/);
  const all = resumeGate({ ...incident, publishedAt: "", test: "nope" }, exists, short);
  assert.equal(all.reasons.length, 3, "every reason, not the first");
});
