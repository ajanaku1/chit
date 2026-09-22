import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { GATE_SENTENCE, formatChit, gateMarkup, gateState } from "../src/fleet/holders-gate.js";
import { drawCapOf, drawIssue, drawShare, launchState, DRAW_CAP } from "../src/fleet/balance.js";

/**
 * T060: the gate's three states, and that a failed balance read shows retry
 * and never rejection. T059: the caps the wizard refuses against are the
 * pool's, and the figures a page states before the pool answers are the
 * target's.
 */

const execute = promisify(execFile);
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const target = { chainName: "Robinhood Chain", buyChitUrl: "https://example.test/buy", testnetUrl: "https://example.test/testnet" };

test("above the threshold the gate is open; below it, closed with what is held and what is needed", () => {
  assert.deepEqual(gateState({ status: 200, body: { eligible: true, holdings: "9", threshold: "1" } }), { state: "open" });
  assert.deepEqual(gateState({ status: 200, body: { eligible: false, holdings: "500000000000000000000", threshold: "1000000000000000000000" } }), { state: "closed", holdings: "500000000000000000000", threshold: "1000000000000000000000" });
  const closed = gateMarkup({ state: "closed", holdings: "500000000000000000000", threshold: "1000000000000000000000" }, target);
  assert.match(closed, /You hold <strong>500 CHIT<\/strong>\. You need <strong>1,000 CHIT<\/strong>\./);
  assert.match(closed, /href="https:\/\/example\.test\/buy"[^>]*>Buy CHIT</);
  assert.match(closed, /href="https:\/\/example\.test\/testnet"[^>]*>Use the free testnet</);
  assert.ok(closed.includes(GATE_SENTENCE), "the gate says once that it controls the interface only (T058)");
  assert.doesNotMatch(closed, /error|rejected|denied/i, "below the line is not an error state");
  const noLinks = gateMarkup({ state: "closed", holdings: "0", threshold: "1000000000000000000000" }, { chainName: "Robinhood Chain", buyChitUrl: "", testnetUrl: "" });
  assert.match(noLinks, /the token address is in the header above/);
  assert.doesNotMatch(noLinks, /<a /);
});

test("a read that failed is unknown: a retry, never a rejection", () => {
  for (const answer of [{ error: "network down" }, { status: 503, body: {} }, { status: 200, body: {} }] as const) {
    const state = gateState(answer);
    assert.equal(state.state, "unknown", JSON.stringify(answer));
    const html = gateMarkup(state, target);
    assert.match(html, /data-gate-retry/, "no retry");
    assert.doesNotMatch(html, /You need|not eligible|rejected|denied/i, "a failed read reads as a rejection");
  }
  assert.equal(gateMarkup({ state: "open" }, target), "", "open renders nothing: through, silently");
  assert.match(gateMarkup({ state: "unknown", reason: "<script>" }, target), /&lt;script&gt;/, "the reason is escaped");
});

test("CHIT figures read as a person would", () => {
  assert.equal(formatChit("1000000000000000000000"), "1,000 CHIT");
  assert.equal(formatChit("500000000000000000"), "0.5 CHIT");
  assert.equal(formatChit("0"), "0 CHIT");
  assert.equal(formatChit("nope"), "an unknown amount of CHIT");
});

test("the wizard refuses a draw against the pool's cap, not a constant, and the meter fills against it (T059)", () => {
  const beta = { caps: { depositor: "100000000000000000", draw: "50000000000000000", pool: "1000000000000000000" } };
  assert.equal(drawCapOf(beta), "50000000000000000");
  assert.equal(drawCapOf(undefined), DRAW_CAP, "a read that predates caps keeps the published testnet number");
  assert.match(drawIssue("60000000000000000", "100000000000000000", drawCapOf(beta))!, /at most 0\.05 ETH/);
  assert.equal(drawIssue("40000000000000000", "100000000000000000", drawCapOf(beta)), undefined);
  assert.equal(drawShare("50000000000000000", drawCapOf(beta)), 1);
  assert.equal(drawShare("25000000000000000", drawCapOf(beta)), 0.5);
  assert.equal(launchState("60000000000000000", "100000000000000000", drawCapOf(beta)).disabled, true);
});

test("a page built for the beta states the beta's draw cap before the pool answers, and the gate's sentence beside the deposit form", async () => {
  const out = await mkdtemp(join(tmpdir(), "chit-caps-"));
  try {
    await execute(process.execPath, [join(appRoot, "build.mjs")], { env: { ...process.env, APP_OUTPUT: `${out}/`, FLEET_CHAIN_ID: "4663" } });
    const balance = await readFile(join(out, "balance.html"), "utf8");
    assert.match(balance, /data-led="0\.05" data-unit="ETH" data-cap="draw">0\.05 ETH/);
    assert.doesNotMatch(balance, /data-cap="draw">0\.2 ETH/);
    assert.match(balance, new RegExp(`<p id="deposit-gate-note" class="fineprint" data-beta-gate-note>${GATE_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "'")}</p>`));
    const fleet = await readFile(join(out, "fleet.html"), "utf8");
    assert.match(fleet, /aria-label="This draw against the 0\.05 ETH cap"/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
