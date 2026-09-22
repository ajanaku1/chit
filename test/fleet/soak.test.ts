import assert from "node:assert/strict";
import test from "node:test";

import { SOAK_MS, UNRECORDED_LIMIT_SECONDS, soakVerdict, type Sample } from "../../src/fleet/soak.js";

/**
 * T088's predicate (FR-039, SC-004). The soak is a claim about forty-eight
 * hours, so the verdict is about a run of samples: long enough, unbroken,
 * nothing unrecorded past four hours, the pool whole and running.
 */

const START = Date.parse("2026-09-23T00:00:00.000Z");
const ok = (i: number, over: Partial<Sample> = {}): Sample => ({
  at: new Date(START + i * 10 * 60_000).toISOString(),
  chainTime: 1_700_000_000 + i * 600,
  blockNumber: 1000 + i,
  unposted: 0,
  oldestUnpostedSeconds: 0,
  paused: false,
  whole: true,
  operatorWei: "200000000000000000",
  ...over,
});

/** Forty-eight hours at ten minutes apart, inclusive of both ends. */
const fullRun = (over: (i: number) => Partial<Sample> = () => ({})): Sample[] =>
  Array.from({ length: SOAK_MS / (10 * 60_000) + 1 }, (_, i) => ok(i, over(i)));

test("a full, quiet run passes", () => {
  const v = soakVerdict(fullRun());
  assert.equal(v.pass, true, v.faults.join("; "));
  assert.equal(v.spanMs, SOAK_MS);
  assert.equal(v.worstUnpostedSeconds, 0);
});

test("a charge unposted past four hours fails it, and the fault names when it was first seen", () => {
  const v = soakVerdict(fullRun((i) => (i === 100 ? { unposted: 1, oldestUnpostedSeconds: UNRECORDED_LIMIT_SECONDS + 60 } : {})));
  assert.equal(v.pass, false);
  assert.match(v.faults.join(" "), /unrecorded for 4\.0 h, past the 4 h bound, first seen at 2026-09-23T16:40/);
});

test("exactly four hours is inside the bound; a second past it is not", () => {
  assert.equal(soakVerdict(fullRun((i) => (i === 5 ? { oldestUnpostedSeconds: UNRECORDED_LIMIT_SECONDS } : {}))).pass, true);
  assert.equal(soakVerdict(fullRun((i) => (i === 5 ? { oldestUnpostedSeconds: UNRECORDED_LIMIT_SECONDS + 1 } : {}))).pass, false);
});

test("a run that stops short of forty-eight hours does not pass, however quiet it was", () => {
  const v = soakVerdict(fullRun().slice(0, 100));
  assert.equal(v.pass, false);
  assert.match(v.faults.join(" "), /covers 16\.5 h, short of the 48 h/);
});

test("silence is not success: a gap the sampler did not cover fails the run", () => {
  const run = fullRun();
  run.splice(50, 6); // an hour with nothing watched
  const v = soakVerdict(run);
  assert.equal(v.pass, false);
  assert.match(v.faults.join(" "), /70 min of silence between samples: an unwatched hour is not a soaked hour/);
  assert.equal(v.worstGapMs, 70 * 60_000);
});

test("a pause during the soak ends it: the trigger is accounted for, resumed, and soaked again", () => {
  const v = soakVerdict(fullRun((i) => (i === 3 ? { paused: true } : {})));
  assert.equal(v.pass, false);
  assert.match(v.faults.join(" "), /paused at .*: account for the trigger, resume, and soak again/);
});

test("a pool holding less than it owes fails the run", () => {
  const v = soakVerdict(fullRun((i) => (i === 7 ? { whole: false } : {})));
  assert.equal(v.pass, false);
  assert.match(v.faults.join(" "), /held less than it owed/);
});

test("no samples is a failure, not an empty pass", () => {
  const v = soakVerdict([]);
  assert.equal(v.pass, false);
  assert.deepEqual(v.faults, ["no samples: the soak never ran"]);
});
