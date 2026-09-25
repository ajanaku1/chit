import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Address, Hex, PublicClient, WalletClient } from "viem";

import type { FleetPool, PoolQueued } from "../../src/fleet/chain-pool.js";
import { POST_WINDOW_SECONDS, createPoolService } from "../../src/fleet/pool-buy.js";
import { ledgerKey, sealDepositor } from "../../src/fleet/pool-ledger.js";
import { createMemoryStore } from "../../src/fleet/store.js";

/**
 * A posting that does not happen is money: a charge unposted after the pool's
 * POST_WINDOW can never be posted, and the pool is short by that much. The
 * loop used to swallow every failure, the closed window and the dropped RPC
 * call alike, with no log line and no field in the sweep's report. These hold
 * the opposite: every due charge ends up posted, failed with a reason, expired,
 * or unreadable, and each of those has a number someone can read.
 *
 * What is logged is the charge's id, which SpendQueued already published, and
 * never its depositor: until the posting lands, that pairing is not public.
 */

const KEY = ledgerKey(`0x${"7".repeat(64)}`);
const OTHER_KEY = ledgerKey(`0x${"8".repeat(64)}`);
const ALICE = "0x00000000000000000000000000000000000a11ce" as Address;
const NOW = 1_700_000_000n;
const id = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

const entry = (n: number, overrides: Partial<PoolQueued> = {}): PoolQueued => ({
  id: id(n), encDepositor: sealDepositor(KEY, ALICE), amount: 5_000n,
  dueAt: NOW - 60n, queuedAt: NOW - 600n, posted: false, ...overrides,
});

/** What viem throws for a revert: the sentence first, the call and its arguments after it. */
const revert = (name: string, entryId: Hex): Error => {
  const error = new Error([
    'The contract function "postQueued" reverted.',
    "",
    `Error: ${name}()`,
    "",
    "Contract Call:",
    "  function:  postQueued(bytes32 id, address depositor)",
    `  args:                (${entryId}, ${ALICE})`,
  ].join("\n"));
  error.name = "ContractFunctionExecutionError";
  return error;
};

const dropped = (): Error => {
  const error = new Error(`HTTP request failed.\n\nURL: https://rpc.example\nRequest body: {"method":"eth_sendRawTransaction","params":["0x02…${ALICE.slice(2)}"]}`);
  error.name = "HttpRequestError";
  return error;
};

const makeService = (queued: PoolQueued[], fail: (entryId: Hex) => Error | undefined = () => undefined) => {
  const tried: Hex[] = [];
  const pool = {
    address: "0x0000000000000000000000000000000000000901" as Address,
    queued: async () => queued,
    draws: async () => [],
    postQueued: async (entryId: Hex) => {
      tried.push(entryId);
      const error = fail(entryId);
      if (error) throw error;
      return "0x01" as Hex;
    },
  } as unknown as FleetPool;
  const publicClient = { getBlock: async () => ({ timestamp: NOW }) } as unknown as PublicClient;
  const wallet = { account: { address: ALICE }, chain: null } as unknown as WalletClient;
  return { service: createPoolService(wallet, publicClient, pool, KEY, { store: createMemoryStore() }), tried };
};

/** Runs a sweep with the console captured, so what it said is part of what is asserted. */
const sweepQuietly = async (service: ReturnType<typeof makeService>["service"]) => {
  const lines: string[] = [];
  const original = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    return { report: await service.sweep(async () => []), lines };
  } finally {
    Object.assign(console, original);
  }
};

describe("the sweep measures how long a charge has waited", () => {
  /**
   * SC-010 promises an alert within four hours of a charge going unrecorded.
   * The outside monitor raises that alert, and GitHub's scheduler runs it
   * every 4.7 hours in the median and dropped it to six runs in a day
   * (measured 2026-09-23, PR #56), so the promise cannot rest on it. The
   * posting sweep runs on Vercel's clock every two hours, which does tick, and
   * it already reads every queued charge. It measures the age here; the router
   * raises the alert (campaign-routes.ts).
   */
  it("reports a charge unposted for over four hours, and stays quiet about a fresh one", async () => {
    const fresh = entry(1, { queuedAt: NOW - 600n });
    const old = entry(2, { queuedAt: NOW - 5n * 3_600n });
    const { service } = makeService([fresh, old], (entryId) => (entryId === id(2) ? revert("NotDue", entryId) : undefined));
    const { report } = await sweepQuietly(service);

    assert.deepEqual(report.ageing?.map((c) => c.id), [id(2)], "only the one past four hours");
    assert.equal(report.ageing?.[0]?.ageSeconds, 5 * 3_600);
  });

  it("does not count a posted charge, nor one already past the window: that one is expired, and expired is its own report", async () => {
    const posted = entry(3, { queuedAt: NOW - 6n * 3_600n, posted: true });
    const expired = entry(4, { queuedAt: NOW - BigInt(POST_WINDOW_SECONDS) - 60n });
    const { service } = makeService([posted, expired]);
    const { report } = await sweepQuietly(service);

    assert.deepEqual(report.expired, [id(4)]);
    assert.deepEqual(report.ageing, [], "a charge that can no longer be posted is not ageing, it is lost");
  });

  it("measures every queued charge, not only the ones this sweep tried to post", async () => {
    // Not due yet, so the posting loop skips it; it has still been waiting.
    const waiting = entry(5, { dueAt: NOW + 600n, queuedAt: NOW - 5n * 3_600n });
    const { service, tried } = makeService([waiting]);
    const { report } = await sweepQuietly(service);

    assert.deepEqual(tried, [], "nothing was posted");
    assert.deepEqual(report.ageing?.map((c) => c.id), [id(5)]);
  });
});

describe("a sweep accounts for every due charge", () => {
  it("says so when there is nothing to say: empty lists and a zero, not missing fields", async () => {
    const { service } = makeService([entry(1)]);
    const { report, lines } = await sweepQuietly(service);
    assert.deepEqual(report.posted, [id(1)]);
    assert.deepEqual(report.failed, []);
    assert.deepEqual(report.expired, []);
    assert.equal(report.unreadable, 0);
    assert.deepEqual(lines, [], "a clean sweep is a quiet one");
  });

  it("counts a posting the contract refused, by the contract's own word for it", async () => {
    const { service } = makeService([entry(1)], (entryId) => revert("NotDue", entryId));
    const { report } = await sweepQuietly(service);
    assert.deepEqual(report.posted, []);
    assert.deepEqual(report.failed, [{ id: id(1), reason: "NotDue" }]);
  });

  it("names a dropped RPC call as what it was, not as a refusal", async () => {
    const { service } = makeService([entry(1)], dropped);
    const { report } = await sweepQuietly(service);
    assert.deepEqual(report.failed, [{ id: id(1), reason: "HttpRequestError" }]);
  });

  it("logs the charge by its public id and its reason, and never the depositor or the call", async () => {
    const { service } = makeService([entry(1), entry(2)], (entryId) => (entryId === id(1) ? revert("NotDue", entryId) : dropped()));
    const { lines } = await sweepQuietly(service);
    assert.equal(lines.length, 2, "one line per failed posting");
    assert.ok(lines[0]?.includes(id(1)) && lines[0].includes("NotDue"));
    assert.ok(lines[1]?.includes(id(2)) && lines[1].includes("HttpRequestError"));
    for (const line of lines) {
      assert.ok(!line.toLowerCase().includes(ALICE.slice(2).toLowerCase()), "until the posting lands, id and depositor are not public together");
      assert.ok(!/Contract Call|Request body|args:/.test(line), "the first line of an error, never the request it was building");
    }
  });

  it("does not let one bad posting stop the rest", async () => {
    const { service, tried } = makeService([entry(1), entry(2), entry(3)], (entryId) => (entryId === id(2) ? dropped() : undefined));
    const { report } = await sweepQuietly(service);
    assert.deepEqual(tried, [id(1), id(2), id(3)]);
    assert.deepEqual(report.posted, [id(1), id(3)]);
    assert.deepEqual(report.failed, [{ id: id(2), reason: "HttpRequestError" }]);
  });
});

describe("a charge past its window", () => {
  const window = BigInt(POST_WINDOW_SECONDS);

  it("is reported as expired and not tried again: the contract refuses it for good", async () => {
    const { service, tried } = makeService([entry(1, { queuedAt: NOW - window - 1n })]);
    const { report, lines } = await sweepQuietly(service);
    assert.deepEqual(tried, [], "a posting that can never succeed is not worth a call every sweep");
    assert.deepEqual(report.expired, [id(1)]);
    assert.deepEqual(report.failed, []);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.includes(id(1)), "a loss is said out loud, once");
  });

  it("is still tried on the last second the contract would take it", async () => {
    const { service, tried } = makeService([entry(1, { queuedAt: NOW - window })]);
    const { report } = await sweepQuietly(service);
    assert.deepEqual(tried, [id(1)]);
    assert.deepEqual(report.posted, [id(1)]);
  });

  it("is said once per instance, not on every sweep: an expired charge stays in the queue for ever", async () => {
    const { service } = makeService([entry(1, { queuedAt: NOW - window - 1n })]);
    await sweepQuietly(service);
    const again = await sweepQuietly(service);
    assert.deepEqual(again.report.expired, [id(1)], "the report keeps counting it");
    assert.deepEqual(again.lines, [], "the log does not repeat it");
  });

  it("uses the pool's own window: POST_WINDOW_SECONDS mirrors FleetPool.POST_WINDOW", async () => {
    const hours = /uint64 public constant POST_WINDOW = (\d+) hours;/.exec(await readFile(join(process.cwd(), "contracts/fleet/FleetPool.sol"), "utf8"));
    assert.ok(hours, "FleetPool.sol no longer states POST_WINDOW in hours");
    assert.equal(POST_WINDOW_SECONDS, Number(hours[1]) * 3600);
  });
});

describe("a due charge the ledger key cannot open", () => {
  it("is counted and said, not skipped in silence: a changed ledger key would lose every charge this way", async () => {
    const { service, tried } = makeService([entry(1, { encDepositor: sealDepositor(OTHER_KEY, ALICE) }), entry(2)]);
    const { report, lines } = await sweepQuietly(service);
    assert.deepEqual(tried, [id(2)]);
    assert.equal(report.unreadable, 1);
    assert.deepEqual(report.posted, [id(2)]);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /FLEET_LEDGER_KEY/);
  });

  it("is said again only when the number moves", async () => {
    const { service } = makeService([entry(1, { encDepositor: sealDepositor(OTHER_KEY, ALICE) })]);
    await sweepQuietly(service);
    assert.deepEqual((await sweepQuietly(service)).lines, []);
  });
});
