/**
 * Deploys the SessionAccountFactory to Robinhood Chain (46630 by default) and
 * records it: under `sessionKeys` in deployments/fleet-<chain>.json and in
 * app/session-target.json, which is what the Sessions page reads.
 *
 * The factory has no owner, no operator and no fee; any key can deploy it
 * and the deployer never matters again. So this can be run by anyone with a
 * little ETH, and the record is the only thing that ties Chit to it.
 *
 * Reads, never invents:
 *   DEPLOYER_PRIVATE_KEY        a funded key on the chain
 *   ROBINHOOD_TESTNET_RPC_URL   optional; defaults to the public testnet RPC
 *   FLEET_CHAIN_ID              optional; 46630 (testnet) or 4663 (mainnet)
 *
 * Run:  npm run session-deploy:live
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, isHex, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = Number(process.env.FLEET_CHAIN_ID || 46630);
const DEFAULT_RPC = CHAIN_ID === 4663 ? "https://rpc.mainnet.chain.robinhood.com" : "https://rpc.testnet.chain.robinhood.com";
const RPC_URL = process.env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC;
const RECORD = path.resolve(`deployments/fleet-${CHAIN_ID}.json`);
const TARGET = path.resolve("app/session-target.json");

const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 4663 ? "Robinhood Chain" : "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const keyFromEnv = (): Hex => {
  const value = process.env.DEPLOYER_PRIVATE_KEY;
  if (!value || !isHex(value) || value.length !== 66) throw new Error("Set DEPLOYER_PRIVATE_KEY to a funded 32-byte hex key");
  return value;
};

const main = async (): Promise<void> => {
  const deployer = privateKeyToAccount(keyFromEnv());
  const transport = http(RPC_URL);
  const wallet = createWalletClient({ account: deployer, chain, transport });
  const publicClient = createPublicClient({ chain, transport });
  if ((await publicClient.getChainId()) !== CHAIN_ID) throw new Error(`the RPC is not chain ${CHAIN_ID}`);
  const balance = await publicClient.getBalance({ address: deployer.address });
  console.log(`deployer ${deployer.address} holds ${formatEther(balance)} ETH on ${CHAIN_ID}`);
  if (balance < parseEther("0.002")) throw new Error("fund the deployer with at least 0.002 ETH");

  const { abi, bytecode } = JSON.parse(await readFile(path.resolve("artifacts/contracts/fleet/SessionAccountFactory.sol/SessionAccountFactory.json"), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };
  const hash = await wallet.deployContract({ abi: abi as never, bytecode, args: [] as never });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`SessionAccountFactory deploy failed: ${hash}`);
  const factory = receipt.contractAddress as Address;
  console.log(`SessionAccountFactory ${factory} (${hash})`);

  let record: Record<string, unknown> = {};
  try { record = JSON.parse(await readFile(RECORD, "utf8")) as Record<string, unknown>; } catch { /* a new chain's first record */ }
  record["sessionKeys"] = { factory, deployTx: hash, deployer: deployer.address, deployedAt: new Date().toISOString() };
  await writeFile(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(TARGET, `${JSON.stringify({ chainId: CHAIN_ID, sessionFactory: factory }, null, 2)}\n`);
  console.log(`recorded under sessionKeys in ${RECORD} and in ${TARGET}; rebuild the app so the Sessions page sees it`);
};

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
