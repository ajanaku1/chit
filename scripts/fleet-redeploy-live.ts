/**
 * Deploys, or redeploys, the fleet set on one chain: FleetSessionPolicy,
 * FleetAccountFactory and FleetPool, tied by `policy.setPool(pool)`, plus a
 * FleetCampaignEscrow when the chain has none yet. Records everything in
 * deployments/fleet-<chainId>.json and writes app/chain-target.json so the
 * app knows which chain it is on and what to say about it.
 *
 * Two uses, one script:
 *   - testnet (46630, the default): a redeploy after the audit. The old set
 *     is kept under `previous[]`; the escrow and the venue are not touched.
 *   - mainnet (FLEET_CHAIN_ID=4663): the capped beta. A fresh set, including
 *     the escrow, with the beta caps (1 ETH pool, 0.1 per depositor, 0.05 per
 *     draw) unless FLEET_*_CAP_ETH say otherwise, and a beta note for the app.
 *
 * Why the three move together: a fleet account admits the pool through its
 * policy (`policy.pool()`), and that check is in the account bytecode the
 * factory carries. Why the caps are constructor arguments: the same audited
 * bytecode runs on both chains, and a bigger cap is a new pool after an
 * audit, not a switch.
 *
 * What it does not do, on purpose: move anyone's ETH (the old pool keeps its
 * deposits; testers exit it themselves), set a guardian unless
 * FLEET_GUARDIAN_ADDRESS is given (mainnet refuses without one), or touch the
 * host environment (it prints the variables to set).
 *
 * Reads, never invents:
 *   DEPLOYER_PRIVATE_KEY        the operator key, funded on the chain; the
 *                               pool's operator is immutable and the service
 *                               signs with this same key
 *   FLEET_CHAIN_ID              46630 (default) or 4663
 *   FLEET_RPC_URL               optional; defaults by chain
 *   FLEET_GUARDIAN_ADDRESS      a second key that may pause the pool; required on mainnet
 *   FLEET_DEPOSITOR_CAP_ETH, FLEET_DRAW_CAP_ETH, FLEET_POOL_CAP_ETH
 *                               optional; default to the chain's published set
 *
 * Run:  npm run fleet-redeploy:live
 * Rehearse first against a local fork (docs/runbooks/redeploy-after-audit.md,
 * docs/runbooks/mainnet-beta.md).
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

import { capsFromEnv } from "../src/fleet/pool-caps.js";

const CHAIN_ID = Number(process.env.FLEET_CHAIN_ID || 46630);
const MAINNET = CHAIN_ID === 4663;
const DEFAULT_RPC = MAINNET ? "https://rpc.mainnet.chain.robinhood.com" : "https://rpc.testnet.chain.robinhood.com";
const RPC_URL = process.env.FLEET_RPC_URL || process.env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC;
const RECORD = path.resolve(`deployments/fleet-${CHAIN_ID}.json`);
const CHAIN_TARGET = path.resolve("app/chain-target.json");
const CHAIN_NAME = MAINNET ? "Robinhood Chain" : "Robinhood Chain Testnet";

const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_NAME,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const POLICY_ABI = parseAbi(["function setPool(address pool_)", "function pool() view returns (address)", "function operator() view returns (address)"]);
const FACTORY_ABI = parseAbi(["function operator() view returns (address)"]);
const ESCROW_ABI = parseAbi(["function operator() view returns (address)"]);
const POOL_ABI = parseAbi([
  "function operator() view returns (address)",
  "function guardian() view returns (address)",
  "function setGuardian(address guardian_)",
  "function paused() view returns (bool)",
  "function totalDeposited() view returns (uint256)",
  "function DEPOSITOR_CAP() view returns (uint256)",
  "function DRAW_CAP() view returns (uint256)",
  "function POOL_CAP() view returns (uint256)",
  "function GAS_HEADROOM() view returns (uint256)",
]);

type FleetRecord = {
  network?: string;
  chainId?: number;
  operator?: Address;
  entryPoint?: Address;
  router?: Address;
  sessionPolicy?: Address;
  accountFactory?: Address;
  campaignEscrow?: Address;
  sessionPolicyTx?: Hex;
  accountFactoryTx?: Hex;
  campaignEscrowTx?: Hex;
  pool?: { address: Address; deployTx?: Hex; deployedAt?: string; [k: string]: unknown };
  previous?: unknown[];
  [k: string]: unknown;
};

const keyFromEnv = (): Hex => {
  const value = process.env.DEPLOYER_PRIVATE_KEY;
  if (!value || !isHex(value) || value.length !== 66) {
    throw new Error(`Set DEPLOYER_PRIVATE_KEY to the operator's funded 32-byte hex key on chain ${CHAIN_ID}`);
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
  const wallet = createWalletClient({ account: operator, chain, transport });
  const publicClient = createPublicClient({ chain, transport });

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`expected chain ${CHAIN_ID}, the RPC answers ${chainId}`);
  const caps = capsFromEnv(CHAIN_ID);
  const guardian = process.env.FLEET_GUARDIAN_ADDRESS;
  if (guardian !== undefined && guardian !== "") {
    if (!isAddress(guardian)) throw new Error("FLEET_GUARDIAN_ADDRESS is not an address");
    if (guardian.toLowerCase() === operator.address.toLowerCase()) throw new Error("the guardian must not be the operator; the point is a second key that can only pause");
  } else if (MAINNET) {
    throw new Error("a mainnet beta needs a guardian before anything is deployed: set FLEET_GUARDIAN_ADDRESS to a key that is not the operator's");
  }

  let record: FleetRecord = {};
  let fresh = false;
  try {
    record = JSON.parse(await readFile(RECORD, "utf8")) as FleetRecord;
  } catch {
    fresh = true;
  }
  const old = { policy: record.sessionPolicy, factory: record.accountFactory, pool: record.pool?.address, escrow: record.campaignEscrow };
  if (!fresh) {
    for (const [name, address] of Object.entries(old)) {
      if (!address || !isAddress(address)) throw new Error(`the record for chain ${CHAIN_ID} exists but has no ${name} address; fix the record or remove it for a fresh deploy`);
    }
    if (record.operator && record.operator.toLowerCase() !== operator.address.toLowerCase()) {
      throw new Error(`the record's operator is ${record.operator}; DEPLOYER_PRIVATE_KEY is ${operator.address}. The service signs as the recorded operator, so the new pool must be deployed by that key.`);
    }
  }

  // --- pre-flight ---
  const balance = await publicClient.getBalance({ address: operator.address });
  console.log(`operator ${operator.address} holds ${formatEther(balance)} ETH on ${CHAIN_NAME} (${CHAIN_ID})`);
  console.log(`caps: ${formatEther(caps.depositor)} ETH per depositor, ${formatEther(caps.draw)} per draw, ${formatEther(caps.pool)} in the pool${MAINNET ? " (the beta)" : ""}`);
  if (balance < parseEther("0.01")) throw new Error("fund the operator with at least 0.01 ETH before deploying");
  if (!fresh) {
    const oldPoolEth = await publicClient.getBalance({ address: old.pool as Address });
    const oldDeposited = await publicClient.readContract({ address: old.pool as Address, abi: POOL_ABI, functionName: "totalDeposited" }).catch(() => null);
    console.log(`old pool ${old.pool} holds ${formatEther(oldPoolEth)} ETH` + (oldDeposited === null ? "" : ` (${formatEther(oldDeposited)} ETH ever deposited)`));
    if (oldPoolEth > 0n) {
      console.log("  depositors still hold ETH in the old pool. They exit it themselves on the contract (24h self exit); the runbook says what to post. Nothing here moves it.");
    }
  } else {
    console.log(`no record for chain ${CHAIN_ID}: a fresh set, escrow included`);
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

  // --- the set ---
  const escrow = fresh ? await deploy("FleetCampaignEscrow", [operator.address]) : { address: old.escrow as Address, tx: record.campaignEscrowTx as Hex };
  const policy = await deploy("FleetSessionPolicy", [operator.address]);
  const factory = await deploy("FleetAccountFactory", [operator.address]);
  const pool = await deploy("FleetPool", [operator.address, caps.depositor, caps.draw, caps.pool]);
  const setPool = await send(`FleetSessionPolicy.setPool(${pool.address})`, () =>
    wallet.writeContract({ address: policy.address, abi: POLICY_ABI, functionName: "setPool", args: [pool.address] }),
  );
  let guardianTx: Hex | null = null;
  if (guardian) {
    guardianTx = (await send(`FleetPool.setGuardian(${guardian})`, () =>
      wallet.writeContract({ address: pool.address, abi: POOL_ABI, functionName: "setGuardian", args: [guardian as Address] }),
    )).hash;
  }

  // --- read everything back; the record says what is on chain, not what we meant ---
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const [policyPool, policyOperator, factoryOperator, poolOperator, escrowOperator, poolGuardian, paused] = await Promise.all([
    publicClient.readContract({ address: policy.address, abi: POLICY_ABI, functionName: "pool" }),
    publicClient.readContract({ address: policy.address, abi: POLICY_ABI, functionName: "operator" }),
    publicClient.readContract({ address: factory.address, abi: FACTORY_ABI, functionName: "operator" }),
    publicClient.readContract({ address: pool.address, abi: POOL_ABI, functionName: "operator" }),
    publicClient.readContract({ address: escrow.address, abi: ESCROW_ABI, functionName: "operator" }),
    publicClient.readContract({ address: pool.address, abi: POOL_ABI, functionName: "guardian" }),
    publicClient.readContract({ address: pool.address, abi: POOL_ABI, functionName: "paused" }),
  ]);
  if (!same(policyPool, pool.address)) throw new Error(`policy.pool() is ${policyPool}, expected ${pool.address}`);
  for (const [what, got] of [["policy.operator", policyOperator], ["factory.operator", factoryOperator], ["pool.operator", poolOperator], ["escrow.operator", escrowOperator]] as const) {
    if (!same(got, operator.address)) throw new Error(`${what} is ${got}, expected ${operator.address}`);
  }
  if (paused) throw new Error("the new pool is paused; it should not be");
  const readCaps = Object.fromEntries(await Promise.all(
    (["DEPOSITOR_CAP", "DRAW_CAP", "POOL_CAP", "GAS_HEADROOM"] as const).map(async (fn) =>
      [fn, (await publicClient.readContract({ address: pool.address, abi: POOL_ABI, functionName: fn })).toString()]),
  ));
  if (readCaps["DEPOSITOR_CAP"] !== caps.depositor.toString() || readCaps["DRAW_CAP"] !== caps.draw.toString() || readCaps["POOL_CAP"] !== caps.pool.toString()) {
    throw new Error("the pool's caps do not read back as deployed");
  }

  // --- the record ---
  const now = new Date().toISOString();
  if (!fresh) {
    record.previous = [
      ...(record.previous ?? []),
      {
        retiredAt: now,
        reason: "redeployed after the September audit: refusals, guardian, atomic fund and execute, caps at deployment",
        sessionPolicy: old.policy, sessionPolicyTx: record.sessionPolicyTx ?? null,
        accountFactory: old.factory, accountFactoryTx: record.accountFactoryTx ?? null,
        pool: record.pool,
      },
    ];
  } else {
    record.network = MAINNET ? "robinhood-mainnet" : "robinhood-testnet";
    record.chainId = CHAIN_ID;
    record.operator = operator.address;
    record.entryPoint = "0x0000000071727de22e5e9d8baf0edac6f37da032";
    record.router = "0x8876789976decbfcbbbe364623c63652db8c0904";
    record.campaignEscrow = escrow.address;
    record.campaignEscrowTx = escrow.tx;
    record.deployedAt = now;
  }
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
    caps: { perDepositor: readCaps["DEPOSITOR_CAP"], perDraw: readCaps["DRAW_CAP"], pool: readCaps["POOL_CAP"], gasHeadroom: readCaps["GAS_HEADROOM"] },
    beta: MAINNET,
    deployedAt: now,
  };
  record.redeployedAt = now;
  await writeFile(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nrecorded in ${RECORD}${fresh ? "" : "; the old set is under previous[]"}`);

  // --- the app's chain target: which chain, and what to say about it ---
  const betaNote = MAINNET
    ? `Beta on Robinhood Chain: capped at ${formatEther(caps.pool)} ETH in the pool, ${formatEther(caps.depositor)} per depositor and ${formatEther(caps.draw)} per draw, not audited by a firm yet. Holders only. The 24 hour self-exit works with Chit offline.`
    : "";
  await writeFile(CHAIN_TARGET, `${JSON.stringify({ chainId: CHAIN_ID, chainName: CHAIN_NAME, rpcUrls: [DEFAULT_RPC], beta: MAINNET, betaNote }, null, 2)}\n`);
  console.log(`wrote ${CHAIN_TARGET}; rebuild the app so it points at ${CHAIN_NAME}`);

  // --- what the host has to know ---
  console.log("\nSet these in the host environment, then redeploy the service:");
  console.log(`  FLEET_CHAIN_ID=${CHAIN_ID}`);
  console.log(`  FLEET_RPC_URL=${DEFAULT_RPC}   (or an operator RPC)`);
  console.log(`  FLEET_POOL_ADDRESS=${pool.address}`);
  console.log(`  FLEET_POLICY_ADDRESS=${policy.address}`);
  console.log(`  FLEET_FACTORY_ADDRESS=${factory.address}`);
  console.log(`  FLEET_ESCROW_ADDRESS=${escrow.address}${fresh ? "" : "   (unchanged)"}`);
  if (fresh) console.log(`  FLEET_ESCROW_BLOCK=<the block that mined ${escrow.tx}>   the fleet list scans events from here`);
  console.log("And, before the first draw on the new pool, the secrets the audit asked to separate (.env.example):");
  console.log("  FLEET_LEDGER_KEY=<32 bytes hex>        never change it once the pool holds a draw");
  console.log("  FLEET_NONCE_SECRET=<32+ characters>");
  console.log("  FLEET_TOKEN_ALLOWLIST=<token addresses, comma separated>");
  if (MAINNET) {
    console.log("Holders only, the gate the beta announced (all env, no code):");
    console.log("  CHIT_FEE_THRESHOLD=<CHIT base units the wallet must hold>  CHIT_BASE_FEE=0  CHIT_FEE_DISCOUNT=0  CHIT_FEE_RECIPIENT=<operator>");
    console.log("  CHIT_RPC_URL=https://rpc.mainnet.chain.robinhood.com  CHIT_TOKEN_ADDRESS=0xd523a627030509021cc39b6d7c8543417d3e50d8");
  } else {
    console.log("Then update RECORDED_46630 in src/fleet/service-runtime.ts to the same three addresses, so a host with no env still points at the live set.");
  }
  if (!guardian) console.log("No guardian set. Set FLEET_GUARDIAN_ADDRESS to a key that is not the operator's and call setGuardian; without one only the operator can pause.");
};

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
