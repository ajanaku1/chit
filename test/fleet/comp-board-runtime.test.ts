/**
 * The board route: GET only; a board is built once a minute and the same
 * one is served inside that minute, with an edge cache header to match; a
 * build that fails after a good one serves the good one marked stale.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryCompStore } from "../../src/fleet/bot-comp.js";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import { MemoryPositionLedger } from "../../src/fleet/bot-positions.js";
import { handleBoardRequest, setBoardDepsForTests } from "../../src/fleet/comp-board-runtime.js";
import type { BoardDeps } from "../../src/fleet/comp-board.js";
import { FIRST_COMPETITION } from "../../src/fleet/comp-score.js";

type Body = { entrants: number; stale?: boolean };
const body = async (r: Promise<Response> | Response): Promise<Body> => (await (await r).json()) as Body;
const req = (method = "GET") => new Request("https://app.chit.tools/api/comp/board", { method });

test("GET only; one build a minute, the edge told the same; a failed rebuild serves the last good board as stale", async () => {
  const entries = new MemoryCompStore();
  let builds = 0, fail = false;
  const deps: BoardDeps = {
    entries, links: new MemoryBotLinkStore(), ledger: new MemoryPositionLedger(),
    settle: async () => undefined,
    reads: { chainId: 4663, tokenBalance: async () => 0n, quoteSell: async () => 0n, tokenInfo: async () => ({ symbol: "" }) } as unknown as BoardDeps["reads"],
    rules: FIRST_COMPETITION,
  };
  // The entry store is where a failure is injected: the first thing a build reads.
  const flaky: BoardDeps = { ...deps, entries: { join: (e) => entries.join(e), all: async () => { builds += 1; if (fail) throw new Error("db away"); return entries.all(); } } };
  setBoardDepsForTests(flaky);
  try {
    assert.equal((await handleBoardRequest(req("POST"))).status, 405);
    const t0 = new Date("2026-10-04T12:00:00Z");
    const first = await handleBoardRequest(req(), t0);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "public, s-maxage=60, stale-while-revalidate=600");
    assert.equal((await body(first)).entrants, 0);
    await entries.join({ tgId: "1", username: null, nickname: "late", joinedAt: t0.toISOString() });
    assert.equal((await body(handleBoardRequest(req(), new Date(t0.getTime() + 59_000)))).entrants, 0, "inside the minute: the same board");
    assert.equal((await body(handleBoardRequest(req(), new Date(t0.getTime() + 61_000)))).entrants, 1, "after it: rebuilt");
    assert.equal(builds, 2);
    fail = true;
    const stale = await body(handleBoardRequest(req(), new Date(t0.getTime() + 130_000)));
    assert.deepEqual([stale.entrants, stale.stale], [1, true]);
  } finally { setBoardDepsForTests(undefined); }
});
