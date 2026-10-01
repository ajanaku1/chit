import assert from "node:assert/strict";
import { test } from "node:test";

import { createHoldersGate, holdersRefusal } from "../../src/fleet/bot-holders.js";
import type { Address } from "../../src/fleet/types.js";

const OWNER = "0x2e505f96e8cb455523327de14b5493d82214e91d" as Address;
const LINE = 100_000n * 10n ** 18n;

test("a wallet at or over the line passes; under it, the answer says what it holds and what it takes", async () => {
  const gate = createHoldersGate({ balanceOf: async () => LINE, threshold: LINE });
  assert.deepEqual(await gate(OWNER), { ok: true });
  const under = createHoldersGate({ balanceOf: async () => 12_000n * 10n ** 18n, threshold: LINE });
  assert.deepEqual(await under(OWNER), { ok: false, holds: 12_000n * 10n ** 18n, need: LINE });
});

test("a pass is remembered five minutes, a refusal one, so a wallet that just bought gets in quickly; a failed read is a refusal, never a pass", async () => {
  let held = 0n, reads = 0, t = 0;
  const gate = createHoldersGate({ balanceOf: async () => { reads++; return held; }, threshold: LINE, now: () => t });
  assert.equal((await gate(OWNER)).ok, false);
  held = LINE;
  t += 30_000;
  assert.equal((await gate(OWNER)).ok, false, "the refusal is remembered for a minute");
  t += 31_000;
  assert.equal((await gate(OWNER)).ok, true, "then read again");
  held = 0n;
  t += 4 * 60_000;
  assert.equal((await gate(OWNER)).ok, true, "a pass is remembered for five minutes");
  assert.equal(reads, 2);
  const broken = createHoldersGate({ balanceOf: async () => { throw new Error("rpc down"); }, threshold: LINE });
  assert.equal((await broken(OWNER)).ok, false);
});

test("the refusal names the wallet, what it holds and the line, and says the account stays theirs", () => {
  assert.equal(
    holdersRefusal(OWNER, 12_000n * 10n ** 18n, LINE),
    "the bot is for $CHIT holders during the beta. your wallet <code>0x2e50…e91d</code> holds <code>12,000</code> $CHIT; the line is <code>100,000</code>. your account and its tokens stay yours: you can still sell here, or withdraw on the Sessions page.",
  );
});

/**
 * Found 2026-10-01: the founder's DCA waited with "your wallet holds less $CHIT
 * than the beta's line" while the wallet held 104,614. The balance read failed
 * on the server and the bot's read turned the failure into 0. A failed read is
 * now "unknown": still never a pass, never remembered, and said as what it is.
 */
test("a failed read is unknown, not a balance of 0: never a pass, never remembered, so the next ask reads again", async () => {
  let fail = true, reads = 0;
  const gate = createHoldersGate({ balanceOf: async () => { reads++; if (fail) throw new Error("429"); return LINE; }, threshold: LINE });
  assert.deepEqual(await gate(OWNER), { ok: false, unknown: true });
  fail = false;
  assert.deepEqual(await gate(OWNER), { ok: true }, "read again at once, and passes");
  assert.equal(reads, 2);
});
