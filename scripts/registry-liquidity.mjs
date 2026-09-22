/**
 * FR-012's liquidity check, re-measured: one command for the day the beta
 * opens (T091), and the same command on a fork for the rehearsal.
 *
 * For every token in deployments/token-registry-<chainId>.json it reads the
 * pool the entry pins, by that key and nothing else, and prints the ETH side
 * at the current price as a multiple of the draw cap. The rule is the
 * registry's: at least fifty times the draw cap, or the token is not offered,
 * whatever the file says. An enabled entry under the floor makes the run
 * exit 1, so launch day is one command with an answer, not a reading.
 *
 *   node scripts/registry-liquidity.mjs                 # 4663, the live RPC
 *   node scripts/registry-liquidity.mjs --write         # and record the
 *                                                       # numbers in the file
 *                                                       # as the day's checks
 *   FLEET_CHAIN_ID=46630 node scripts/registry-liquidity.mjs
 *   FLEET_RPC_URL=http://127.0.0.1:8549 node scripts/registry-liquidity.mjs
 *                                                       # against a fork
 *
 * `--write` updates only `checks.liquidityEth`,
 * `checks.liquidityMultipleOfDrawCap` and `checks.checkedAt` for the entries
 * it measured: the other three checks are transfer behaviour, holder
 * restrictions and the fork test, which this does not perform and must not
 * claim. It never enables or disables an entry; that is a review, in a
 * commit, by a person.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createPublicClient, formatEther, http } from "viem";

import { createPoolRegistry } from "../dist-fleet/src/fleet/pool-registry.js";
import { LIQUIDITY_MULTIPLE, readTokenRegistry } from "../dist-fleet/src/fleet/token-registry.js";

const RPCS = { 4663: "https://rpc.mainnet.chain.robinhood.com", 46630: "https://rpc.testnet.chain.robinhood.com" };
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
/** The beta's per-draw cap, the figure FR-001 fixes and the registry measures against. */
const DRAW_CAP = 50_000_000_000_000_000n;
const Q96 = 2n ** 96n;

const chainId = Number(process.env.FLEET_CHAIN_ID ?? 4663);
const rpcUrl = process.env.FLEET_RPC_URL ?? RPCS[chainId];
const write = process.argv.includes("--write");
const file = path.resolve(`deployments/token-registry-${chainId}.json`);

if (!rpcUrl) {
  console.error(`no RPC for chain ${chainId}: set FLEET_RPC_URL`);
  process.exit(2);
}

let doc;
try {
  doc = JSON.parse(await readFile(file, "utf8"));
} catch (e) {
  // No registry for this chain is an answer, not a crash: the playground has none, and a launch day run names the file it wanted.
  if (e?.code === "ENOENT") { console.log(`no registry for chain ${chainId} (${path.basename(file)}); nothing to measure`); process.exit(0); }
  console.error(`${path.basename(file)} could not be read: ${e?.message ?? e}`);
  process.exit(2);
}
const registry = readTokenRegistry(doc, chainId);
if (registry.tokens.length === 0) {
  console.log(`${path.basename(file)} lists no token; nothing to measure`);
  process.exit(0);
}

// A public RPC rate-limits a burst; the reads are few and a retry is cheaper
// than a wrong answer. The sockets it opens are also why the verdict below
// sets `process.exitCode` rather than calling `process.exit`: forcing the
// process down while they are open aborts it on Windows, and launch day would
// read a crash where it needs a 1.
const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 6, retryDelay: 2000 }) });
const pools = createPoolRegistry(client, POOL_MANAGER, { chainId });
const at = new Date().toISOString();

console.log(`chain ${chainId}, draw cap ${formatEther(DRAW_CAP)} ETH, floor ${LIQUIDITY_MULTIPLE}× (${formatEther(DRAW_CAP * LIQUIDITY_MULTIPLE)} ETH), ${at}`);
console.log("");

let short = 0;
for (const entry of registry.tokens) {
  const state = await pools.state(entry.poolKey).catch((e) => { console.warn(`${entry.symbol}: the pool could not be read: ${e?.shortMessage ?? e?.message ?? e}`); return undefined; });
  const ethSide = state && state.sqrtPriceX96 > 0n ? (state.liquidity * Q96) / state.sqrtPriceX96 : 0n;
  const multiple = Number(ethSide) / Number(DRAW_CAP);
  const passes = ethSide >= DRAW_CAP * LIQUIDITY_MULTIPLE;
  const verdict = passes ? "meets the floor" : `UNDER THE FLOOR, not to be offered`;
  console.log(`${entry.symbol.padEnd(8)} ${entry.enabled ? "enabled " : "disabled"} pool ${entry.poolId.slice(0, 10)}… ${formatEther(ethSide).slice(0, 10).padStart(11)} ETH  ${multiple.toFixed(1).padStart(7)}×  ${verdict}`);
  if (entry.enabled && !passes) short += 1;
  if (write) {
    const raw = doc.tokens.find((t) => String(t.token).toLowerCase() === entry.token);
    // Only an entry that already carries its four checks is updated: --write records the day's number, it does not create a record.
    if (raw?.checks) {
      raw.checks.liquidityEth = Number(formatEther(ethSide)).toFixed(3);
      raw.checks.liquidityMultipleOfDrawCap = Math.floor(multiple);
      raw.checks.checkedAt = at;
    } else if (raw) {
      console.log(`         (not recorded: ${entry.symbol} has no checks on file, and this command records only the liquidity of an entry that does)`);
    }
  }
}

if (write) {
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\n${path.basename(file)} updated: liquidity and its date, for the entries that carry checks. The other three checks are untouched, and nothing was enabled or disabled.`);
}

if (short > 0) {
  console.error(`\n${short} enabled token${short === 1 ? "" : "s"} below ${LIQUIDITY_MULTIPLE}× the draw cap. FR-012: it must not be offered. Disable it in the registry or do not open with it.`);
  process.exitCode = 1;
} else {
  console.log(`\nevery enabled token meets the floor.`);
}
