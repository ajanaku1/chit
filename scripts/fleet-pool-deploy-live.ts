/**
 * Deploys the Stage 2 FleetPool to Robinhood Chain testnet (46630) and records
 * it under `pool` in deployments/fleet-46630.json.
 *
 * Reads, never invents:
 *   DEPLOYER_PRIVATE_KEY        funded deployer/operator key on chain 46630
 *   ROBINHOOD_TESTNET_RPC_URL   optional; defaults to the public testnet RPC
 *
 * After this, set FLEET_POOL_ADDRESS in the host environment. Without it the
 * balance, draw, and sweep actions answer 503 rather than guess.
 *
 * Run:  npm run fleet-pool-deploy:live
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, isHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const DEFAULT_RPC = "https://rpc.testnet.chain.robinhood.com";
const RECORD = path.resolve("deployments/fleet-46630.json");
const RPC_URL = process.env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC;

const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const keyFromEnv = (): Hex => {
  const value = process.env.DEPLOYER_PRIVATE_KEY;
  if (!value || !isHex(value) || value.length !== 66) {
    throw new Error("Set DEPLOYER_PRIVATE_KEY to a funded 32-byte hex key on chain 46630");
  }
  return value;
};

const main = async (): Promise<void> => {
  const account = privateKeyToAccount(keyFromEnv());
  const transport = http(RPC_URL);
  const wallet = createWalletClient({ account, chain: robinhoodTestnet, transport });
  const publicClient = createPublicClient({ chain: robinhoodTestnet, transport });

  const artifactPath = path.resolve("artifacts/contracts/fleet/FleetPool.sol/FleetPool.json");
  const { abi, bytecode } = JSON.parse(await readFile(artifactPath, "utf8")) as {
    abi: readonly unknown[];
    bytecode: Hex;
  };

  const hash = await wallet.deployContract({ abi: abi as never, bytecode, args: [account.address] as never });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`FleetPool deploy failed: ${hash}`);
  const address = receipt.contractAddress as Address;
  console.log(`FleetPool ${address} (${hash})`);

  // Read the caps back from the chain rather than restating them here: the
  // record should say what was deployed, not what we meant to deploy.
  const read = (functionName: string) =>
    publicClient.readContract({ address, abi: abi as never, functionName } as never) as Promise<bigint>;
  const [depositorCap, drawCap, poolCap, headroom] = await Promise.all([
    read("DEPOSITOR_CAP"), read("DRAW_CAP"), read("POOL_CAP"), read("GAS_HEADROOM"),
  ]);

  const record = JSON.parse(await readFile(RECORD, "utf8")) as Record<string, unknown>;
  record["pool"] = {
    address,
    operator: account.address,
    deployTx: hash,
    caps: {
      perDepositor: depositorCap.toString(),
      perDraw: drawCap.toString(),
      pool: poolCap.toString(),
      gasHeadroom: headroom.toString(),
    },
    deployedAt: new Date().toISOString(),
  };
  await writeFile(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`recorded pool in ${RECORD}`);
  console.log("Next: set FLEET_POOL_ADDRESS in the host environment, then redeploy.");
};

main().catch((error: unknown) => { console.error(error); process.exit(1); });
