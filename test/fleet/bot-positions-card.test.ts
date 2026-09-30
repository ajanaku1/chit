import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEther } from "viem";

import type { BotChain } from "../../src/fleet/bot-chain.js";
import { positionsCard } from "../../src/fleet/bot-positions-card.js";
import { MemoryPositionLedger, type BotTrade } from "../../src/fleet/bot-positions.js";
import type { Address, Hex } from "../../src/fleet/types.js";

const ACCOUNT = "0xbb3F1c33923562E5BaEF9D7AA6FF4bFeD3417965" as Address;
const PEPE = "0x00000000000000000000000000000000000000c1" as Address;
const GIFT = "0x00000000000000000000000000000000000000c2" as Address;
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const UNIT = 10n ** 18n;

/** PEPE: bought 0.01 ETH for 1 000 tokens, now worth 0.015 for all; GIFT: never bought, sent in. */
const isPepe = (t: Address): boolean => t.toLowerCase() === PEPE;
const reads = {
  async tokenInfo(t: Address) { return { symbol: isPepe(t) ? "PEPE" : "GIFT", decimals: 18, hasPool: true }; },
  async tokenBalance(t: Address) { return isPepe(t) ? 1_000n * UNIT : 500n * UNIT; },
  async quoteSell(t: Address, units: bigint) { return isPepe(t) ? (units * parseEther("0.015")) / (1_000n * UNIT) : parseEther("0.002"); },
  async ethBalance() { return parseEther("0.008"); },
} as unknown as BotChain;

const ledgerWith = async (...trades: BotTrade[]) => { const l = new MemoryPositionLedger(); for (const t of trades) await l.note(t); return l; };
const buy = (n: number, token: Address, eth: string): BotTrade => ({ hash: h(n), account: ACCOUNT, token, side: "buy", ethWei: parseEther(eth), asked: 0n, units: null, at: new Date(n * 1000).toISOString() });

test("positions list what the account holds, each with its value as a sell now would return it and its P&L against the average price the bot's buys paid, settled from the receipts first", async () => {
  const ledger = await ledgerWith(buy(1, PEPE, "0.01"));
  const settle = async () => ({ status: "success" as const, received: 1_000n * UNIT });
  const card = await positionsCard({ ledger, settle, reads }, ACCOUNT, { unit: "eth" });
  assert.equal(card.text, [
    "📊 <b>your positions</b> · account <code>0xbb3F…7965</code>",
    "",
    "<b>PEPE</b> <code>1000</code> · ≈ <code>0.015 ETH</code> · P&amp;L <code>+0.005 ETH</code> (+50%)",
    "",
    "total ≈ <code>0.015 ETH</code> · P&amp;L <code>+0.005 ETH</code> · plus <code>0.008 ETH</code> in the account",
    "<i>values are what selling now would return, after the pool's fee. P&amp;L is against the average price your buys through the bot paid.</i>",
  ].join("\n"));
  assert.deepEqual(card.tokens, [{ token: PEPE, symbol: "PEPE" }]);
});

test("a holding the bot did not buy shows its value and 'cost unknown'; an account with nothing says how to start", async () => {
  const ledger = await ledgerWith({ ...buy(2, GIFT, "0"), side: "sell", asked: 1n, units: 1n });
  const card = await positionsCard({ ledger, reads }, ACCOUNT, { unit: "eth" });
  assert.match(card.text, /<b>GIFT<\/b> <code>500<\/code> · ≈ <code>0\.002 ETH<\/code> · cost unknown/);
  const empty = await positionsCard({ ledger: new MemoryPositionLedger(), reads }, ACCOUNT, { unit: "eth" });
  assert.match(empty.text, /no positions yet\. paste a token's contract address to see its card and buy\./);
  assert.deepEqual(empty.tokens, []);
});

test("in dollars, every ETH figure is shown at the price given, two decimals", async () => {
  const ledger = await ledgerWith({ ...buy(1, PEPE, "0.01"), units: 1_000n * UNIT });
  const card = await positionsCard({ ledger, reads }, ACCOUNT, { unit: "usd", usdPerEth: 2000 });
  assert.match(card.text, /<b>PEPE<\/b> <code>1000<\/code> · ≈ <code>\$30\.00<\/code> · P&amp;L <code>\+\$10\.00<\/code> \(\+50%\)/);
  assert.match(card.text, /total ≈ <code>\$30\.00<\/code> · P&amp;L <code>\+\$10\.00<\/code> · plus <code>\$16\.00<\/code> in the account/);
  assert.match(card.text, /at <code>\$2,000\.00<\/code> per ETH/);
});

test("holdings the account had before the record began are found on chain and shown with their value and 'cost unknown'; one with no ETH pool to sell into is left out", async () => {
  const SPAM = "0x00000000000000000000000000000000000000c3" as Address;
  const withSpam = { ...reads, async quoteSell(t: Address, u: bigint) { return t.toLowerCase() === SPAM ? null : (reads as unknown as { quoteSell: (t: Address, u: bigint) => Promise<bigint> }).quoteSell(t, u); } } as unknown as BotChain;
  const card = await positionsCard({ ledger: new MemoryPositionLedger(), reads: withSpam, heldTokens: async () => [GIFT, SPAM] }, ACCOUNT, { unit: "eth" });
  assert.match(card.text, /<b>GIFT<\/b> <code>500<\/code> · ≈ <code>0\.002 ETH<\/code> · cost unknown/);
  assert.doesNotMatch(card.text, /c3|GIFT.*GIFT/s, "the spam token is not listed, and GIFT once");
  assert.deepEqual(card.tokens.map((t) => t.token), [GIFT]);
});
