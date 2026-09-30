import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryPositionLedger, costBasis, positionRow, settleTrades, type BotTrade, type TradeReceipt } from "../../src/fleet/bot-positions.js";
import type { Address, Hex } from "../../src/fleet/types.js";

const ACCOUNT = "0x00000000000000000000000000000000000000a1" as Address;
const TOKEN = "0x00000000000000000000000000000000000000c1" as Address;
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const trade = (n: number, side: "buy" | "sell", ethWei: bigint, asked = 0n): BotTrade => ({ hash: h(n), account: ACCOUNT, token: TOKEN, side, ethWei, asked, units: null, at: new Date(n * 1000).toISOString() });

test("a trade is written when sent and settled from its receipt: tokens that arrived for a buy, the units sent for a sell, nothing when reverted, and left open while the chain has no receipt", async () => {
  const ledger = new MemoryPositionLedger();
  for (const t of [trade(1, "buy", 10n), trade(2, "buy", 30n), trade(3, "sell", 0n, 50n), trade(4, "buy", 99n), trade(5, "buy", 7n)]) await ledger.note(t);
  await ledger.note(trade(1, "buy", 999n));
  const receipts: Record<string, TradeReceipt> = {
    [h(1)]: { status: "success", received: 100n },
    [h(2)]: { status: "success", received: 100n },
    [h(3)]: { status: "success", received: 0n },
    [h(4)]: { status: "reverted", received: 0n },
  };
  const settled = await settleTrades(ledger, async (hash) => receipts[hash], await ledger.forAccount(ACCOUNT));
  assert.deepEqual(settled.map((t) => t.units), [100n, 100n, 50n, 0n, null]);
  assert.equal((await ledger.forAccount(ACCOUNT))[0]!.ethWei, 10n, "the same hash twice is one trade, the first");
  assert.deepEqual((await ledger.forAccount(ACCOUNT)).map((t) => t.units), [100n, 100n, 50n, 0n, null], "settled for good");
});

test("P&L is average cost: 40 wei for 200 units, 50 sold, 150 held now worth 60 is a cost of 30 and a gain of 30", () => {
  const trades: BotTrade[] = [{ ...trade(1, "buy", 10n), units: 100n }, { ...trade(2, "buy", 30n), units: 100n }, { ...trade(3, "sell", 0n, 50n), units: 50n }, { ...trade(4, "buy", 99n), units: 0n }, trade(5, "buy", 7n)];
  const [basis] = costBasis(trades);
  assert.deepEqual(basis, { token: TOKEN, ethIn: 40n, unitsIn: 200n, unitsOut: 50n }, "the reverted buy and the unsettled one are not counted");
  assert.deepEqual(positionRow(basis!, 150n, 60n), { token: TOKEN, held: 150n, value: 60n, cost: 30n, pnl: 30n, unknownUnits: 0n });
});

test("units the record cannot account for carry no cost, and do not flatter the P&L", () => {
  const basis = { token: TOKEN, ethIn: 40n, unitsIn: 200n, unitsOut: 50n };
  // 150 recorded, 300 held: half the holding came from elsewhere; its value is left out of the P&L.
  assert.deepEqual(positionRow(basis, 300n, 120n), { token: TOKEN, held: 300n, value: 120n, cost: 30n, pnl: 30n, unknownUnits: 150n });
  assert.deepEqual(positionRow({ token: TOKEN, ethIn: 0n, unitsIn: 0n, unitsOut: 0n }, 10n, 5n), { token: TOKEN, held: 10n, value: 5n, cost: null, pnl: null, unknownUnits: 10n }, "nothing recorded: value only");
});
