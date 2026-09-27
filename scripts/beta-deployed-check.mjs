/**
 * The capped beta is deployed, read from the chain rather than from the record.
 *
 * § 3 of docs/runbooks/mainnet-beta.md writes deployments/fleet-4663.json and
 * hands the admin role over in two steps. This answers whether all of it
 * landed: every contract in the record has code, the pool's caps are the
 * beta's, the cold admin has accepted both roles, the guardian is set and is
 * not the operator, and the pool is running. It exits 1 with every reason,
 * so `./verify.sh beta-deployed` is red until the deploy and the admin's two
 * acceptOwnership() calls are both done, and green only when the chain agrees.
 *
 *   node scripts/beta-deployed-check.mjs
 *   FLEET_RPC_URL=http://127.0.0.1:8549 node scripts/beta-deployed-check.mjs   # a fork
 */

import { readFile } from "node:fs/promises";
import { createPublicClient, http, parseAbi, parseEther, zeroAddress } from "viem";

const CHAIN_ID = 4663;
const RPC_URL = process.env.FLEET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const RECORD = `deployments/fleet-${CHAIN_ID}.json`;
const CAPS = { DEPOSITOR_CAP: parseEther("0.1"), DRAW_CAP: parseEther("0.05"), POOL_CAP: parseEther("1") };

const OWNED_ABI = parseAbi(["function owner() view returns (address)", "function pendingOwner() view returns (address)"]);
const POOL_ABI = parseAbi([
  "function DEPOSITOR_CAP() view returns (uint256)",
  "function DRAW_CAP() view returns (uint256)",
  "function POOL_CAP() view returns (uint256)",
  "function guardian() view returns (address)",
  "function operator() view returns (address)",
  "function paused() view returns (bool)",
]);

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

const readRecord = async () => {
  try {
    return JSON.parse(await readFile(RECORD, "utf8"));
  } catch {
    return null;
  }
};

const codeProblems = async (client, record) => {
  const contracts = { campaignEscrow: record.campaignEscrow, sessionPolicy: record.sessionPolicy, accountFactory: record.accountFactory, pool: record.pool?.address };
  const problems = [];
  for (const [name, address] of Object.entries(contracts)) {
    if (!address) { problems.push(`the record has no ${name}`); continue; }
    const code = await client.getCode({ address });
    if (!code || code === "0x") problems.push(`${name} ${address} holds no code on ${CHAIN_ID}`);
  }
  return problems;
};

const capProblems = async (read, pool) => {
  const problems = [];
  for (const [cap, expected] of Object.entries(CAPS)) {
    const actual = await read(pool, POOL_ABI, cap);
    if (actual !== expected) problems.push(`${cap} reads ${actual}, the beta's is ${expected}`);
  }
  return problems;
};

const ownershipProblems = async (read, record) => {
  const admin = record.admin ?? record.pool.admin;
  const problems = [];
  if (!admin || same(admin, record.operator)) problems.push(`the admin ${admin} is missing or is the operator`);
  for (const [name, address] of [["FleetSessionPolicy", record.sessionPolicy], ["FleetPool", record.pool.address]]) {
    const [owner, pending] = await Promise.all([read(address, OWNED_ABI, "owner"), read(address, OWNED_ABI, "pendingOwner")]);
    if (!same(owner, admin)) problems.push(`${name} is owned by ${owner}: the admin ${admin} has not accepted yet`);
    if (!same(pending, zeroAddress)) problems.push(`${name} still has ${pending} pending`);
  }
  return problems;
};

const roleProblems = async (read, record) => {
  const pool = record.pool.address;
  const [guardian, operator, paused] = await Promise.all([read(pool, POOL_ABI, "guardian"), read(pool, POOL_ABI, "operator"), read(pool, POOL_ABI, "paused")]);
  const problems = [];
  if (same(guardian, zeroAddress) || !same(guardian, record.pool.guardian)) problems.push(`the pool's guardian is ${guardian}, the record says ${record.pool.guardian}`);
  if (same(guardian, operator)) problems.push("the guardian is the operator");
  if (!same(operator, record.operator)) problems.push(`the pool's operator is ${operator}, the record says ${record.operator}`);
  if (paused) problems.push("the pool is paused");
  return problems;
};

const check = async (record) => {
  const client = createPublicClient({ transport: http(RPC_URL) });
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) return [`the RPC answers chain ${chainId}, not ${CHAIN_ID}`];
  const missing = await codeProblems(client, record);
  if (record.chainId !== CHAIN_ID) missing.push(`the record names chain ${record.chainId}`);
  if (missing.length > 0) return missing;
  const read = (address, abi, functionName) => client.readContract({ address, abi, functionName });
  return [...(await capProblems(read, record.pool.address)), ...(await ownershipProblems(read, record)), ...(await roleProblems(read, record))];
};

const record = await readRecord();
if (!record) {
  console.log(`not deployed: ${RECORD} does not exist (runbook § 3)`);
  process.exit(1);
}
const problems = await check(record);
if (problems.length > 0) {
  console.log(`not deployed as the beta needs:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`the beta is deployed on ${CHAIN_ID}: pool ${record.pool.address}, caps 0.1 / 0.05 / 1, admin accepted on both, guardian set, running`);
