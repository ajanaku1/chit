import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { drawIssue, fundingWait, pollDelayMs, stateLabel } from "../src/fleet/balance.js";

/**
 * The activate step spends a trader's balance, and the wait that follows is the
 * privacy. Both must be explained honestly on the page rather than looking like
 * the app has stalled.
 */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const eth = (whole: string): string => {
  const [int, frac = ""] = whole.split(".");
  return `${BigInt(int!)}${frac.padEnd(18, "0")}`.replace(/^0+(?=\d)/, "");
};

test("refuses a draw the balance cannot cover, and points at the balance", () => {
  const issue = drawIssue(eth("0.02"), eth("0.01"));
  assert.match(issue ?? "", /balance/i);
});

test("refuses a draw over the per-campaign cap", () => {
  assert.match(drawIssue(eth("0.3"), eth("5")) ?? "", /0\.2 ETH/);
});

test("refuses an empty or malformed draw", () => {
  assert.ok(drawIssue("", eth("1")));
  assert.ok(drawIssue("0", eth("1")));
  assert.ok(drawIssue("abc", eth("1")));
});

test("accepts a draw within both the cap and the balance", () => {
  assert.equal(drawIssue(eth("0.02"), eth("0.1")), undefined);
  assert.equal(drawIssue(eth("0.2"), eth("0.5")), undefined);
});

test("describes the wait as a range, not a spinner", () => {
  const now = new Date("2026-09-07T12:00:00Z");
  const waiting = fundingWait("2026-09-07T12:07:00.000Z", now);
  assert.equal(waiting.ready, false);
  assert.match(waiting.message, /7 minutes|minutes/i);
  assert.match(waiting.message, /wait|delay|deliberate|privacy/i);

  const ready = fundingWait("2026-09-07T11:58:00.000Z", now);
  assert.equal(ready.ready, true);
});

test("shows the trader a state they can act on, not the internal name", () => {
  assert.equal(stateLabel("Activating"), "Funding your fleet");
  assert.equal(stateLabel("Active"), "Active");
  assert.equal(stateLabel("Awaiting funding"), "Ready to activate");
  assert.equal(stateLabel("Awaiting recovery confirmation"), "Awaiting backup confirmation");
});

test("the wizard asks for a draw and explains the wait", async () => {
  const html = await readFile(join(appRoot, "fleet.html"), "utf8");
  assert.match(html, /id="a-draw"/, "the activate step asks how much of the balance to commit");
  assert.match(html, /id="funding-wait"/, "the wait has somewhere to speak");
  assert.doesNotMatch(html, /No trail back to you/i, "that claim is not true until the pool is live");
});

/**
 * While a fleet is being funded the trader's own open page is what drives the
 * work: every poll is a request, and every request sweeps. Without this the
 * fleet waits for a schedule instead of for its own deadline.
 */

test("polls while a fleet is being funded, and stops once it is", () => {
  const now = new Date("2026-09-09T12:00:00Z");
  const soon = "2026-09-09T12:04:00.000Z";

  const waiting = pollDelayMs("Activating", soon, now);
  assert.ok(waiting !== undefined && waiting > 0, "a waiting fleet keeps checking");
  assert.ok(waiting! <= 30_000, "and checks often enough to fund near its deadline");

  assert.equal(pollDelayMs("Active", soon, now), undefined, "a funded fleet stops polling");
  assert.equal(pollDelayMs("Closed", soon, now), undefined);
  assert.equal(pollDelayMs("Revoked", soon, now), undefined);
});

test("keeps polling past the deadline, because the sweep is what finishes it", () => {
  const now = new Date("2026-09-09T12:10:00Z");
  const passed = "2026-09-09T12:04:00.000Z";
  const delay = pollDelayMs("Activating", passed, now);
  assert.ok(delay !== undefined && delay > 0, "due but not yet funded still needs a request");
  assert.ok(delay! <= 15_000, "and a prompt one");
});

test("polls even when the due time is unknown", () => {
  assert.ok(pollDelayMs("Activating", undefined, new Date()) !== undefined);
});
