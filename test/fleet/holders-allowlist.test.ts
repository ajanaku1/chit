import assert from "node:assert/strict";
import { test } from "node:test";

import { createHoldersGate } from "../../src/fleet/bot-holders.js";
import { createQuote } from "../../src/fleet/eligibility.js";
import { holderAllowlistFrom } from "../../src/fleet/holders-allowlist.js";
import type { Address } from "../../src/fleet/types.js";

/**
 * The founder, 2026-10-04: some wallets use the mainnet beta without holding
 * 100,000 $CHIT. CHIT_HOLDER_ALLOWLIST names them; the web app's quote and the
 * bot's line both let them through. Nothing else about them changes.
 */
const A = "0x48a03c7d6AB2E16dC554FDd5dA9bC2B81CD9F9C9";
const B = "0xb94d92d8c497efa6fcd672dae00aedf6651c7bea";

test("the list: comma or whitespace separated, any case, one entry once; an entry that is not an address is left out and named", () => {
  const warned: string[] = [];
  const list = holderAllowlistFrom(`${A}, ${B}\n${B.toUpperCase().replace("0X", "0x")} nope`, (w) => warned.push(w));
  assert.deepEqual([...list].sort(), [A.toLowerCase(), B].sort());
  assert.deepEqual(warned, ["nope"]);
  assert.equal(holderAllowlistFrom(undefined).size, 0, "unset is nobody");
});

test("the web app's quote: a listed wallet is eligible whatever it holds; the holdings it shows are still its own", () => {
  const config = { threshold: (100_000n * 10n ** 18n).toString(), baseFee: "0", discount: "0", feeAsset: "ETH" as const, recipient: "0x00000000000000000000000000000000000000fe" };
  assert.equal(createQuote(config, "0", "q", false).eligible, false);
  const listed = createQuote(config, "0", "q", true);
  assert.equal(listed.eligible, true);
  assert.equal(listed.holdings, "0", "not dressed up as a holder");
});

test("the bot's line: a listed owner passes without a balance read; anyone else is read as before", async () => {
  let reads = 0;
  const gate = createHoldersGate({ balanceOf: async () => { reads++; return 0n; }, threshold: 1n, allowlist: holderAllowlistFrom(A) });
  assert.deepEqual(await gate(A.toLowerCase() as Address), { ok: true });
  assert.equal(reads, 0, "no read for a listed wallet");
  assert.equal((await gate(B as Address)).ok, false);
  assert.equal(reads, 1);
});
