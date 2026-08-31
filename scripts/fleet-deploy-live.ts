/**
 * Deploys the Fleet contracts to Robinhood Chain testnet (46630) and records the
 * result in deployments/fleet-46630.json.
 *
 * Requires two environment values, supplied by the operator — never invented:
 *   DEPLOYER_PRIVATE_KEY        funded deployer/operator key on chain 46630
 *   ROBINHOOD_TESTNET_RPC_URL   optional; defaults to the public testnet RPC
 *
 * Run:  npm run fleet-deploy:live
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { deployFleet } from "../src/fleet/deploy.js";

const DEFAULT_RPC = "https://rpc.testnet.chain.robinhood.com";

const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ROBINHOOD_TESTNET_RPC_URL ?? DEFAULT_RPC] } },
});

const keyFromEnv = (): `0x${string}` => {
  const value = process.env.DEPLOYER_PRIVATE_KEY;
  if (!value || !isHex(value) || value.length !== 66) {
    throw new Error("Set DEPLOYER_PRIVATE_KEY to a funded 32-byte hex key on chain 46630");
  }
  return value;
};

const main = async (): Promise<void> => {
  const account = privateKeyToAccount(keyFromEnv());
  const transport = http(process.env.ROBINHOOD_TESTNET_RPC_URL ?? DEFAULT_RPC);
  const wallet = createWalletClient({ account, chain: robinhoodTestnet, transport });
  const publicClient = createPublicClient({ chain: robinhoodTestnet, transport });

  console.log(`Deploying Fleet contracts to Robinhood testnet as operator ${account.address}...`);
  const record = await deployFleet({ wallet, publicClient, operator: account.address, network: "robinhood-testnet" });

  const out = path.resolve("deployments/fleet-46630.json");
  await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Deployed. Record written to ${out}`);
  console.log(record);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
