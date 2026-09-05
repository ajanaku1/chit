/**
 * Seeds the Stage 1 venue on Robinhood Chain testnet (46630): deploys the
 * FLEET test token and the pool seeder, then initialises the ETH/FLEET Uniswap
 * v4 pool with one full-range position through the live PoolManager. Records
 * the result under `venue` in deployments/fleet-46630.json.
 *
 * Reads, never invents:
 *   DEPLOYER_PRIVATE_KEY        funded deployer/operator key on chain 46630
 *   ROBINHOOD_TESTNET_RPC_URL   optional; defaults to the public testnet RPC
 *   FLEET_VENUE_ETH             optional ETH to seed, default 0.005
 *
 * Run:  npm run fleet-venue:live
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, isHex, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { venuePoolKey } from "../src/fleet/v4-swap.js";

const DEFAULT_RPC = "https://rpc.testnet.chain.robinhood.com";
/** Verified live on 46630 (specs/001-fleet-mission/research.md). */
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const RECORD = path.resolve("deployments/fleet-46630.json");
const SUPPLY = parseEther("1000000");
const FULL_RANGE = { lower: -887_220, upper: 887_220 } as const;

const RPC_URL = process.env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC;
const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const isqrt = (n: bigint): bigint => {
  let x = n, y = (n + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
};
/** 1 ETH = 1000 FLEET. Liquidity sized so the ETH side is `eth`. */
const SQRT_PRICE_1000 = isqrt(1000n * 2n ** 192n);
const liquidityFor = (eth: bigint): bigint => (eth * SQRT_PRICE_1000) / 2n ** 96n;

const keyFromEnv = (): Hex => {
  const value = process.env.DEPLOYER_PRIVATE_KEY;
  if (!value || !isHex(value) || value.length !== 66) {
    throw new Error("Set DEPLOYER_PRIVATE_KEY to a funded 32-byte hex key on chain 46630");
  }
  return value;
};

const artifact = async (name: string): Promise<{ abi: readonly unknown[]; bytecode: Hex }> => {
  const file = path.resolve(`artifacts/contracts/fleet/${name}.sol/${name}.json`);
  const parsed = JSON.parse(await readFile(file, "utf8")) as { abi: readonly unknown[]; bytecode: Hex };
  return parsed;
};

const main = async (): Promise<void> => {
  const account = privateKeyToAccount(keyFromEnv());
  const transport = http(RPC_URL);
  const wallet = createWalletClient({ account, chain: robinhoodTestnet, transport });
  const publicClient = createPublicClient({ chain: robinhoodTestnet, transport });
  const seedEth = parseEther(process.env.FLEET_VENUE_ETH || "0.005");

  const deploy = async (name: string, args: readonly unknown[]): Promise<{ address: Address; tx: Hex }> => {
    const { abi, bytecode } = await artifact(name);
    const tx = await wallet.deployContract({ abi: abi as never, bytecode, args: args as never });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${name} deploy failed: ${tx}`);
    console.log(`${name} ${receipt.contractAddress} (${tx})`);
    return { address: receipt.contractAddress, tx };
  };

  const token = await deploy("FleetVenueToken", [SUPPLY]);
  const seeder = await deploy("FleetPoolSeeder", [POOL_MANAGER]);
  const { abi: tokenAbi } = await artifact("FleetVenueToken");
  const { abi: seederAbi } = await artifact("FleetPoolSeeder");

  const approveTx = await wallet.writeContract({ address: token.address, abi: tokenAbi as never, functionName: "approve", args: [seeder.address, SUPPLY] });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });

  const key = venuePoolKey(token.address);
  const seedTx = await wallet.writeContract({
    address: seeder.address, abi: seederAbi as never, functionName: "seed",
    args: [key, SQRT_PRICE_1000, FULL_RANGE.lower, FULL_RANGE.upper, liquidityFor(seedEth)], value: seedEth,
  });
  const seedReceipt = await publicClient.waitForTransactionReceipt({ hash: seedTx });
  if (seedReceipt.status !== "success") throw new Error(`seed failed: ${seedTx}`);
  console.log(`pool seeded (${seedTx})`);

  const record = JSON.parse(await readFile(RECORD, "utf8")) as Record<string, unknown>;
  record["venue"] = {
    poolManager: POOL_MANAGER, token: token.address, seeder: seeder.address,
    pool: { ...key, sqrtPriceX96: SQRT_PRICE_1000.toString(), tickLower: FULL_RANGE.lower, tickUpper: FULL_RANGE.upper },
    tokenTx: token.tx, seederTx: seeder.tx, seedTx, seedEth: seedEth.toString(), seededAt: new Date().toISOString(),
  };
  await writeFile(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`recorded venue in ${RECORD}`);
};

main().catch((error: unknown) => { console.error(error); process.exit(1); });
