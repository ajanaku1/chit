import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { exitView, withdrawRefusal } from "../src/fleet/balance.js";

/** T079: a refused withdrawal shows what happened, says nothing was recorded, and leaves the exit reachable; a paused pool is the same state. */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("the refused state says what happened, that nothing was recorded, and where the exit is; other refusals are not this state", () => {
  const short = withdrawRefusal({ code: "withdrawal_unavailable", reason: "operator_float_short" })!;
  assert.match(short, /^We can't pay this right now\. Try again in a few minutes, or take it out of the pool yourself: that path doesn't need us\./);
  assert.match(short, /Nothing was recorded and nothing is owed/);
  const paused = withdrawRefusal({ paused: true })!;
  assert.match(paused, /^The pool is paused/);
  assert.match(paused, /out of the pool yourself: that path doesn't need us/);
  assert.equal(withdrawRefusal({ code: "state_invalid", reason: "pool_paused" }), paused, "the route's paused refusal is the same state");
  assert.equal(withdrawRefusal({ code: "budget_exceeded" }), undefined, "over the balance is an ordinary refusal, not this state");
  assert.equal(withdrawRefusal({ code: "challenge_invalid" }), undefined);
});

test("the exit stays available whatever the withdrawal said", () => {
  const view = { exit: { requestedAt: "2026-09-21T10:00:00.000Z", amount: "10000000000000000", availableAt: "2026-09-22T10:00:00.000Z" } };
  assert.equal(exitView(view as never, new Date("2026-09-22T11:00:00.000Z")).status, "available");
  assert.equal(exitView({ exit: {} } as never, new Date()).status, "none", "and a fresh one can be started");
});

test("the Balance page carries the refused state beside the withdraw form, hidden until needed, with the exit one tap away", async () => {
  const html = await readFile(join(appRoot, "balance.html"), "utf8");
  assert.match(html, /<div id="withdraw-refused" class="callout" role="alert" hidden>/);
  assert.match(html, /<button id="withdraw-retry" type="button"[^>]*>Try again<\/button>/);
  assert.match(html, /<a class="primary" href="#exit-card">Take it out of the pool yourself<\/a>/);
  assert.ok(html.indexOf('id="withdraw-refused"') < html.indexOf('id="exit-card"'), "the exit card is beneath it");
  const script = await readFile(join(appRoot, "src/balance-page.ts"), "utf8");
  assert.match(script, /showRefusal\(view\.pool\.paused \? withdrawRefusal\(\{ paused: true \}\) : undefined\)/, "a paused pool shows the state before anything is asked");
  assert.match(script, /withdrawRefusal\(\{ code: error\.code/, "a refused payout shows the state instead of a banner");
});
