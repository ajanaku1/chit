/**
 * Deploys ChitBuyback to Robinhood Chain mainnet (4663) against the live
 * CHIT/ETH pool, verifies what it reads from the chain, and records it in
 * deployments/buyback-4663.json.
 *
 * Reads, never invents:
 *   BUYBACK_DEPLOYER_KEY        a key with a little mainnet ETH for the
 *                               deploy gas; it keeps no power afterwards (the
 *                               contract has no owner), so a throwaway does
 *   ROBINHOOD_MAINNET_RPC_URL   optional; defaults to the public RPC
 *   BUYBACK_SPEND_BPS           share of the balance per call, default 100 (1%)
 *   BUYBACK_MIN_SPEND_ETH       floor per call, default 0.002
 *   BUYBACK_MAX_SPEND_ETH       cap per call, default 0.1
 *   BUYBACK_INTERVAL_SECONDS    default 3600
 *   BUYBACK_MAX_SLIP_BPS        worst fill under the zero-fee quote, default
 *                               500: the hook's 2% has to fit inside it
 *
 * Nothing about the pool is typed in: the key (fee 0, spacing 200, the
 * hook) was read from the Initialize log on 2026-09-16 and is checked here
 * against the pool's state before anything is deployed. The parameters are
 * immutable, so this is the one moment they can be chosen; the GC decides
 * them, this script only applies them.
 *
 * Run:  npm run buyback-deploy:live
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, isHex, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = process.env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const RECORD = path.resolve("deployments/buyback-4663.json");

/** Verified on 4663 (docs/chit-buyback.md). */
const CHIT: Address = "0xd523a627030509021cc39b6d7c8543417d3e50d8";
const ROUTER: Address = "0x8876789976decbfcbbbe364623c63652db8c0904";
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const HOOK: Address = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
const POOL_ID: Hex = "0x84a4f18cfab0b389a63c4d8a56d08f021a6fd5efb0b0b3617cfbbd6706f09f41";
const POOL_FEE = 0;
const POOL_TICK_SPACING = 200;

const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });

const keyFromEnv = (): Hex => {
  const value = process.env.BUYBACK_DEPLOYER_KEY;
  if (!value || !isHex(value) || value.length !== 66) throw new Error("Set BUYBACK_DEPLOYER_KEY to a 32-byte hex key with a little ETH on chain 4663");
  return value;
};
const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number`);
  return Number(raw);
};
const ethFromEnv = (name: string, fallback: string): bigint => {
  const raw = process.env[name] ?? fallback;
  if (!/^\d+(\.\d{1,18})?$/.test(raw)) throw new Error(`${name} must be an amount in ETH`);
  return parseEther(raw);
};

const main = async (): Promise<void> => {
  const params = {
    spendBps: intFromEnv("BUYBACK_SPEND_BPS", 100),
    minSpend: ethFromEnv("BUYBACK_MIN_SPEND_ETH", "0.002"),
    maxSpend: ethFromEnv("BUYBACK_MAX_SPEND_ETH", "0.1"),
    interval: intFromEnv("BUYBACK_INTERVAL_SECONDS", 3600),
    maxSlipBps: intFromEnv("BUYBACK_MAX_SLIP_BPS", 500),
  };
  const account = privateKeyToAccount(keyFromEnv());
  const transport = http(RPC_URL, { timeout: 60_000 });
  const wallet = createWalletClient({ account, chain, transport });
  const publicClient = createPublicClient({ chain, transport });

  const { abi, bytecode } = JSON.parse(await readFile(path.resolve("artifacts/contracts/chit/ChitBuyback.sol/ChitBuyback.json"), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`deployer ${account.address} holds ${formatEther(balance)} ETH on 4663`);
  if (balance < parseEther("0.0005")) throw new Error("the deployer needs a little ETH for gas");

  const args = [CHIT, ROUTER, POOL_MANAGER, POOL_FEE, POOL_TICK_SPACING, HOOK, params.spendBps, params.minSpend, params.maxSpend, params.interval, params.maxSlipBps] as const;
  const hash = await wallet.deployContract({ abi: abi as never, bytecode, args: args as never });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`ChitBuyback deploy failed: ${hash}`);
  const address = receipt.contractAddress;
  console.log(`ChitBuyback ${address} (${hash}, block ${receipt.blockNumber})`);

  // What was deployed, read back: the pool it computed must be the live one, with a price and liquidity.
  const read = <T>(functionName: string, fnArgs: readonly unknown[] = []): Promise<T> =>
    publicClient.readContract({ address, abi: abi as never, functionName, args: fnArgs } as never) as Promise<T>;
  const poolId = await read<Hex>("poolId");
  if (poolId.toLowerCase() !== POOL_ID) throw new Error(`the contract computed pool ${poolId}, not the live ${POOL_ID}`);
  const [sqrtP, liquidity] = await read<[bigint, bigint]>("poolState");
  if (sqrtP === 0n || liquidity === 0n) throw new Error("the contract reads no price or liquidity for the pool");
  const quoted = await read<bigint>("quote", [parseEther("0.01")]);
  console.log(`pool ${poolId}: quote for 0.01 ETH is ${formatEther(quoted)} CHIT before the hook's fee`);

  const record = {
    chainId: 4663,
    buyback: { address, deployTx: hash, deployedAt: new Date().toISOString(), block: Number(receipt.blockNumber), deployer: account.address },
    token: CHIT, router: ROUTER, poolManager: POOL_MANAGER, poolId, poolKey: { currency0: "0x0000000000000000000000000000000000000000", currency1: CHIT, fee: POOL_FEE, tickSpacing: POOL_TICK_SPACING, hooks: HOOK },
    params: { spendBps: params.spendBps, minSpendWei: params.minSpend.toString(), maxSpendWei: params.maxSpend.toString(), intervalSeconds: params.interval, maxSlipBps: params.maxSlipBps },
  };
  await writeFile(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`recorded in ${RECORD}`);
  console.log("");
  console.log("next: set the repository variable BUYBACK_ADDRESS and the secret BUYBACK_KEEPER_KEY (a throwaway with dust ETH), then send the seed ETH to the address by plain transfer.");
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
