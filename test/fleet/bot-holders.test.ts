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
