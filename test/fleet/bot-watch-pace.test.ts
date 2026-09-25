import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseEther, type Address, type Hex } from "viem";

import { BLOCK_TIME_MS } from "../../src/fleet/chain-def.js";
import { DEFAULT_BLOCKS_PER_RUN, DEFAULT_MAX_LAG_BLOCKS, MemoryWatchStore, Watcher, type VenueBuy, type WatchPort } from "../../src/fleet/bot-watch.js";

/**
 * Whether the watcher can keep up with the chain at all, and what it does
 * when it could not.
 *
 * The cursor moves by at most one window per pass and the pass runs on a
 * cron. If the window times the passes is smaller than the blocks the chain
 * seals in the same day, the watcher does not lag a little: it loses ground
 * every pass, for good. Robinhood Chain seals a block about every tenth of a
 * second on 4663 (measured 0.101 s on 2026-09-25), which is roughly 855,000
 * blocks a day against the 172,800 a 600-block pass every five minutes can
 * read.
 *
 * And a watcher that did fall behind must not announce what it finds there
 * as news. These alerts are read as "someone just bought", and the copy desk
 * mirrors a leader's buy into other people's accounts at the price of the
 * moment it reads it, so a two-day-old buy is not a late alert, it is a wrong
 * trade.
 */

const POOL = "0x00000000000000000000000000000000000000ce" as Address;
const BUYER = "0x0000000000000000000000000000000000000b01" as Address;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const buy = (n: number, block: bigint): VenueBuy =>
  ({ block, txHash: hash(n), buyer: BUYER, token: POOL, ethInWei: parseEther("1"), tokensOut: 1_000n, poolId: hash(1) });

const port = (head: bigint, buys: VenueBuy[] = []) => {
  const windows: Array<[bigint, bigint]> = [];
  const p: WatchPort = {
    async latestBlock() { return head; },
    async buysBetween(from, to) { windows.push([from, to]); return buys.filter((b) => b.block >= from && b.block <= to); },
  };
  return { port: p, windows };
};

const quietly = async <T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
  const lines: string[] = [];
  const said = { warn: console.warn, error: console.error };
  console.warn = console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    return { result: await work(), lines };
  } finally {
    Object.assign(console, said);
  }
};

describe("the watcher's pace against the chain's", () => {
  it("one day of passes reads at least one day of blocks", async () => {
    const vercel = JSON.parse(await readFile(join(process.cwd(), "vercel.json"), "utf8")) as { crons?: { path: string; schedule: string }[] };
    const schedule = (vercel.crons ?? []).find((c) => c.path === "/api/bot/watch")?.schedule;
    assert.ok(schedule, "the watcher has no clock in vercel.json");
    const everyMinutes = Number(/^\*\/(\d+) /.exec(schedule)?.[1] ?? 0);
    assert.ok(everyMinutes > 0, `this test reads "*/n * * * *" schedules; the clock is "${schedule}"`);

    const passesPerDay = (24 * 60) / everyMinutes;
    const readPerDay = DEFAULT_BLOCKS_PER_RUN * passesPerDay;
    const sealedPerDay = (24 * 60 * 60 * 1_000) / BLOCK_TIME_MS;
    assert.ok(
      readPerDay >= sealedPerDay,
      `a pass of ${DEFAULT_BLOCKS_PER_RUN} blocks every ${everyMinutes} minutes reads ${readPerDay.toLocaleString("en-US")} blocks a day; the chain seals ${sealedPerDay.toLocaleString("en-US")}`,
    );
  });

  it("a cursor further behind than the lag limit skips to the limit, and says how much it dropped", async () => {
    const head = 2_000_000n;
    const behind = head - 1_700_000n; // two days of 4663
    const store = new MemoryWatchStore();
    await store.setCursor(4663, behind);
    const { port: p, windows } = port(head, [buy(1, behind + 1n), buy(2, head - 10n)]);
    const seen: VenueBuy[] = [];
    const watcher = new Watcher({ port: p, store, chainId: 4663, onBuy: async (b) => { seen.push(b); } });

    const { result, lines } = await quietly(() => watcher.run());

    assert.equal(result.from, head - BigInt(DEFAULT_MAX_LAG_BLOCKS), "the window starts at the lag limit, not at the old cursor");
    assert.deepEqual(seen.map((b) => b.txHash), [hash(2)], "the two-day-old buy is not announced as news");
    assert.ok(lines.some((l) => /behind/.test(l) && /skip/i.test(l)), lines.join("\n"));
    assert.equal(windows.length, 1);
    assert.equal(await store.cursor(4663), result.to, "and the cursor is caught up, not left crawling");
  });

  it("a cursor within the lag limit is read in full, as before", async () => {
    const head = 2_000_000n;
    const store = new MemoryWatchStore();
    await store.setCursor(4663, head - 100n);
    const { port: p } = port(head, [buy(3, head - 50n)]);
    const seen: VenueBuy[] = [];
    const watcher = new Watcher({ port: p, store, chainId: 4663, onBuy: async (b) => { seen.push(b); } });

    const { result } = await quietly(() => watcher.run());

    assert.equal(result.from, head - 99n);
    assert.deepEqual(seen.map((b) => b.txHash), [hash(3)]);
  });
});
