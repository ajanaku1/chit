/**
 * T088: the forty-eight hour soak, sampled so it can be passed or failed.
 *
 *   npm run fleet-soak -- --watch      # sample every 10 minutes, append to the run
 *   npm run fleet-soak -- --once       # one sample and exit, for a cron
 *   npm run fleet-soak                 # read the run and answer the predicate
 *
 * The watcher appends one JSON line per sample to
 * `incidents/soak-<chainId>.jsonl`; the reader answers FR-039 and SC-004 from
 * that file and exits 1 when it does not hold. Sampling is read-only: it
 * calls nothing but the pool's public views, so it can run beside the
 * service, and stopping it does not stop the beta — it only ends the record,
 * which the verdict then reports as silence rather than as success.
 *
 * The watcher is deliberately dumb. Detection during the soak is the
 * monitor's and the alert sink's job (FR-023, FR-027); this exists so that
 * afterwards there is a record to point at instead of a memory of having
 * watched.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { createPublicClient, http, parseAbi, type Address } from "viem";

import { poolIsWhole, type PoolCounters } from "../src/fleet/pool-solvency.js";
import { soakSummary, soakVerdict, type Sample } from "../src/fleet/soak.js";

const CHAIN_ID = Number(process.env.FLEET_CHAIN_ID || 46630);
const RPC_URL = process.env.FLEET_RPC_URL || (CHAIN_ID === 4663 ? "https://rpc.mainnet.chain.robinhood.com" : "https://rpc.testnet.chain.robinhood.com");
const INTERVAL_MS = Number(process.env.SOAK_INTERVAL_MS || 10 * 60_000);
const WATCH = process.argv.includes("--watch");
const ONCE = process.argv.includes("--once");

const ABI = parseAbi([
  "function paused() view returns (bool)",
  "function operator() view returns (address)",
  "function totalDeposited() view returns (uint256)",
  "function everDeposited() view returns (uint256)",
  "function exitsPaid() view returns (uint256)",
  "function donated() view returns (uint256)",
  "function totalPosted() view returns (uint256)",
  "function totalOutflow() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function queuedSpendCount() view returns (uint256)",
  "function queuedSpendAt(uint256 index) view returns (bytes32 id, (bytes encDepositor, uint256 amount, uint64 dueAt, uint64 queuedAt, bool posted) entry)",
]);

const poolAddress = async (): Promise<Address> => {
  const fromEnv = process.env.FLEET_POOL_ADDRESS;
  if (fromEnv) return fromEnv as Address;
  const record = JSON.parse(await readFile(path.resolve(`deployments/fleet-${CHAIN_ID}.json`), "utf8"));
  const address = record?.pool?.address;
  if (!address) throw new Error(`deployments/fleet-${CHAIN_ID}.json names no pool; set FLEET_POOL_ADDRESS`);
  return address as Address;
};

const client = createPublicClient({ transport: http(RPC_URL) });

const sample = async (pool: Address): Promise<Sample> => {
  const read = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
    client.readContract({ address: pool, abi: ABI, functionName, args } as never) as Promise<T>;

  const block = await client.getBlock();
  const [paused, operator, count] = await Promise.all([read<boolean>("paused"), read<Address>("operator"), read<bigint>("queuedSpendCount")]);

  // The whole queue, oldest first: an entry is never removed, so the index is stable.
  let unposted = 0;
  let oldest = 0n;
  for (let i = 0n; i < count; i += 1n) {
    const [, entry] = await read<[unknown, { queuedAt: bigint; posted: boolean }]>("queuedSpendAt", [i]);
    if (entry.posted) continue;
    unposted += 1;
    const age = block.timestamp - entry.queuedAt;
    if (age > oldest) oldest = age;
  }

  // The identity `poolIsWhole` checks needs the pool's own balance and its
  // deposits too, and it must be the balance at the same block as the
  // counters, or a deposit landing between two reads reads as a shortfall.
  const [everDeposited, totalDeposited, exitsPaid, donated, totalPosted, totalOutflow, totalClaimed, balance] = await Promise.all([
    read<bigint>("everDeposited"), read<bigint>("totalDeposited"), read<bigint>("exitsPaid"), read<bigint>("donated"),
    read<bigint>("totalPosted"), read<bigint>("totalOutflow"), read<bigint>("totalClaimed"),
    client.getBalance({ address: pool, blockNumber: block.number }),
  ]);
  const counters: PoolCounters = { balance, everDeposited, totalDeposited, exitsPaid, donated, totalPosted, totalOutflow, totalClaimed };

  return {
    at: new Date().toISOString(),
    chainTime: Number(block.timestamp),
    blockNumber: Number(block.number),
    unposted,
    oldestUnpostedSeconds: Number(oldest),
    paused,
    whole: poolIsWhole(counters),
    operatorWei: (await client.getBalance({ address: operator })).toString(),
  };
};

const runFile = (): string => path.resolve(`incidents/soak-${CHAIN_ID}.jsonl`);

const readRun = async (): Promise<Sample[]> => {
  try {
    const text = await readFile(runFile(), "utf8");
    return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Sample);
  } catch {
    return [];
  }
};

/** One sample, appended and printed. Shared by the watcher and `--once`. */
const takeOne = async (pool: Address): Promise<void> => {
  try {
    const s = await sample(pool);
    await appendFile(runFile(), `${JSON.stringify(s)}\n`);
    const age = s.oldestUnpostedSeconds === 0 ? "none" : `${(s.oldestUnpostedSeconds / 60).toFixed(0)} min`;
    console.log(`${s.at}  block ${s.blockNumber}  unposted ${s.unposted} (oldest ${age})  ${s.paused ? "PAUSED" : "running"}  ${s.whole ? "whole" : "SHORT"}`);
  } catch (error) {
    // A read that failed is not a sample: the gap stands in the record, which
    // is the honest thing for it to say.
    console.error(`${new Date().toISOString()}  sample failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const once = async (): Promise<void> => {
  const pool = await poolAddress();
  await mkdir(path.dirname(runFile()), { recursive: true });
  await takeOne(pool);
};

const watch = async (): Promise<void> => {
  const pool = await poolAddress();
  await mkdir(path.dirname(runFile()), { recursive: true });
  console.log(`soaking ${pool} on ${CHAIN_ID}, a sample every ${(INTERVAL_MS / 60_000).toFixed(0)} min, into ${path.relative(process.cwd(), runFile())}`);
  console.log("leave this running; stopping it ends the record, and a gap is reported as silence, never as success");
  for (;;) {
    await takeOne(pool);
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
};

const report = async (): Promise<void> => {
  const samples = await readRun();
  const verdict = soakVerdict(samples);
  console.log(soakSummary(verdict, samples));
  if (verdict.pass) {
    console.log("\nT088 PASS: forty-eight hours covered, no charge unrecorded past four hours, the pool whole and running throughout.");
    return;
  }
  console.log("\nT088 not passed:");
  for (const fault of verdict.faults) console.log(`  - ${fault}`);
  process.exitCode = 1;
};

(WATCH ? watch() : ONCE ? once() : report()).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
