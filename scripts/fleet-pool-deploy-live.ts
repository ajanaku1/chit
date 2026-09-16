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
import { createPublicClient, createWalletClient, defineChain, http, isAddress, isHex, type Address, type Hex } from "viem";
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

  const artifactPath = path.resolve("artifacts/contracts/fleet/FleetPool.sol/FleetPool.json");
  const { abi, bytecode } = JSON.parse(await readFile(artifactPath, "utf8")) as {
    abi: readonly unknown[];
    bytecode: Hex;
  };

  // `--resume <pool>` finishes the wiring for a pool whose deploy landed but
  // whose follow-ups did not (a dropped connection mid-run); nothing is
  // deployed twice. Otherwise the pool is deployed with the deployer as admin
  // so this script can finish the wiring; the admin role is offered to the
  // cold key at the end.
  const resumeAt = process.argv.indexOf("--resume");
  const resume = resumeAt >= 0 ? process.argv[resumeAt + 1] : undefined;
  let address: Address;
  let hash: Hex;
  if (resume) {
    if (!isAddress(resume)) throw new Error("--resume needs the pool address");
    const code = await publicClient.getCode({ address: resume });
    if (!code || code === "0x") throw new Error(`no code at ${resume}`);
    const owner = await publicClient.readContract({ address: resume, abi: abi as never, functionName: "owner" } as never) as Address;
    if (owner.toLowerCase() !== account.address.toLowerCase()) throw new Error(`the deployer does not own ${resume} (owner ${owner}); nothing to resume`);
    address = resume;
    hash = ((process.env.FLEET_POOL_DEPLOY_TX as Hex | undefined) ?? `0x${"0".repeat(64)}`) as Hex;
    console.log(`resuming FleetPool ${address}`);
  } else {
    hash = await wallet.deployContract({ abi: abi as never, bytecode, args: [account.address, account.address] as never });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`FleetPool deploy failed: ${hash}`);
    address = receipt.contractAddress as Address;
    console.log(`FleetPool ${address} (${hash})`);
  }

  // The pool funds and executes a buy in one transaction, and a fleet account
  // admits it only through its policy. Name it there, or every pooled buy
  // reverts NotOperator.
  const existing = JSON.parse(await readFile(RECORD, "utf8")) as { sessionPolicy?: string; policy?: string };
  const policyAddress = (existing.sessionPolicy ?? existing.policy) as `0x${string}` | undefined;
  if (policyAddress) {
    const policyAbi = [
      { type: "function", name: "setPool", stateMutability: "nonpayable", inputs: [{ name: "pool_", type: "address" }], outputs: [] },
      { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
      { type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "newOwner", type: "address" }], outputs: [] },
    ] as const;
    const policyOwner = await publicClient.readContract({ address: policyAddress, abi: policyAbi, functionName: "owner" });
    if (policyOwner.toLowerCase() === account.address.toLowerCase()) {
      const setPoolHash = await wallet.writeContract({ address: policyAddress, abi: policyAbi, functionName: "setPool", args: [address] });
      const setPoolReceipt = await publicClient.waitForTransactionReceipt({ hash: setPoolHash });
      if (setPoolReceipt.status !== "success") throw new Error(`policy.setPool failed: ${setPoolHash}`);
      console.log(`FleetSessionPolicy.setPool(${address}) (${setPoolHash})`);
      const offer = await wallet.writeContract({ address: policyAddress, abi: policyAbi, functionName: "transferOwnership", args: [admin] });
      await publicClient.waitForTransactionReceipt({ hash: offer });
      console.log(`FleetSessionPolicy.transferOwnership(${admin}) (${offer}); the admin accepts with acceptOwnership()`);
    } else {
      console.warn(`the policy is owned by ${policyOwner}, not the deployer: that admin must call setPool(${address}) itself`);
    }
  } else {
    console.warn("no policy address in the record: run setPool by hand before the first pooled buy");
  }

  // The pool's admin role goes to the cold key; nothing changes until it accepts.
  const poolAbi = [{ type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "newOwner", type: "address" }], outputs: [] }] as const;
  const handover = await wallet.writeContract({ address, abi: poolAbi, functionName: "transferOwnership", args: [admin] });
  await publicClient.waitForTransactionReceipt({ hash: handover });
  console.log(`FleetPool.transferOwnership(${admin}) (${handover}); the admin accepts with acceptOwnership()`);

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
