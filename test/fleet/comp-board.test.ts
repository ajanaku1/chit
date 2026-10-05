/**
 * The live board: entrants without a linked account are counted but not
 * placed; everyone with a counted trade is on the PnL board, the unqualified
 * after the qualified, each with their trades toward five; the excluded are
 * scored out of it; open holdings carry the token's symbol; nothing in the
 * JSON is a wallet or a Telegram id; the awards appear only once the window
 * has closed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryCompStore } from "../../src/fleet/bot-comp.js";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import { MemoryPositionLedger, type BotTrade } from "../../src/fleet/bot-positions.js";
import { buildBoard, type BoardDeps } from "../../src/fleet/comp-board.js";
import type { ScoreRules } from "../../src/fleet/comp-score.js";
import type { Address, Hex } from "../../src/fleet/types.js";

const rules: ScoreRules = { start: new Date("2026-10-02T12:00:00Z"), end: new Date("2026-10-09T12:00:00Z"), minWei: 100n, minTrades: 5 };
const A = "0x00000000000000000000000000000000000000a1" as Address, B = "0x00000000000000000000000000000000000000b1" as Address;
const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const during = "2026-10-03T12:00:00Z";
let n = 0;
const buy = (account: Address, eth: bigint, units: bigint): BotTrade => ({ hash: `0x${(++n).toString(16).padStart(64, "0")}` as Hex, account, token: PEPE, side: "buy", ethWei: eth, asked: 0n, units, at: during });
const sell = (account: Address, units: bigint, ethOut: bigint): BotTrade => ({ hash: `0x${(++n).toString(16).padStart(64, "0")}` as Hex, account, token: PEPE, side: "sell", ethWei: 0n, asked: units, units, ethOut, at: during });

const setup = async () => {
  const entries = new MemoryCompStore(), links = new MemoryBotLinkStore(), ledger = new MemoryPositionLedger();
  const held = new Map<string, bigint>([[A, 50n], [B, 0n]]);
  const link = (tgId: string, account: Address) => links.putLink({ tgId, account, owner: account, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: during });
  await entries.join({ tgId: "1", username: null, nickname: "alpha", joinedAt: during });
  await entries.join({ tgId: "2", username: null, nickname: "beta", joinedAt: during });
  await entries.join({ tgId: "3", username: null, nickname: "unlinked", joinedAt: during });
  await entries.join({ tgId: "team", username: null, nickname: "team", joinedAt: during });
  await link("1", A); await link("2", B); await link("team", "0x00000000000000000000000000000000000000ee" as Address);
  // alpha: five trades, 1000 in, 700 back, 50 units held worth 600 at exit: +30%. beta: one trade, 1000 in, held nothing: -100%.
  for (const t of [buy(A, 200n, 20n), buy(A, 200n, 20n), buy(A, 200n, 20n), buy(A, 200n, 20n), buy(A, 200n, 20n), sell(A, 50n, 700n), buy(B, 1000n, 10n)]) await ledger.note(t);
  const deps: BoardDeps = {
    entries, links, ledger,
    settle: async (_h, _t, account) => ({ status: "success", received: account === A ? 20n : 10n }),
    reads: { chainId: 4663, tokenBalance: async (_t: Address, a: Address) => held.get(a) ?? 0n, quoteSell: async (_t: Address, u: bigint) => u * 12n, tokenInfo: async () => ({ symbol: "PEPE" }) } as unknown as BoardDeps["reads"],
    rules, excluded: new Set(["team"]),
  };
  return deps;
};

test("mid-week: counts, both boards by nickname, the unqualified after the qualified with their trades toward five, no awards yet, nothing that names a wallet", async () => {
  const board = await buildBoard(await setup(), new Date("2026-10-04T12:00:00Z"));
  assert.equal(board.ended, false);
  assert.equal(board.entrants, 3, "the team is not counted; the unlinked entrant is");
  assert.equal(board.trades, 7);
  assert.deepEqual(board.pnl, [{ nickname: "alpha", pct: 30, trades: 6, qualified: true }, { nickname: "beta", pct: -100, trades: 1, qualified: false }]);
  assert.deepEqual(board.ongoing, [{ nickname: "alpha", symbol: "PEPE", pct: 20 }], "50 held, cost 500 of the 1000 for 100 units, worth 600");
  assert.deepEqual(board.prizes, [{ prize: "best pnl", usd: 500 }, { prize: "best ongoing trade", usd: 350 }]);
  assert.equal(board.awards, undefined);
  assert.deepEqual([board.start, board.end, board.minEth, board.minTrades], ["2026-10-02T12:00:00.000Z", "2026-10-09T12:00:00.000Z", "0.0000000000000001", 5]);
  const json = JSON.stringify(board);
  assert.ok(!/0x[0-9a-f]{40}/i.test(json) && !/"tgId"/.test(json) && !json.includes("team"), json);
});

test("once the window has closed the awards are on the board, one prize per person", async () => {
  const board = await buildBoard(await setup(), new Date("2026-10-09T12:00:00Z"));
  assert.equal(board.ended, true);
  assert.deepEqual(board.awards, [{ prize: "best pnl", usd: 500, nickname: "alpha" }]);
});
