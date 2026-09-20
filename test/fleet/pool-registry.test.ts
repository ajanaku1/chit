/**
 * The pool registry: a recorded token's pool is the record's, read from
 * storage alone, whatever pools anyone else opened for it and however deep
 * (on 4663 the record is $CHIT's launchpad pool, the buyback's), and an
 * empty recorded pool is no pool rather than a reason to look for another;
 * the operator's BOT_POOL_KEYS add to the record and are refused when
 * malformed. Any other token is discovered: every opening over the whole
 * chain in one query plus the common keys, gathered before any is chosen,
 * the deepest live one winning hooked or not; a node that refuses the span
 * is read in pieces. The bot's chain adapter carries the answer as
 * `poolOnRecord`, which is what the copy desk gates its mirrors on.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { type Address, createPublicClient, custom, decodeFunctionData, defineChain, encodeAbiParameters, encodeEventTopics, getAddress, type Hex, numberToHex, parseAbi, parseAbiItem, type PublicClient } from "viem";
import { createBotChain } from "../../src/fleet/bot-chain.js";
import { liquiditySlot, slot0Slot } from "../../src/fleet/market.js";
import { RECORDED_POOLS, createPoolRegistry, poolIdOf, recordedPoolsFromEnv } from "../../src/fleet/pool-registry.js";
import { NATIVE_ETH, type PoolKey } from "../../src/fleet/v4-swap.js";

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
const CHIT = "0xd523a627030509021cc39b6d7c8543417d3e50d8" as Address;
const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const HOOK = "0x0000000000000000000000000000000000007700" as Address;
const HEAD = 3_000_000n;
const Q96 = 1n << 96n;

const INITIALIZE = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const EXTSLOAD = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const ERC20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

type RawLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; transactionIndex: Hex; blockHash: Hex; logIndex: Hex; removed: boolean };
const word = (n: bigint): Hex => numberToHex(n, { size: 32 });
const initLog = (key: PoolKey, block: bigint): RawLog => ({
  address: POOL_MANAGER,
  topics: encodeEventTopics({ abi: [INITIALIZE], eventName: "Initialize", args: { id: poolIdOf(key), currency0: key.currency0, currency1: key.currency1 } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "uint160" }, { type: "int24" }], [key.fee, key.tickSpacing, key.hooks, Q96, 0]),
  blockNumber: numberToHex(block), transactionHash: word(block), transactionIndex: "0x0", blockHash: word(1n), logIndex: numberToHex(Number(block)), removed: false,
});
const matches = (log: RawLog, filter: { address?: string; fromBlock: Hex; toBlock: Hex | "latest"; topics?: (Hex | Hex[] | null)[] }): boolean => {
  if (filter.address && filter.address.toLowerCase() !== log.address.toLowerCase()) return false;
  const b = BigInt(log.blockNumber);
  if (b < BigInt(filter.fromBlock) || b > (filter.toBlock === "latest" ? HEAD : BigInt(filter.toBlock))) return false;
  return (filter.topics ?? []).every((t, i) => {
    if (t === null || t === undefined) return true;
    const have = log.topics[i]?.toLowerCase();
    return Array.isArray(t) ? t.some((x) => x.toLowerCase() === have) : t.toLowerCase() === have;
  });
};

/**
 * A pool manager with the pools it is told of (each with a price and a
 * liquidity), read through extsload, and their openings as Initialize logs;
 * `maxSpan` makes it a node that refuses a log query wider than that.
 */
const scriptedChain = (pools: Array<{ key: PoolKey; block: bigint; liquidity: bigint; sqrtPriceX96?: bigint }>, opts: { maxSpan?: bigint; meta?: Record<string, { symbol: string; decimals: number }> } = {}) => {
  const storage = new Map<string, bigint>();
  for (const p of pools) {
    const id = poolIdOf(p.key);
    storage.set(slot0Slot(id).toLowerCase(), p.sqrtPriceX96 ?? Q96);
    storage.set(liquiditySlot(id).toLowerCase(), p.liquidity);
  }
  const logs = pools.map((p) => initLog(p.key, p.block));
  const calls: { method: string; params: unknown }[] = [];
  // No retries: a refused query is one refusal in the count, as it is on a node that means it.
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push({ method, params });
      if (method === "eth_blockNumber") return numberToHex(HEAD);
      if (method === "eth_getLogs") {
        const f = (params as [{ fromBlock: Hex; toBlock: Hex | "latest" }])[0];
        const to = f.toBlock === "latest" ? HEAD : BigInt(f.toBlock);
        if (opts.maxSpan !== undefined && to - BigInt(f.fromBlock) > opts.maxSpan) throw new Error("query returned more than 10000 results");
        return logs.filter((l) => matches(l, f as never));
      }
      if (method === "eth_call") {
        const { to, data } = (params as [{ to: Address; data: Hex }])[0];
        if (to.toLowerCase() === POOL_MANAGER) {
          const { args } = decodeFunctionData({ abi: EXTSLOAD, data });
          return word(storage.get((args[0] as Hex).toLowerCase()) ?? 0n);
        }
        const m = opts.meta?.[to.toLowerCase()];
        if (!m) throw new Error(`no such contract ${to}`);
        const { functionName } = decodeFunctionData({ abi: ERC20, data });
        return functionName === "symbol" ? encodeAbiParameters([{ type: "string" }], [m.symbol]) : encodeAbiParameters([{ type: "uint8" }], [m.decimals]);
      }
      throw new Error(`unexpected ${method}`);
    },
  }, { retryCount: 0 });
  const client = createPublicClient({ chain: defineChain({ id: 4663, name: "rh", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://fake"] } } }), transport }) as unknown as PublicClient;
  const logQueries = () => calls.filter((c) => c.method === "eth_getLogs").map((c) => (c.params as [{ fromBlock: Hex; toBlock: Hex; topics?: unknown[] }])[0]);
  const storageReads = () => calls.filter((c) => c.method === "eth_call" && (c.params as [{ to: string }])[0].to.toLowerCase() === POOL_MANAGER).length;
  return { client, transport, calls, logQueries, storageReads };
};

const CHIT_POOL = RECORDED_POOLS[4663]![0]!;
const decoy = (token: Address, fee = 3000, tickSpacing = 60): PoolKey => ({ currency0: NATIVE_ETH, currency1: token, fee, tickSpacing, hooks: NATIVE_ETH });

test("the record: $CHIT's pool on 4663 is the recorded key, the buyback's pool by id and by key, read from storage alone: no log is read and no common key is asked, so a deeper hookless pool anyone opened for $CHIT is not its pool; an empty recorded pool is no pool, not a reason to discover another", async () => {
  const record = JSON.parse(await readFile(join(repoRoot, "deployments/buyback-4663.json"), "utf8")) as { token: string; poolId: Hex; poolKey: PoolKey };
  assert.equal(CHIT_POOL.currency1.toLowerCase(), record.token.toLowerCase());
  assert.equal(poolIdOf(CHIT_POOL), record.poolId, "the record is the deployment's pool");
  assert.deepEqual({ ...CHIT_POOL, hooks: CHIT_POOL.hooks.toLowerCase() }, { ...record.poolKey, hooks: record.poolKey.hooks.toLowerCase() });
  // The attacker's pool: the venue's hookless key, a narrow position with a liquidity number far above the launchpad pool's, priced at five times the market.
  const node = scriptedChain([
    { key: CHIT_POOL, block: 100n, liquidity: 10n ** 22n },
    { key: decoy(CHIT), block: HEAD - 10n, liquidity: 10n ** 25n, sqrtPriceX96: Q96 / 5n },
  ]);
  const registry = createPoolRegistry(node.client, POOL_MANAGER, { chainId: 4663 });
  const found = await registry.find(CHIT);
  assert.deepEqual(found, { key: CHIT_POOL, id: record.poolId, sqrtPriceX96: Q96, liquidity: 10n ** 22n, hooked: true, onRecord: true });
  assert.equal(node.logQueries().length, 0, "nothing was looked for on the chain");
  assert.equal(node.storageReads(), 2, "the recorded pool's two words, no common key");
  // Emptied: null, and still nothing else is looked for; the decoy is never the answer.
  const empty = scriptedChain([{ key: CHIT_POOL, block: 100n, liquidity: 0n }, { key: decoy(CHIT), block: HEAD - 10n, liquidity: 10n ** 25n }]);
  assert.equal(await createPoolRegistry(empty.client, POOL_MANAGER, { chainId: 4663 }).find(CHIT), null);
  assert.equal(empty.logQueries().length, 0);
  assert.equal(empty.storageReads(), 2);
  // The operator's entry records another token the same way; a chain without a record has none unless the operator's.
  const hooked: PoolKey = { currency0: NATIVE_ETH, currency1: PEPE, fee: 0, tickSpacing: 200, hooks: HOOK };
  const withPepe = scriptedChain([{ key: hooked, block: 50n, liquidity: 5n }, { key: decoy(PEPE), block: HEAD - 1n, liquidity: 10n ** 25n }]);
  const own = createPoolRegistry(withPepe.client, POOL_MANAGER, { chainId: 46630, recorded: [hooked] });
  assert.deepEqual((await own.find(PEPE))!.key, hooked);
  assert.equal((await own.find(PEPE))!.onRecord, true);
  assert.equal(withPepe.logQueries().length, 0);
});

test("discovery: every candidate is gathered before any is chosen, the token's openings over the whole chain in one query and the common keys, and the deepest live one wins whether hooked or not; the answer is not the record's; a node that refuses the span is read in pieces of the recent chain", async () => {
  const hooked: PoolKey = { currency0: NATIVE_ETH, currency1: PEPE, fee: 0, tickSpacing: 200, hooks: HOOK };
  // The launch pool, hooked and older than any pieced scan would reach; a hookless common-key pool with a little liquidity; a common-key pool with none.
  const node = scriptedChain([
    { key: hooked, block: 100n, liquidity: 10n ** 22n },
    { key: decoy(PEPE, 500, 10), block: HEAD - 5n, liquidity: 10n ** 18n },
    { key: decoy(PEPE), block: HEAD - 4n, liquidity: 0n },
  ]);
  const registry = createPoolRegistry(node.client, POOL_MANAGER, { chainId: 4663 });
  const found = await registry.find(PEPE);
  assert.deepEqual(found, { key: hooked, id: poolIdOf(hooked), sqrtPriceX96: Q96, liquidity: 10n ** 22n, hooked: true, onRecord: false }, "the hooked launch pool is a candidate at all, and the deepest");
  const queries = node.logQueries();
  assert.equal(queries.length, 1, "the whole chain in one query");
  assert.deepEqual([queries[0]!.fromBlock, queries[0]!.toBlock], ["0x0", numberToHex(HEAD)]);
  assert.equal((queries[0]!.topics as Hex[])[3]!.toLowerCase(), `0x${PEPE.slice(2).padStart(64, "0")}`, "filtered by the token");
  // Five candidates read (three opened, of which two are common keys as well, plus the two other common keys), two words each.
  assert.equal(node.storageReads(), 10);
  assert.equal(await registry.find(PEPE), found, "remembered");
  assert.equal(node.logQueries().length, 1);
  // A node that will not take the whole chain: the last scanBlocks in pieces of 100 000, and the launch pool outside them is not found; the common keys still are.
  const strict = scriptedChain([{ key: hooked, block: 100n, liquidity: 10n ** 22n }, { key: decoy(PEPE, 500, 10), block: HEAD - 5n, liquidity: 10n ** 18n }], { maxSpan: 100_000n });
  const pieced = createPoolRegistry(strict.client, POOL_MANAGER, { chainId: 4663, scanBlocks: 250_000n });
  assert.deepEqual((await pieced.find(PEPE))!.key, decoy(PEPE, 500, 10), "what the recent chain and the common keys hold");
  const pieces = strict.logQueries();
  assert.equal(pieces.length, 4, "the refused one, then three pieces");
  assert.deepEqual(pieces.slice(1).map((q) => [BigInt(q.fromBlock), BigInt(q.toBlock)]), [[HEAD - 99_999n, HEAD], [HEAD - 199_999n, HEAD - 100_000n], [HEAD - 250_000n, HEAD - 200_000n]]);
});

test("recordedPoolsFromEnv: unset is nothing, entries are token:fee:tickSpacing:hooks with the addresses checksummed and the numbers whole, and anything else (a wrongly cased address among it) is refused in the caller's words without a pool half read", () => {
  const saved = process.env.BOT_POOL_KEYS;
  const refuse = (why: string): never => { throw new Error(why); };
  try {
    delete process.env.BOT_POOL_KEYS;
    assert.deepEqual(recordedPoolsFromEnv(refuse), []);
    process.env.BOT_POOL_KEYS = " ";
    assert.deepEqual(recordedPoolsFromEnv(refuse), []);
    process.env.BOT_POOL_KEYS = `${PEPE}:0:200:0xe5e702641ea86f4ae6cc3cdaed2b886f976be044, ${getAddress(CHIT)}:3000:60:${NATIVE_ETH}`;
    assert.deepEqual(recordedPoolsFromEnv(refuse), [
      { currency0: NATIVE_ETH, currency1: getAddress(PEPE), fee: 0, tickSpacing: 200, hooks: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" },
      { currency0: NATIVE_ETH, currency1: getAddress(CHIT), fee: 3000, tickSpacing: 60, hooks: NATIVE_ETH },
    ]);
    for (const bad of [`${PEPE}:3000:60`, `${PEPE}:3000:60:nothook`, `${CHIT.toUpperCase().replace("0X", "0x")}:3000:60:${NATIVE_ETH}`, `pepe:3000:60:${NATIVE_ETH}`, `${PEPE}:0.3:60:${NATIVE_ETH}`, `${PEPE}:3000:0:${NATIVE_ETH}`, `${PEPE}:3000:60:${NATIVE_ETH};${PEPE}:3000:60:${NATIVE_ETH}`]) {
      process.env.BOT_POOL_KEYS = bad;
      assert.throws(() => recordedPoolsFromEnv(refuse), /^Error: BOT_POOL_KEYS must be token:fee:tickSpacing:hooks entries, comma separated \(each an ETH pool on the pool manager\)$/, bad);
    }
    // The record's own entry for $CHIT, spelled by the operator, replaces nothing and changes nothing: the same key.
    process.env.BOT_POOL_KEYS = `${CHIT}:0:200:${CHIT_POOL.hooks}`;
    assert.deepEqual(recordedPoolsFromEnv(refuse)[0], { ...CHIT_POOL, currency1: getAddress(CHIT) });
  } finally {
    if (saved === undefined) delete process.env.BOT_POOL_KEYS; else process.env.BOT_POOL_KEYS = saved;
  }
});

test("the bot's chain adapter: tokenInfo says poolOnRecord for the recorded pool and routes its quote through it, and not for a discovered one; a token with no live pool has neither", async () => {
  const hooked: PoolKey = { currency0: NATIVE_ETH, currency1: PEPE, fee: 0, tickSpacing: 200, hooks: HOOK };
  const node = scriptedChain([
    { key: CHIT_POOL, block: 100n, liquidity: 10n ** 22n },
    { key: decoy(CHIT), block: HEAD - 10n, liquidity: 10n ** 25n, sqrtPriceX96: Q96 / 5n },
    { key: hooked, block: 200n, liquidity: 10n ** 20n },
  ], { meta: { [CHIT]: { symbol: "CHIT", decimals: 18 }, [PEPE]: { symbol: "PEPE", decimals: 6 }, [HOOK]: { symbol: "NOPE", decimals: 18 } } });
  const chain = createBotChain({ chainId: 4663, rpcUrl: "http://fake", defaultToken: CHIT, router: "0x8876789976decbfcbbbe364623c63652db8c0904", poolManager: POOL_MANAGER, transport: node.transport });
  const chit = await chain.tokenInfo(CHIT);
  assert.equal(chit.hasPool, true);
  assert.equal(chit.poolOnRecord, true);
  assert.deepEqual(chit.poolKey, CHIT_POOL, "the recorded key, not the deeper decoy's");
  assert.equal(chit.hooked, true);
  assert.equal(chit.perEth, 10n ** 18n, "the recorded pool's price, one to one here, not the decoy's one to twenty-five");
  const quote = await chain.quoteBuy(CHIT, 10n ** 15n);
  assert.ok(quote && quote > 10n ** 15n / 2n && quote < 10n ** 15n, `about the recorded pool's fill: ${quote}`);
  const pepe = await chain.tokenInfo(PEPE);
  assert.equal(pepe.hasPool, true);
  assert.equal(pepe.poolOnRecord, false, "discovered: the desk will not mirror it");
  assert.deepEqual(pepe.poolKey, hooked);
  const nowhere = await chain.tokenInfo(HOOK);
  assert.equal(nowhere.hasPool, false);
  assert.equal(nowhere.poolOnRecord, undefined);
  assert.equal(nowhere.poolKey, undefined);
});
