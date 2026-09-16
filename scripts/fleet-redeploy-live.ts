/**
 * Redeploys the three contracts the audit changed, on Robinhood Chain testnet
 * (46630), and rewires them: FleetSessionPolicy, FleetAccountFactory and
 * FleetPool, then `policy.setPool(pool)`. The escrow is not touched; nothing
 * in it changed, and the campaign budgets it holds keep working. The venue
 * (token, seeded pool) is not touched either.
 *
 * Why all three and not the pool alone: a fleet account admits the pool as an
 * executor through its policy (`policy.pool()`), and that check lives in the
 * account's bytecode, which the factory carries. A new pool with the old
 * factory would deploy accounts that refuse it; a new factory with the old
 * policy would ask a policy that has no `pool()`. So the set moves together,
 * and the record keeps the old set under `previous` so nothing is lost.
 *
 * What it does not do, on purpose:
 *   - move anyone's ETH. Depositors in the old pool exit it themselves
 *     (24 hour self exit, straight on the contract); the old address stays
 *     in the record and the runbook says what to tell them.
 *   - set a guardian unless FLEET_GUARDIAN_ADDRESS is given. The guardian can
 *     only pause; it should be a key that is not the operator's.
 *   - touch the host environment. It prints the variables to set.
 *
 * Reads, never invents:
 *   DEPLOYER_PRIVATE_KEY        the operator key, funded on 46630; the pool's
 *                               operator is immutable and the service signs
 *                               with this same key, so it must be this one
 *   ROBINHOOD_TESTNET_RPC_URL   optional; defaults to the public testnet RPC
 *   FLEET_GUARDIAN_ADDRESS      optional; a second key that may pause the pool
 *
 * Run:  npm run fleet-redeploy:live
 * Rehearse first against a local fork (docs/runbooks/redeploy-after-audit.md).
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  isAddress,
  isHex,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";
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

const POLICY_ABI = parseAbi(["function setPool(address pool_)", "function pool() view returns (address)", "function operator() view returns (address)"]);
const FACTORY_ABI = parseAbi(["function operator() view returns (address)"]);
const POOL_ABI = parseAbi([
  "function operator() view returns (address)",
  "function guardian() view returns (address)",
  "function setGuardian(address guardian_)",
  "function paused() view returns (bool)",
  "function totalDeposited() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function DEPOSITOR_CAP() view returns (uint256)",
  "function DRAW_CAP() view returns (uint256)",
  "function POOL_CAP() view returns (uint256)",
  "function GAS_HEADROOM() view returns (uint256)",
]);

type Record46630 = {
  operator?: Address;
  sessionPolicy?: Address;
  accountFactory?: Address;
  campaignEscrow?: Address;
  sessionPolicyTx?: Hex;
  accountFactoryTx?: Hex;
  pool?: { address: Address; deployTx?: Hex; deployedAt?: string; [k: string]: unknown };
  previous?: unknown[];
  [k: string]: unknown;
};

const keyFromEnv = (): Hex => {
  const value = process.env.DEPLOYER_PRIVATE_KEY;
  if (!value || !isHex(value) || value.length !== 66) {
    throw new Error("Set DEPLOYER_PRIVATE_KEY to the operator's funded 32-byte hex key on chain 46630");
  }
  return value;
};

const artifact = async (name: string): Promise<{ abi: readonly unknown[]; bytecode: Hex }> =>
  JSON.parse(await readFile(path.resolve(`artifacts/contracts/fleet/${name}.sol/${name}.json`), "utf8")) as {
    abi: readonly unknown[];
    bytecode: Hex;
  };

const main = async (): Promise<void> => {
  const operator = privateKeyToAccount(keyFromEnv());
  const transport = http(RPC_URL);
  const wallet = createWalletClient({ account: operator, chain: robinhoodTestnet, transport });
  const publicClient = createPublicClient({ chain: robinhoodTestnet, transport });

  const chainId = await publicClient.getChainId();
  if (chainId !== 46630) throw new Error(`expected chain 46630, the RPC answers ${chainId}`);

  const record = JSON.parse(await readFile(RECORD, "utf8")) as Record46630;
  const old = { policy: record.sessionPolicy, factory: record.accountFactory, pool: record.pool?.address, escrow: record.campaignEscrow };
  for (const [name, address] of Object.entries(old)) {
    if (!address || !isAddress(address)) throw new Error(`the record has no ${name} address; this script redeploys, it does not deploy first`);
  }
  if (record.operator && record.operator.toLowerCase() !== operator.address.toLowerCase()) {
    throw new Error(`the record's operator is ${record.operator}; DEPLOYER_PRIVATE_KEY is ${operator.address}. The service signs as the recorded operator, so the new pool must be deployed by that key.`);
  }

  // --- pre-flight: what is at stake in the old pool, and can we pay ---
  const balance = await publicClient.getBalance({ address: operator.address });
  const oldPoolEth = await publicClient.getBalance({ address: old.pool as Address });
  const oldDeposited = await publicClient.readContract({ address: old.pool as Address, abi: POOL_ABI, functionName: "totalDeposited" }).catch(() => null);
  console.log(`operator ${operator.address} holds ${formatEther(balance)} ETH`);
  console.log(`old pool ${old.pool} holds ${formatEther(oldPoolEth)} ETH` + (oldDeposited === null ? "" : ` (${formatEther(oldDeposited)} ETH ever deposited)`));
  if (balance < parseEther("0.01")) throw new Error("fund the operator with at least 0.01 ETH before redeploying");
  if (oldPoolEth > 0n) {
    console.log("  depositors still hold ETH in the old pool. They exit it themselves on the contract (24h self exit); the runbook says what to post. Nothing here moves it.");
  }

  const send = async (label: string, request: () => Promise<Hex>): Promise<{ hash: Hex; address?: Address }> => {
    const hash = await request();
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    console.log(`${label}: ${hash}${receipt.contractAddress ? ` -> ${receipt.contractAddress}` : ""}`);
    return receipt.contractAddress ? { hash, address: receipt.contractAddress as Address } : { hash };
  };
  const deploy = async (name: string, args: readonly unknown[]): Promise<{ address: Address; tx: Hex }> => {
    const { abi, bytecode } = await artifact(name);
    const { hash, address } = await send(`deploy ${name}`, () => wallet.deployContract({ abi: abi as never, bytecode, args: args as never }));
    if (!address) throw new Error(`${name} deployed without an address: ${hash}`);
    const code = await publicClient.getCode({ address });
    if (!code || code === "0x") throw new Error(`${name} left no code at ${address}`);
    return { address, tx: hash };
  };

  // --- the three contracts, then the one call that ties them ---
  const policy = await deploy("FleetSessionPolicy", [operator.address]);
  const factory = await deploy("FleetAccountFactory", [operator.address]);
  const pool = await deploy("FleetPool", [operator.address]);
  const setPool = await send(`FleetSessionPolicy.setPool(${pool.address})`, () =>
    wallet.writeContract({ address: policy.address, abi: POLICY_ABI, functionName: "setPool", args: [pool.address] }),
  );

  let guardianTx: Hex | null = null;
  const guardian = process.env.FLEET_GUARDIAN_ADDRESS;
  if (guardian) {
    if (!isAddress(guardian)) throw new Error("FLEET_GUARDIAN_ADDRESS is not an address");
    if (guardian.toLowerCase() === operator.address.toLowerCase()) throw new Error("the guardian must not be the operator; the point is a second key that can only pause");
    guardianTx = (await send(`FleetPool.setGuardian(${guardian})`, () =>
      wallet.writeContract({ address: pool.address, abi: POOL_ABI, functionName: "setGuardian", args: [guardian] }),
    )).hash;
  }

  // --- read everything back; the record says what is on chain, not what we meant ---
  const [policyPool, policyOperator, factoryOperator, poolOperator, poolGuardian, paused] = await Promise.all([
    publicClient.readContract({ address: policy.address, abi: POLICY_ABI, functionName: "pool" }),
    publicClient.readContract({ address: policy.address, abi: POLICY_ABI, functionName: "operator" }),
    publicClient.readContract({ address: factory.address, abi: FACTORY_ABI, functionName: "operator" }),
    publicClient.readContract({ address: pool.address, abi: POOL_ABI, functionName: "operator" }),
    publicClient.readContract({ address: pool.address, abi: POOL_ABI, functionName: "guardian" }),
    publicClient.readContract({ address: pool.address, abi: POOL_ABI, functionName: "paused" }),
  ]);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(policyPool, pool.address)) throw new Error(`policy.pool() is ${policyPool}, expected ${pool.address}`);
  for (const [what, got] of [["policy.operator", policyOperator], ["factory.operator", factoryOperator], ["pool.operator", poolOperator]] as const) {
    if (!same(got, operator.address)) throw new Error(`${what} is ${got}, expected ${operator.address}`);
  }
  if (paused) throw new Error("the new pool is paused; it should not be");
  const caps = Object.fromEntries(await Promise.all(
    (["DEPOSITOR_CAP", "DRAW_CAP", "POOL_CAP", "GAS_HEADROOM"] as const).map(async (fn) =>
      [fn, (await publicClient.readContract({ address: pool.address, abi: POOL_ABI, functionName: fn })).toString()]),
  ));

  // --- the record: new set on top, old set kept ---
  const now = new Date().toISOString();
  record.previous = [
    ...(record.previous ?? []),
    {
      retiredAt: now,
      reason: "redeployed after the September audit: refusals, guardian, atomic fund and execute",
      sessionPolicy: old.policy, sessionPolicyTx: record.sessionPolicyTx ?? null,
      accountFactory: old.factory, accountFactoryTx: record.accountFactoryTx ?? null,
      pool: record.pool,
    },
  ];
  record.sessionPolicy = policy.address;
  record.sessionPolicyTx = policy.tx;
  record.accountFactory = factory.address;
  record.accountFactoryTx = factory.tx;
  record.pool = {
    address: pool.address,
    operator: operator.address,
    deployTx: pool.tx,
    setPoolTx: setPool.hash,
    guardian: poolGuardian,
    guardianTx,
    caps: { perDepositor: caps["DEPOSITOR_CAP"], perDraw: caps["DRAW_CAP"], pool: caps["POOL_CAP"], gasHeadroom: caps["GAS_HEADROOM"] },
    deployedAt: now,
  };
  record.redeployedAt = now;
  await writeFile(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nrecorded in ${RECORD}; the old set is under previous[]`);

  // --- what the host has to know ---
  console.log("\nSet these in the host environment, then redeploy the service:");
  console.log(`  FLEET_POOL_ADDRESS=${pool.address}`);
  console.log(`  FLEET_POLICY_ADDRESS=${policy.address}`);
  console.log(`  FLEET_FACTORY_ADDRESS=${factory.address}`);
  console.log(`  FLEET_ESCROW_ADDRESS=${old.escrow}   (unchanged)`);
  console.log("And, before the first draw on the new pool, the secrets the audit asked to separate (.env.example):");
  console.log("  FLEET_LEDGER_KEY=<32 bytes hex>        never change it once the pool holds a draw");
  console.log("  FLEET_NONCE_SECRET=<32+ characters>");
  console.log("  FLEET_TOKEN_ALLOWLIST=<token addresses, comma separated>");
  console.log("Then update DEPLOYED_46630 in src/fleet/service-runtime.ts to the same three addresses, so a host with no env still points at the live set.");
  if (!guardian) console.log("No guardian set. Set FLEET_GUARDIAN_ADDRESS to a key that is not the operator's and rerun setGuardian, or call it by hand; without one only the operator can pause.");
};

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
