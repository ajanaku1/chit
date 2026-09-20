/**
 * The chain watcher: the cursor moves by at most the run's width and a
 * first run starts at the head; a hash is handed on once even when the
 * same window is scanned twice; a handler that throws costs one buy, not
 * the run; a Swap log with ETH paid and tokens out is a buy, a sell in the
 * same pool is not, a pool whose Initialize the watcher cannot find is
 * skipped, a pool that is not an ETH pool is skipped, two swaps of one
 * transaction in one pool are one buy summed, and the buyer is the
 * transaction's sender, asked for once per hash; the Neon store prunes the
 * seen hashes when it writes the cursor.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, custom, encodeAbiParameters, encodeEventTopics, type Hex, numberToHex, parseAbiItem, parseEther } from "viem";
import { createWatchPort, isEthInBuy, MemoryWatchStore, NeonWatchStore, onePerTransaction, type VenueBuy, type WatchPort, type WatchSql, Watcher } from "../../src/fleet/bot-watch.js";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const USDC = "0x00000000000000000000000000000000000000dc" as Address;
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
const BUYER = "0x0000000000000000000000000000000000000b01" as Address;
const clock = new Date("2026-09-20T12:00:00Z");
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const poolId = (n: number): Hex => `0x${"ab".repeat(31)}${n.toString(16).padStart(2, "0")}` as Hex;

const buy = (n: number, block: bigint, ethIn = parseEther("0.5"), token: Address = PEPE): VenueBuy => ({ block, txHash: hash(n), buyer: BUYER, token, ethInWei: ethIn, tokensOut: 1000n, poolId: poolId(1) });

/** A port over a scripted chain: the head, and the buys by block. */
const fakePort = (head: bigint, buys: VenueBuy[]) => {
  const windows: Array<[bigint, bigint]> = [];
  const port: WatchPort = {
    async latestBlock() { return head; },
    async buysBetween(from, to) { windows.push([from, to]); return buys.filter((b) => b.block >= from && b.block <= to); },
  };
  return { port, windows };
};

test("the cursor: a first run starts at the head and hands nothing old on; each run moves at most maxBlocksPerRun; a run with nothing new moves nothing", async () => {
  const store = new MemoryWatchStore();
  const delivered: bigint[] = [];
  const { port, windows } = fakePort(1_000n, [buy(1, 400n), buy(2, 1_000n), buy(3, 1_001n)]);
  const w = new Watcher({ port, store, chainId: 4663, maxBlocksPerRun: 100, now: () => clock, onBuy: async (b) => { delivered.push(b.block); } });
  const first = await w.run();
  assert.deepEqual(first, { from: 1_000n, to: 1_000n, buys: 1, delivered: 1 }, "the head only: turning the watcher on replays nothing");
  assert.deepEqual(delivered, [1_000n]);
  assert.equal(await store.cursor(4663), 1_000n);
  const idle = await w.run();
  assert.deepEqual(idle, { from: 1_001n, to: 1_000n, buys: 0, delivered: 0 });
  assert.equal(await store.cursor(4663), 1_000n, "an idle run leaves the cursor");
  assert.equal(windows.length, 1, "an idle run reads no logs");
  // The chain moved on by a lot: the run takes its hundred and no more.
  const { port: far } = fakePort(5_000n, [buy(4, 1_050n), buy(5, 1_100n), buy(6, 1_101n)]);
  const catching = new Watcher({ port: far, store, chainId: 4663, maxBlocksPerRun: 100, onBuy: async (b) => { delivered.push(b.block); } });
  assert.deepEqual(await catching.run(), { from: 1_001n, to: 1_100n, buys: 2, delivered: 2 });
  assert.equal(await store.cursor(4663), 1_100n);
  assert.deepEqual(await catching.run(), { from: 1_101n, to: 1_200n, buys: 1, delivered: 1 });
  assert.deepEqual(delivered, [1_000n, 1_050n, 1_100n, 1_101n]);
  assert.equal(await store.cursor(46630), undefined, "the cursor is per chain");
});

test("a hash is handed on once: the same window scanned again (a cursor write the host lost) finds the mark and delivers nothing; the mark is written before the handler runs", async () => {
  const store = new MemoryWatchStore();
  const delivered: Hex[] = [];
  let markedBeforeHandler = false;
  const { port } = fakePort(1_000n, [buy(1, 1_000n)]);
  const w = new Watcher({ port, store, chainId: 4663, now: () => clock, onBuy: async (b) => { markedBeforeHandler = await store.seen(b.txHash); delivered.push(b.txHash); } });
  await w.run();
  assert.deepEqual(delivered, [hash(1)]);
  assert.equal(markedBeforeHandler, true, "a run killed inside the handler must not hand this buy on again");
  assert.equal(store.seenAt.get(hash(1)), clock.toISOString());
  // As if the run died before its cursor write: the cursor is back where it was, the mark is not.
  store.cursors.delete(4663);
  const again = await w.run();
  assert.deepEqual(again, { from: 1_000n, to: 1_000n, buys: 1, delivered: 0 }, "found again, handed on no more");
  assert.deepEqual(delivered, [hash(1)]);
  assert.equal(await store.cursor(4663), 1_000n, "the cursor is written even when nothing new was handed on");
});

test("a handler that throws costs one buy, not the run: the next buy is handed on, both are marked, the cursor moves, the run reports what got through", async () => {
  const store = new MemoryWatchStore();
  const delivered: Hex[] = [];
  const { port } = fakePort(10n, [buy(1, 10n), buy(2, 10n), buy(3, 10n)]);
  const w = new Watcher({ port, store, chainId: 4663, onBuy: async (b) => { if (b.txHash === hash(2)) throw new Error("telegram down"); delivered.push(b.txHash); } });
  const r = await w.run();
  assert.deepEqual(r, { from: 10n, to: 10n, buys: 3, delivered: 2 });
  assert.deepEqual(delivered, [hash(1), hash(3)]);
  assert.equal(await store.seen(hash(2)), true, "the one that broke is marked too: it is not retried into a loop");
  assert.equal(await store.cursor(4663), 10n);
});

test("one buy per transaction: a transaction that bought in two pools is handed on once, as its largest buy, in block order", () => {
  const a = buy(1, 12n, parseEther("0.1"));
  const b = { ...buy(1, 12n, parseEther("0.4"), USDC), poolId: poolId(2) };
  const c = buy(2, 11n);
  assert.deepEqual(onePerTransaction([a, b, c]).map((x) => [x.txHash, x.token, x.block]), [[hash(2), PEPE, 11n], [hash(1), USDC, 12n]]);
  assert.equal(isEthInBuy(-1n, 1n), true);
  assert.equal(isEthInBuy(1n, -1n), false, "a sell: ETH out, tokens in");
  assert.equal(isEthInBuy(-1n, 0n), false);
});

// ---------- the port over scripted logs ----------

const SWAP = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
const INITIALIZE = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");

type RawLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; transactionIndex: Hex; blockHash: Hex; logIndex: Hex; removed: boolean };
let logIndex = 0;
const swapLog = (id: Hex, amount0: bigint, amount1: bigint, block: bigint, tx: Hex): RawLog => ({
  address: POOL_MANAGER,
  topics: encodeEventTopics({ abi: [SWAP], eventName: "Swap", args: { id, sender: ROUTER } }) as Hex[],
  data: encodeAbiParameters([{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }], [amount0, amount1, 1n << 96n, 10n ** 18n, 0, 3000]),
  blockNumber: numberToHex(block), transactionHash: tx, transactionIndex: "0x0", blockHash: hash(0xb10c), logIndex: numberToHex(logIndex++), removed: false,
});
const initLog = (id: Hex, currency0: Address, currency1: Address, block: bigint): RawLog => ({
  address: POOL_MANAGER,
  topics: encodeEventTopics({ abi: [INITIALIZE], eventName: "Initialize", args: { id, currency0, currency1 } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "uint160" }, { type: "int24" }], [3000, 60, NATIVE, 1n << 96n, 0]),
  blockNumber: numberToHex(block), transactionHash: hash(0x1000 + Number(block)), transactionIndex: "0x0", blockHash: hash(0xb10c), logIndex: numberToHex(logIndex++), removed: false,
});

/** eth_getLogs as the node filters it: by address, block range and each topic position (null any, a string one, a list any of). */
const matches = (log: RawLog, filter: { address?: string; fromBlock: Hex; toBlock: Hex; topics?: (Hex | Hex[] | null)[] }): boolean => {
  if (filter.address && filter.address.toLowerCase() !== log.address.toLowerCase()) return false;
  const b = BigInt(log.blockNumber);
  if (b < BigInt(filter.fromBlock) || b > BigInt(filter.toBlock)) return false;
  return (filter.topics ?? []).every((t, i) => {
    if (t === null || t === undefined) return true;
    const have = log.topics[i]?.toLowerCase();
    return Array.isArray(t) ? t.some((x) => x.toLowerCase() === have) : t.toLowerCase() === have;
  });
};

const scriptedChain = (head: bigint, logs: RawLog[], senders: Record<string, Address>) => {
  const calls: { method: string; params: unknown }[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push({ method, params });
      if (method === "eth_blockNumber") return numberToHex(head);
      if (method === "eth_getLogs") return logs.filter((l) => matches(l, (params as [never])[0]));
      if (method === "eth_getTransactionByHash") {
        const h = ((params as [Hex])[0]).toLowerCase();
        const from = senders[h];
        if (!from) throw new Error(`no such tx ${h}`);
        return { hash: h, from, to: ROUTER, blockNumber: "0x10", blockHash: hash(0xb10c), transactionIndex: "0x0", nonce: "0x1", value: "0x0", gas: "0x5208", gasPrice: "0x1", input: "0x", type: "0x0", v: "0x1b", r: "0x1", s: "0x1" };
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  return { transport, calls };
};

test("log decoding: an ETH-in swap is a buy with the tx's sender as buyer; a sell is ignored; a pool with no Initialize found is skipped; a pool that is not an ETH pool is skipped; two swaps of one tx in one pool are one buy summed; the sender is asked once per hash", async () => {
  const ethPool = poolId(1), unknownPool = poolId(2), usdcPool = poolId(3);
  const logs = [
    // Opened long before the window: found by the id lookup, not by the window's own Initialize scan.
    initLog(ethPool, NATIVE, PEPE, 50n),
    initLog(usdcPool, USDC, PEPE, 60n),
    swapLog(ethPool, -parseEther("0.6"), 600n, 1_000n, hash(1)),
    swapLog(ethPool, parseEther("0.2"), -200n, 1_000n, hash(2)),
    swapLog(unknownPool, -parseEther("5"), 5n, 1_001n, hash(3)),
    swapLog(usdcPool, -parseEther("5"), 5n, 1_001n, hash(4)),
    swapLog(ethPool, -parseEther("0.1"), 100n, 1_002n, hash(5)),
    swapLog(ethPool, -parseEther("0.3"), 300n, 1_002n, hash(5)),
  ];
  const senders: Record<string, Address> = { [hash(1)]: BUYER, [hash(2)]: BUYER, [hash(3)]: BUYER, [hash(4)]: BUYER, [hash(5)]: "0x0000000000000000000000000000000000000b02" };
  const node = scriptedChain(1_002n, logs, senders);
  const port = createWatchPort({ chainId: 4663, rpcUrl: "http://fake", poolManager: POOL_MANAGER, transport: node.transport, initLookbackBlocks: 2_000n });
  assert.equal(await port.latestBlock(), 1_002n);
  const buys = await port.buysBetween(1_000n, 1_002n);
  assert.deepEqual(buys.map((b) => ({ ...b, tokensOut: b.tokensOut.toString(), ethInWei: b.ethInWei.toString() })), [
    { block: 1_000n, txHash: hash(1), buyer: BUYER, token: PEPE, ethInWei: parseEther("0.6").toString(), tokensOut: "600", poolId: ethPool },
    { block: 1_002n, txHash: hash(5), buyer: "0x0000000000000000000000000000000000000b02", token: PEPE, ethInWei: parseEther("0.4").toString(), tokensOut: "400", poolId: ethPool },
  ]);
  const txAsks = node.calls.filter((c) => c.method === "eth_getTransactionByHash").map((c) => (c.params as [Hex])[0]);
  assert.deepEqual(txAsks, [hash(1), hash(5)], "the sender is asked for buys only, once per hash");
  const logAsks = node.calls.filter((c) => c.method === "eth_getLogs").map((c) => (c.params as [{ topics?: unknown[]; fromBlock: Hex; toBlock: Hex }])[0]);
  const lookups = logAsks.filter((f) => Array.isArray(f.topics?.[1]));
  assert.ok(lookups.length >= 1, "the unknown ids were looked for by id");
  assert.deepEqual((lookups[0]!.topics![1] as Hex[]).slice().sort(), [ethPool, unknownPool, usdcPool].sort(), "every id met for the first time, in one filter");
  assert.ok(lookups.every((f) => BigInt(f.toBlock) < 1_000n), "looked for before the window");
  // A second window: the pools are remembered, only the swaps are read; the unknown one is not asked for again.
  node.calls.length = 0;
  logs.push(swapLog(ethPool, -parseEther("1"), 1n, 1_003n, hash(6)), swapLog(unknownPool, -parseEther("1"), 1n, 1_003n, hash(7)));
  senders[hash(6)] = BUYER;
  const again = await port.buysBetween(1_003n, 1_003n);
  assert.deepEqual(again.map((b) => b.txHash), [hash(6)]);
  assert.equal(node.calls.filter((c) => c.method === "eth_getLogs" && Array.isArray((c.params as [{ topics?: unknown[] }])[0].topics?.[1])).length, 0, "no id lookup the second time");
});

test("a pool opened inside the window is named by the window's own Initialize scan, so its first buy is a buy", async () => {
  const fresh = poolId(9);
  const logs = [initLog(fresh, NATIVE, USDC, 2_000n), swapLog(fresh, -parseEther("2"), 20n, 2_000n, hash(8))];
  const node = scriptedChain(2_000n, logs, { [hash(8)]: BUYER });
  const port = createWatchPort({ chainId: 4663, rpcUrl: "http://fake", poolManager: POOL_MANAGER, transport: node.transport, initLookbackBlocks: 100n });
  const buys = await port.buysBetween(2_000n, 2_000n);
  assert.equal(buys.length, 1);
  assert.equal(buys[0]!.token, USDC);
  assert.equal(node.calls.filter((c) => c.method === "eth_getLogs" && Array.isArray((c.params as [{ topics?: unknown[] }])[0].topics?.[1])).length, 0, "nothing was unknown, no lookup");
});

test("the transaction's sender is read into the buyer field, never the swap's sender (the router)", async () => {
  const id = poolId(1);
  const node = scriptedChain(10n, [initLog(id, NATIVE, PEPE, 1n), swapLog(id, -1n, 1n, 10n, hash(1))], { [hash(1)]: BUYER });
  const port = createWatchPort({ chainId: 4663, rpcUrl: "http://fake", poolManager: POOL_MANAGER, transport: node.transport, initLookbackBlocks: 100n });
  const [b] = await port.buysBetween(10n, 10n);
  assert.equal(b!.buyer, BUYER);
  assert.notEqual(b!.buyer.toLowerCase(), ROUTER.toLowerCase());
});

// ---------- the neon store ----------

const fakeSql = (answer: (query: string, params: unknown[]) => readonly Record<string, unknown>[] | undefined) => {
  const calls: { query: string; params: unknown[] }[] = [];
  const sql: WatchSql & { calls: typeof calls } = {
    calls,
    async query(query, params = []) {
      calls.push({ query, params });
      if (/^\s*CREATE/.test(query)) return [];
      const rows = answer(query, params);
      if (rows === undefined) throw new Error(`unexpected sql: ${query}`);
      return rows;
    },
  };
  return sql;
};

test("neon: the cursor is one row per chain, written with an upsert that also prunes seen hashes older than seven days; a hash is marked with an insert that ignores a repeat; hashes are stored lowercase", async () => {
  const sql = fakeSql((query, params) => {
    if (query.includes("SELECT block FROM bot_watch_cursor")) return params[0] === 4663 ? [{ block: "1000" }] : [];
    if (query.includes("INSERT INTO bot_watch_cursor")) return [];
    if (query.includes("DELETE FROM bot_watch_seen")) return [];
    if (query.includes("SELECT 1 FROM bot_watch_seen")) return params[0] === hash(1) ? [{ "?column?": 1 }] : [];
    if (query.includes("INSERT INTO bot_watch_seen")) return [];
    return undefined;
  });
  const store = new NeonWatchStore(sql);
  assert.equal(await store.cursor(4663), 1000n);
  assert.equal(await store.cursor(46630), undefined);
  await store.setCursor(4663, 1_100n);
  const up = sql.calls.find((c) => c.query.includes("INSERT INTO bot_watch_cursor"))!;
  assert.match(up.query, /ON CONFLICT \(chain_id\) DO UPDATE SET block = EXCLUDED.block/);
  assert.deepEqual(up.params, [4663, "1100"]);
  assert.match(sql.calls.at(-1)!.query, /DELETE FROM bot_watch_seen WHERE seen_at < NOW\(\) - INTERVAL '7 days'/, "pruned on every cursor write, once a run");
  assert.equal(await store.seen(hash(1)), true);
  assert.equal(await store.seen(hash(2)), false);
  await store.markSeen(("0x" + "AB".repeat(32)) as Hex, clock);
  const mark = sql.calls.at(-1)!;
  assert.match(mark.query, /INSERT INTO bot_watch_seen \(tx_hash, seen_at\) VALUES \(\$1, \$2\) ON CONFLICT \(tx_hash\) DO NOTHING/);
  assert.deepEqual(mark.params, ["0x" + "ab".repeat(32), clock.toISOString()]);
  const schema = sql.calls.filter((c) => /^\s*CREATE/.test(c.query)).map((c) => c.query);
  assert.ok(schema.some((q) => q.includes("bot_watch_cursor")) && schema.some((q) => q.includes("bot_watch_seen")));
});
