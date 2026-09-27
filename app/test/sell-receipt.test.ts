import assert from "node:assert/strict";
import test from "node:test";

import { saleReceipt, sendingLine } from "../src/fleet/sell-receipt.js";

/**
 * What a depositor is told about a sale (docs/design-sell.md). Found in the
 * first real sale: it went through, but the page said so in one grey line and
 * kept showing the tokens, so the founder sold again. A receipt must say what
 * sold, for how much ETH, where it goes and in how many minutes, and while the
 * sale runs, where the tokens are.
 */

const PAYOUT = "0x96Cb8EB2E349e64bA47b1015890A2fe7584c369B";
const base = { token: "0xb33eb16782776b4d738c0fd643577cb0284db610", payout: PAYOUT, amountIn: "11017069408025320799535" };
const at = Date.parse("2026-09-27T23:00:00Z");

test("a sold sale says what sold, for how much ETH, where it goes, and in how many minutes", () => {
  const r = saleReceipt({ ...base, state: "sold", ethOut: "786502288423078", payoutDueAt: at + 18 * 60_000 + 5_000, saleTx: `0x${"ab".repeat(32)}` }, { symbol: "HEY", now: at, chainId: 4663 });
  assert.equal(r.title, "Sold 11,017.06 HEY for 0.000787 ETH");
  assert.match(r.lines.join(" "), /0x96Cb…369B/);
  assert.match(r.lines.join(" "), /in about 19 minutes/);
  assert.equal(r.link?.href, `https://robinhoodchain.blockscout.com/tx/0x${"ab".repeat(32)}`);
});

test("a payout that is due any moment says so rather than a count of zero", () => {
  const r = saleReceipt({ ...base, state: "sold", ethOut: "1", payoutDueAt: at - 1 }, { symbol: "HEY", now: at, chainId: 4663 });
  assert.match(r.lines.join(" "), /any moment now/);
});

test("a paid sale says it arrived, and links the payout", () => {
  const r = saleReceipt({ ...base, state: "paid", ethOut: "786502288423078", payoutTx: `0x${"cd".repeat(32)}` }, { symbol: "HEY", now: at, chainId: 4663 });
  assert.match(r.title, /Paid: 0\.000787 ETH/);
  assert.equal(r.link?.href, `https://robinhoodchain.blockscout.com/tx/0x${"cd".repeat(32)}`);
});

test("a sale still selling says where the tokens are", () => {
  const r = saleReceipt({ ...base, state: "awaiting" }, { symbol: "HEY", now: at, chainId: 4663 });
  assert.match(r.title, /with Chit's operator/);
});

test("tokens that could not be sold inside the bound say they went to the payout wallet", () => {
  const r = saleReceipt({ ...base, state: "returned", payoutTx: `0x${"ef".repeat(32)}` }, { symbol: "HEY", now: at, chainId: 4663 });
  assert.match(r.title, /returned/i);
  assert.match(r.lines.join(" "), /0x96Cb…369B/);
});

test("no explorer link off the chain whose explorer we know", () => {
  const r = saleReceipt({ ...base, state: "sold", ethOut: "1", payoutDueAt: at, saleTx: `0x${"ab".repeat(32)}` }, { symbol: "HEY", now: at, chainId: 46630 });
  assert.equal(r.link, undefined);
});

test("while sending, the line says where the tokens are going and how many wallets are done", () => {
  assert.equal(sendingLine("HEY", 3, 5), "Sending HEY from your fleet's wallets to Chit's operator: 3 of 5 done.");
});
