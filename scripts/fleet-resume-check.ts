/**
 * The resume gate, run before the admin unpauses (FR-035, T051): reads the
 * newest incident record, checks its test exists, reads the pool's counters
 * from the chain, and says whether the pool may be resumed. Read-only, no
 * key. Exit 1 on a refusal, with every reason.
 *
 *   FLEET_POOL_ADDRESS=0x… [FLEET_CHAIN_ID=4663] npm run fleet-resume-check
 */

import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createPublicClient, http, isAddress, parseAbi } from "viem";

import { resumeGate, type IncidentRecord } from "../src/fleet/resume-gate.js";
import type { PoolCounters } from "../src/fleet/pool-solvency.js";

const CHAIN_ID = Number(process.env.FLEET_CHAIN_ID || 46630);
const RPC_URL = process.env.FLEET_RPC_URL || (CHAIN_ID === 4663 ? "https://rpc.mainnet.chain.robinhood.com" : "https://rpc.testnet.chain.robinhood.com");
const ABI = parseAbi([
  "function paused() view returns (bool)",
  "function everDeposited() view returns (uint256)",
  "function totalDeposited() view returns (uint256)",
  "function totalPosted() view returns (uint256)",
  "function totalOutflow() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function exitsPaid() view returns (uint256)",
  "function donated() view returns (uint256)",
]);

const newestIncident = async (): Promise<IncidentRecord | undefined> => {
  const dir = path.resolve("incidents");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
  const name = files.at(-1);
  if (!name) return undefined;
  const text = await readFile(path.join(dir, name), "utf8");
  const field = (key: string): string => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text)?.[1]?.trim() ?? "";
  return { id: name.replace(/\.md$/, ""), trigger: field("trigger"), cause: field("cause"), fixedIn: field("fixedIn"), test: field("test"), publishedAt: field("publishedAt"), ...(field("madeWholeBy") ? { madeWholeBy: field("madeWholeBy") } : {}) };
};

const testExists = (name: string): boolean => {
  try {
    execFileSync("grep", ["-rqF", name, "test/"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const main = async (): Promise<void> => {
  const address = process.env.FLEET_POOL_ADDRESS;
  if (!address || !isAddress(address)) throw new Error("Set FLEET_POOL_ADDRESS to the paused pool");
  const client = createPublicClient({ transport: http(RPC_URL) });
  const read = (functionName: string) => client.readContract({ address, abi: ABI, functionName } as never) as Promise<bigint>;
  const paused = (await client.readContract({ address, abi: ABI, functionName: "paused" })) as boolean;
  const [balance, everDeposited, totalDeposited, totalPosted, totalOutflow, totalClaimed, exitsPaid, donated] = await Promise.all([
    client.getBalance({ address }), read("everDeposited"), read("totalDeposited"), read("totalPosted"), read("totalOutflow"), read("totalClaimed"), read("exitsPaid"), read("donated"),
  ]);
  const counters: PoolCounters = { balance, everDeposited, totalDeposited, totalPosted, totalOutflow, totalClaimed, exitsPaid, donated };
  const incident = await newestIncident();
  const verdict = resumeGate(incident, testExists, counters);
  console.log(`pool ${address} on ${CHAIN_ID}: ${paused ? "paused" : "not paused"}; incident ${incident?.id ?? "none"}`);
  for (const reason of verdict.reasons) console.log(`  refused: ${reason}`);
  if (!verdict.ok) process.exit(1);
  console.log("the gate passes: the admin may send setPaused(false)");
};

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
