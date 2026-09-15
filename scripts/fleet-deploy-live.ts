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
import { createPublicClient, createWalletClient, defineChain, http, isAddress, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { deployFleet } from "../src/fleet/deploy.js";

const DEFAULT_RPC = "https://rpc.testnet.chain.robinhood.com";

// Treat an empty env value (a blank line in .env) as unset, not as "".
const RPC_URL = process.env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC;

const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const keyFromEnv = (): `0x${string}` => {
  const value = process.env.DEPLOYER_PRIVATE_KEY;
  if (!value || !isHex(value) || value.length !== 66) {
    throw new Error("Set DEPLOYER_PRIVATE_KEY to a funded 32-byte hex key on chain 46630");
  }
  return value;
};


/**
 * The cold admin. Required and never defaulted: a deploy without it would make
 * the hot key its own admin, which is the thing the split exists to prevent.
 */
const adminFromEnv = (deployer: `0x${string}`): `0x${string}` => {
  const value = process.env.FLEET_ADMIN_ADDRESS;
  if (!value || !isAddress(value)) {
    throw new Error("Set FLEET_ADMIN_ADDRESS to the cold admin key's address (not the deployer)");
  }
  if (value.toLowerCase() === deployer.toLowerCase()) {
    throw new Error("FLEET_ADMIN_ADDRESS must not be the deployer: the admin is a different, cold key");
  }
  return value;
};

const main = async (): Promise<void> => {
  const account = privateKeyToAccount(keyFromEnv());
  const admin = adminFromEnv(account.address);
  const transport = http(RPC_URL);
  const wallet = createWalletClient({ account, chain: robinhoodTestnet, transport });
  const publicClient = createPublicClient({ chain: robinhoodTestnet, transport });

  console.log(`Deploying Fleet contracts to Robinhood testnet as operator ${account.address}...`);
  const record = await deployFleet({ wallet, publicClient, operator: account.address, admin, network: "robinhood-testnet" });

  const out = path.resolve("deployments/fleet-46630.json");
  await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Deployed. Record written to ${out}`);
  console.log(record);
  console.log(`\nNext: the admin ${admin} calls acceptOwnership() on FleetSessionPolicy ${record.sessionPolicy}`);
  console.log("      after the pool deploy has called setPool; until then the deployer still owns the policy.");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
