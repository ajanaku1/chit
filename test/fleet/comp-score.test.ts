/**
 * The competition's rules as agreed: PnL is the wallet's whole return on
 * what it spent, open holdings at their exit value; trades under the minimum
 * or outside the window do not count; five counted trades qualify; units
 * bought before the window carry no cost and add nothing; the best ongoing
 * trade is one open holding's return; one prize per person, the bigger kept.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotTrade } from "../../src/fleet/bot-positions.js";
import { FIRST_COMPETITION, countedTrades, scoreCompetition, scoreEntrant, type Entrant, type Holding, type ScoreRules } from "../../src/fleet/comp-score.js";
import type { Address, Hex } from "../../src/fleet/types.js";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b1" as Address;
const rules: ScoreRules = { start: new Date("2026-10-05T00:00:00Z"), end: new Date("2026-10-12T00:00:00Z"), minWei: 500n, minTrades: 5 };
const day = (d: number): string => new Date(rules.start.getTime() + d * 86_400_000).toISOString();
let n = 0;
const buy = (token: Address, eth: bigint, units: bigint, at = day(1)): BotTrade => ({ hash: `0x${(++n).toString(16).padStart(64, "0")}` as Hex, account: A, token, side: "buy", ethWei: eth, asked: 0n, units, at });
const sell = (token: Address, units: bigint, ethOut: bigint, at = day(2)): BotTrade => ({ hash: `0x${(++n).toString(16).padStart(64, "0")}` as Hex, account: A, token, side: "sell", ethWei: 0n, asked: units, units, ethOut, at });
const entrant = (tgId: string, trades: BotTrade[], holdings: [Address, Holding][] = []): Entrant => ({ tgId, nickname: `n${tgId}`, trades, holdings: new Map(holdings) });

test("the trades that count: landed, settled, in the window, at least the minimum by their ETH", () => {
  const t = [buy(A, 1000n, 10n), buy(A, 499n, 10n), buy(A, 1000n, 10n, day(-1)), buy(A, 1000n, 10n, day(7)), { ...buy(A, 1000n, 10n), units: null }, { ...buy(A, 1000n, 0n) }, sell(A, 5n, 500n), sell(A, 5n, 400n)];
  assert.deepEqual(countedTrades(t, rules).map((x) => [x.side, x.ethWei, x.ethOut]), [["buy", 1000n, undefined], ["sell", 0n, 500n]]);
});

test("PnL is the wallet's whole return: a small lucky trade cannot hide a big loss", () => {
  // 1000 in A, sold for 5000 (+400%); 100000 in B, half sold for 25000, half held worth 25000 at exit (-50%).
  const e = entrant("1", [buy(A, 1000n, 10n), sell(A, 10n, 5000n), buy(B, 100_000n, 100n), sell(B, 50n, 25_000n), buy(B, 1000n, 0n)], [[B, { held: 50n, exitWei: 25_000n }]]);
  const { pnl } = scoreEntrant(e, rules);
  assert.equal(pnl.spent, 101_000n);
  assert.equal(pnl.back, 55_000n);
  assert.equal(pnl.bps, -4554, "a 45.5% loss, not the +175% an average of the two would show");
  assert.equal(pnl.trades, 4, "the buy that brought nothing is not a trade");
  assert.equal(pnl.qualified, false, "four counted trades are not five");
});

test("an open holding is its exit value, so a thin pool scores what selling it would really pay; units from before the window add nothing", () => {
  const e = entrant("1", [buy(A, 1000n, 100n), buy(A, 1000n, 100n), buy(A, 1000n, 100n), buy(A, 1000n, 100n), buy(A, 1000n, 100n)], [[A, { held: 1000n, exitWei: 4000n }]]);
  // 500 units bought in the window for 5000; 1000 held (half from before), exit 4000 for all, so 2000 for the window's half.
  const { pnl, ongoing } = scoreEntrant(e, rules);
  assert.deepEqual([pnl.spent, pnl.back, pnl.bps, pnl.qualified], [5000n, 2000n, -6000, true]);
  assert.deepEqual(ongoing.map((o) => [o.cost, o.value, o.bps]), [[5000n, 2000n, -6000]]);
});

test("units sold beyond what the window bought return only their bought share", () => {
  const e = entrant("1", [buy(A, 1000n, 100n), sell(A, 200n, 4000n)]);
  assert.equal(scoreEntrant(e, rules).pnl.back, 2000n, "half the units sold were bought before the window");
});

test("the boards and the prizes: biggest first, one per person, the excluded never awarded", () => {
  const five = (tgId: string, cost: bigint, back: bigint, open?: Holding): Entrant => entrant(tgId, [
    buy(A, cost, 100n), sell(A, 100n, back), buy(A, 1000n, 10n), sell(A, 10n, 1000n), ...(open ? [buy(B, 1000n, 10n)] : [buy(A, 1000n, 10n), sell(A, 10n, 1000n)]),
  ], open ? [[B, open]] : []);
  const entrants = [
    five("1", 1000n, 9000n, { held: 10n, exitWei: 9000n }), // best PnL and best ongoing: keeps the pnl $500
    five("2", 1000n, 5000n),
    five("3", 1000n, 3000n, { held: 10n, exitWei: 2000n }),
    five("4", 1000n, 2000n),
    five("team", 1000n, 50_000n),
  ];
  const { pnl, ongoing, awards } = scoreCompetition(entrants, rules, new Set(["team"]));
  assert.deepEqual(pnl.map((p) => p.tgId), ["team", "1", "2", "3", "4"], "the team is on the board");
  assert.deepEqual(ongoing.map((o) => o.tgId), ["1", "3"]);
  assert.deepEqual(awards.map((a) => [a.prize, a.usd, a.tgId]), [["best pnl", 500, "1"], ["best ongoing trade", 350, "3"]]);
});

test("the first competition: 2 to 9 October 2026 noon UTC, 0.0005 ETH a trade, five trades; a trade at 11:59 on the 2nd is out, one at noon is in", () => {
  assert.deepEqual([FIRST_COMPETITION.start.toISOString(), FIRST_COMPETITION.end.toISOString(), FIRST_COMPETITION.minWei, FIRST_COMPETITION.minTrades], ["2026-10-02T12:00:00.000Z", "2026-10-09T12:00:00.000Z", 500_000_000_000_000n, 5]);
  const early = buy(A, 10n ** 16n, 10n, "2026-10-02T11:59:59Z"), first = buy(A, 10n ** 16n, 10n, "2026-10-02T12:00:00Z"), last = buy(A, 10n ** 16n, 10n, "2026-10-09T11:59:59Z"), late = buy(A, 10n ** 16n, 10n, "2026-10-09T12:00:00Z");
  assert.deepEqual(countedTrades([early, first, last, late], FIRST_COMPETITION), [first, last]);
});
