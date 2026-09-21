import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Address, Hex, PublicClient } from "viem";

import type { PoolQueued } from "../../src/fleet/chain-pool.js";
import { ledgerKey, sealDepositor } from "../../src/fleet/pool-ledger.js";
import {
  FINALITY_MARGIN_SECONDS, MULTICALL3, READS_ABI, READ_CHUNK,
  createMemoryReadCache, createPoolReads, type PoolReadCache,
} from "../../src/fleet/pool-reads.js";
import { createNeonReadCache } from "../../src/fleet/pool-reads-neon.js";

/**
 * Reading the pool's two lists. They only grow, and they used to be read one
 * awaited call per entry: a balance, an activation, a withdrawal, a trade and a
 * sweep each paid a round trip for every campaign and every charge there had
 * ever been. Two things are held here.
 *
 * The number of round trips does not grow with the history: the entries come
 * back through Multicall3, which is deployed on 46630 and 4663, and through
 * viem's deployless form of it where it is not (the local chain the pool
 * suites run on).
 *
 * And a charge whose POST_WINDOW has closed is read once and never again,
 * because nothing about it can change: posted it stays posted, unposted it can
 * never be posted. Only the unposted ones are kept, since they still count
 * against their depositor. What is kept is what the chain published, the
 * ciphertext included: never an opened depositor. That table would be the link
 * the pool exists to withhold, sitting in a database.
 */

const POOL = "0x0000000000000000000000000000000000000901" as Address;
const ALICE = "0x00000000000000000000000000000000000a11ce" as Address;
const KEY = ledgerKey(`0x${"7".repeat(64)}`);
const WINDOW = 12n * 3600n;
const NOW = 1_700_000_000n;
const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

type Chain = { campaigns: Hex[]; queued: PoolQueued[]; now: bigint; multicall3: boolean };

/** A client that answers from `chain` and counts what it was asked, and how. */
const makeClient = (chain: Chain) => {
  const asked = { single: [] as string[], waves: [] as { calls: number; functions: string[]; multicallAddress?: Address; deployless?: boolean }[], getCode: 0, getBlock: 0 };
  const answer = (functionName: string, args: readonly unknown[] = []): unknown => {
    switch (functionName) {
      case "POST_WINDOW": return WINDOW;
      case "campaignCount": return BigInt(chain.campaigns.length);
      case "campaignAt": return chain.campaigns[Number(args[0])];
      case "drawOf": return { amount: 10n, spent: 1n, reserved: 0n, principalOut: 0n, dueAt: NOW, ownerRef: "0x", state: chain.campaigns.includes(args[0] as Hex) ? 2 : 0 };
      case "queuedSpendCount": return BigInt(chain.queued.length);
      case "queuedSpendAt": {
        const { id, ...entry } = chain.queued[Number(args[0])]!;
        return [id, entry];
      }
      default: throw new Error(`unexpected read: ${functionName}`);
    }
  };
  const client = {
    getCode: async () => { asked.getCode += 1; return chain.multicall3 ? "0x6080" : undefined; },
    getBlock: async () => { asked.getBlock += 1; return { timestamp: chain.now }; },
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      asked.single.push(functionName);
      return answer(functionName, args);
    },
    multicall: async ({ contracts, multicallAddress, deployless }: { contracts: { functionName: string; args?: readonly unknown[] }[]; multicallAddress?: Address; deployless?: boolean }) => {
      asked.waves.push({ calls: contracts.length, functions: [...new Set(contracts.map((c) => c.functionName))], ...(multicallAddress ? { multicallAddress } : {}), ...(deployless ? { deployless } : {}) });
      return contracts.map((c) => answer(c.functionName, c.args));
    },
  } as unknown as PublicClient;
  return { client, asked };
};

const charge = (n: number, overrides: Partial<PoolQueued> = {}): PoolQueued => ({
  id: word(n), encDepositor: sealDepositor(KEY, ALICE), amount: BigInt(1_000 + n),
  dueAt: NOW - 100n, queuedAt: NOW - 600n, posted: false, ...overrides,
});

/** Old enough that the window and the margin have both passed. */
const LONG_AGO = NOW - WINDOW - BigInt(FINALITY_MARGIN_SECONDS) - 1n;

describe("the number of round trips", () => {
  const roundTrips = async (campaigns: number, charges: number) => {
    const chain: Chain = { campaigns: Array.from({ length: campaigns }, (_, i) => word(i + 1)), queued: Array.from({ length: charges }, (_, i) => charge(i)), now: NOW, multicall3: true };
    const { client, asked } = makeClient(chain);
    const reads = createPoolReads(client, POOL);
    const [draws, queued] = await Promise.all([reads.draws(), reads.queued()]);
    assert.equal(draws.length, campaigns);
    assert.equal(queued.length, charges);
    return asked;
  };

  it("does not grow with the history", async () => {
    const small = await roundTrips(7, 36); // the live pool on 19 September
    const large = await roundTrips(150, 190);
    assert.equal(small.waves.length, large.waves.length, "as many multicalls for 340 entries as for 43");
    assert.deepEqual(small.single.sort(), large.single.sort(), "and as many single reads");
    assert.ok(!small.single.some((name) => /At$|^drawOf$/.test(name)), "no entry is read with a call of its own");
    assert.ok(small.waves.length + small.single.length <= 7, `${small.waves.length + small.single.length} reads for both lists; it was 2N + M + 2`);
  });

  it("splits a very long list into chunks, so one eth_call never has to carry all of it", async () => {
    const asked = await roundTrips(1, READ_CHUNK * 2 + 1);
    const chargeWaves = asked.waves.filter((w) => w.functions.includes("queuedSpendAt"));
    assert.deepEqual(chargeWaves.map((w) => w.calls), [READ_CHUNK, READ_CHUNK, 1]);
  });

  it("uses the deployed Multicall3 where there is one, and asks once", async () => {
    const asked = await roundTrips(3, 3);
    assert.equal(asked.getCode, 1);
    assert.ok(asked.waves.every((w) => w.multicallAddress === MULTICALL3 && !w.deployless));
  });

  it("needs no deployed Multicall3: the local chain the pool suites run on has none", async () => {
    const chain: Chain = { campaigns: [word(1)], queued: [charge(1)], now: NOW, multicall3: false };
    const { client, asked } = makeClient(chain);
    const reads = createPoolReads(client, POOL);
    assert.deepEqual(await reads.queued(), chain.queued);
    assert.ok(asked.waves.length > 0 && asked.waves.every((w) => w.deployless === true && w.multicallAddress === undefined));
  });

  it("returns what one call per entry returned: every campaign with a draw, every charge, in order", async () => {
    const chain: Chain = { campaigns: [word(1), word(2)], queued: [charge(1), charge(2, { posted: true })], now: NOW, multicall3: true };
    const { client } = makeClient(chain);
    const reads = createPoolReads(client, POOL);
    assert.deepEqual((await reads.draws()).map((d) => [d.campaign, d.state, d.amount]), [[word(1), 2, 10n], [word(2), 2, 10n]]);
    assert.deepEqual(await reads.queued(), chain.queued);
  });
});

describe("a charge whose window has closed", () => {
  const setup = (queued: PoolQueued[], cache: PoolReadCache = createMemoryReadCache()) => {
    const chain: Chain = { campaigns: [], queued, now: NOW, multicall3: true };
    const made = makeClient(chain);
    return { chain, cache, ...made, reads: createPoolReads(made.client, POOL, { cache }) };
  };
  const indicesRead = (asked: ReturnType<typeof makeClient>["asked"]): number =>
    asked.waves.filter((w) => w.functions.includes("queuedSpendAt")).reduce((n, w) => n + w.calls, 0);

  it("is read once and never again", async () => {
    const { reads, asked } = setup([charge(0, { queuedAt: LONG_AGO, posted: true }), charge(1, { queuedAt: LONG_AGO, posted: true }), charge(2)]);
    await reads.queued();
    assert.equal(indicesRead(asked), 3, "the first read sees everything");
    asked.waves.length = 0;
    const second = await reads.queued();
    assert.equal(indicesRead(asked), 1, "the second reads only what can still change");
    assert.deepEqual(second.map((q) => q.id), [word(2)], "and a posted charge that is final is of no use to anyone");
  });

  it("is kept when it was never posted: it still counts against its depositor, and the sweep still reports it", async () => {
    // Each charge() seals its depositor under a fresh nonce, so the same object is compared, not a second one.
    const expired = charge(0, { queuedAt: LONG_AGO, posted: false });
    const open = charge(1);
    const { reads } = setup([expired, open]);
    await reads.queued();
    assert.deepEqual(await reads.queued(), [expired, open]);
  });

  it("is still read while its window is open, posted or not: until then the chain may yet say otherwise", async () => {
    const { reads, asked } = setup([charge(0, { queuedAt: NOW - WINDOW + 60n, posted: true })]);
    await reads.queued();
    asked.waves.length = 0;
    assert.equal((await reads.queued()).length, 1);
    assert.equal(indicesRead(asked), 1);
  });

  it("waits out a margin past the window before it is called final", async () => {
    const { reads, asked } = setup([charge(0, { queuedAt: NOW - WINDOW - 1n, posted: true })]);
    await reads.queued();
    asked.waves.length = 0;
    await reads.queued();
    assert.equal(indicesRead(asked), 1, "closed a second ago is not final yet");
  });

  it("moves the mark only over an unbroken run from the start", async () => {
    const { reads, asked } = setup([charge(0, { queuedAt: LONG_AGO, posted: true }), charge(1), charge(2, { queuedAt: LONG_AGO, posted: true })]);
    await reads.queued();
    asked.waves.length = 0;
    await reads.queued();
    assert.equal(indicesRead(asked), 2, "index 2 is behind an open one and is read again");
  });

  it("is remembered by another instance through the shared cache", async () => {
    const cache = createMemoryReadCache();
    const queued = [charge(0, { queuedAt: LONG_AGO, posted: true }), charge(1, { queuedAt: LONG_AGO }), charge(2)];
    await setup(queued, cache).reads.queued();
    const cold = setup(queued, cache);
    assert.deepEqual((await cold.reads.queued()).map((q) => q.id), [word(1), word(2)]);
    assert.equal(indicesRead(cold.asked), 1, "a cold start reads one entry, not three");
  });

  it("is forgotten when the chain is shorter than the mark: a fork was reset, or this is another pool", async () => {
    const cache = createMemoryReadCache();
    await setup([charge(0, { queuedAt: LONG_AGO, posted: true }), charge(1, { queuedAt: LONG_AGO, posted: true })], cache).reads.queued();
    const { reads } = setup([charge(9)], cache);
    assert.deepEqual((await reads.queued()).map((q) => q.id), [word(9)]);
  });

  it("never fails a read because the cache could not be written or read", async () => {
    const broken: PoolReadCache = { load: async () => { throw new Error("neon is down"); }, advance: async () => { throw new Error("neon is down"); } };
    const original = console.warn;
    console.warn = () => {};
    try {
      const { reads } = setup([charge(0, { queuedAt: LONG_AGO, posted: true }), charge(1)], broken);
      assert.equal((await reads.queued()).length, 2);
      assert.equal((await reads.queued()).length, 1, "and this instance still remembers what it saw");
    } finally {
      console.warn = original;
    }
  });
});

describe("what the cache holds", () => {
  const contract = (name: string, make: () => Promise<{ cache: PoolReadCache; dump: () => Promise<string>; done: () => Promise<void> }>) => {
    describe(name, () => {
      it("keeps the mark and the unposted charges, and hands them to whoever asks next", async () => {
        const { cache, done } = await make();
        try {
          assert.equal(await cache.load("46630:pool"), undefined);
          const expired = { index: 1, entry: charge(1, { queuedAt: LONG_AGO }) };
          await cache.advance("46630:pool", 3, [expired]);
          assert.deepEqual(await cache.load("46630:pool"), { cursor: 3, expired: [expired] });
          assert.equal(await cache.load("4663:pool"), undefined, "another chain's pool is another key");
        } finally { await done(); }
      });

      it("only moves forward, and saying the same thing twice changes nothing: two instances will", async () => {
        const { cache, done } = await make();
        try {
          const entry = { index: 1, entry: charge(1, { queuedAt: LONG_AGO }) };
          await cache.advance("k", 5, [entry]);
          await cache.advance("k", 3, [entry]);
          await cache.advance("k", 5, [entry]);
          assert.deepEqual(await cache.load("k"), { cursor: 5, expired: [entry] });
        } finally { await done(); }
      });

      it("holds the ciphertext the chain published and never the depositor it opens to", async () => {
        const { cache, dump, done } = await make();
        try {
          const entry = charge(1, { queuedAt: LONG_AGO });
          await cache.advance("k", 2, [{ index: 1, entry }]);
          const stored = (await dump()).toLowerCase();
          assert.ok(stored.includes(entry.encDepositor.slice(2).toLowerCase()), "the sealed reference is there");
          assert.ok(!stored.includes(ALICE.slice(2).toLowerCase()), "the opened depositor is not");
        } finally { await done(); }
      });
    });
  };

  contract("memory", async () => {
    const cache = createMemoryReadCache();
    return { cache, dump: async () => JSON.stringify(await cache.load("k"), (_, v) => (typeof v === "bigint" ? v.toString() : v)), done: async () => undefined };
  });

  contract("neon on pglite", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    const sql = { query: async (q: string, params?: unknown[]) => (await db.query(q, params)).rows as Record<string, unknown>[] };
    const dump = async (): Promise<string> => JSON.stringify([
      (await db.query("SELECT * FROM fleet_pool_queue_mark")).rows,
      (await db.query("SELECT * FROM fleet_pool_queue_expired")).rows,
    ]);
    return { cache: createNeonReadCache(sql), dump, done: () => db.close() };
  });
});

describe("the ABI these reads decode with", () => {
  it("matches the compiled pool, function by function: a struct that gains a field must fail here, not decode wrong", async () => {
    type Param = { type: string; name?: string; components?: Param[] };
    type Fn = { type: string; name?: string; inputs?: Param[]; outputs?: Param[]; stateMutability?: string };
    const artifact = JSON.parse(await readFile(join(process.cwd(), "artifacts/contracts/fleet/FleetPool.sol/FleetPool.json"), "utf8")) as { abi: Fn[] };
    // Types, names and nesting, in one key order; the compiler's `internalType` is not part of the wire format.
    const param = (p: Param): unknown => ({ type: p.type, name: p.name ?? "", components: (p.components ?? []).map(param) });
    const shape = (fn: Fn): string => JSON.stringify({ inputs: (fn.inputs ?? []).map(param), outputs: (fn.outputs ?? []).map(param), stateMutability: fn.stateMutability });
    for (const mine of READS_ABI as unknown as readonly Fn[]) {
      const compiled = artifact.abi.find((entry) => entry.type === "function" && entry.name === mine.name);
      assert.ok(compiled, `${mine.name} is not in the compiled pool`);
      assert.equal(shape(mine), shape(compiled), `${mine.name} has drifted from the contract`);
    }
  });
});
