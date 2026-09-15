/**
 * Deploys the gas-sponsorship set to Robinhood Chain testnet (46630): a
 * FleetCampaignEscrow for sponsor budgets and a FleetPaymaster with the
 * published fee, tied together with setSettler, with the operator's float
 * deposited in the EntryPoint. Records it under `sponsorship` in
 * deployments/fleet-46630.json and prints the host variables.
 *
 * A separate escrow on purpose: sponsor budgets and fleet budgets never share
 * a contract, and the fleet escrow deployed on 2026-08-31 has no settler role
 * anyway. The fee is fixed at deployment (immutable) so a sponsor can read it
 * and rely on it; changing it means a new paymaster.
 *
 * Reads, never invents:
 *   DEPLOYER_PRIVATE_KEY        the operator key, funded on 46630
 *   FLEET_SPONSOR_FEE_BPS       the fee, basis points; default 2000 (the proposal's 20%)
 *   FLEET_SPONSOR_FLOAT_ETH     the EntryPoint deposit that fronts each op; default 0.01
 *   ROBINHOOD_TESTNET_RPC_URL   optional; defaults to the public testnet RPC
 *
 * Run:  npm run sponsor-deploy:live
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, isHex, parseAbi, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ENTRYPOINT_V07 } from "../src/fleet/user-operation.js";

const DEFAULT_RPC = "https://rpc.testnet.chain.robinhood.com";
const RECORD = path.resolve("deployments/fleet-46630.json");
const RPC_URL = process.env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC;
const FEE_BPS = Number(process.env.FLEET_SPONSOR_FEE_BPS || 2000);
const FLOAT = parseEther(process.env.FLEET_SPONSOR_FLOAT_ETH || "0.01");

const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const ESCROW_ABI = parseAbi(["function settler() view returns (address)", "function setSettler(address settler_)"]);
const PAYMASTER_ABI = parseAbi(["function deposit() payable", "function getDeposit() view returns (uint256)", "function feeBps() view returns (uint16)"]);

const keyFromEnv = (): Hex => {
  const value = process.env.DEPLOYER_PRIVATE_KEY;
  if (!value || !isHex(value) || value.length !== 66) throw new Error("Set DEPLOYER_PRIVATE_KEY to the operator's funded 32-byte hex key on chain 46630");
  return value;
};

const artifact = async (name: string) =>
  JSON.parse(await readFile(path.resolve(`artifacts/contracts/fleet/${name}.sol/${name}.json`), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };

const main = async (): Promise<void> => {
  if (!Number.isInteger(FEE_BPS) || FEE_BPS < 0 || FEE_BPS > 5000) throw new Error("FLEET_SPONSOR_FEE_BPS must be an integer between 0 and 5000");
  const operator = privateKeyToAccount(keyFromEnv());
  const transport = http(RPC_URL);
  const wallet = createWalletClient({ account: operator, chain: robinhoodTestnet, transport });
  const publicClient = createPublicClient({ chain: robinhoodTestnet, transport });
  if ((await publicClient.getChainId()) !== 46630) throw new Error("the RPC is not chain 46630");

  const balance = await publicClient.getBalance({ address: operator.address });
  console.log(`operator ${operator.address} holds ${formatEther(balance)} ETH`);
  if (balance < FLOAT + parseEther("0.003")) throw new Error(`fund the operator with at least ${formatEther(FLOAT + parseEther("0.003"))} ETH`);

  const record = JSON.parse(await readFile(RECORD, "utf8")) as Record<string, unknown> & { sponsorship?: Record<string, unknown> };
  const sponsorship = record.sponsorship ?? {};
  const save = async () => { record.sponsorship = sponsorship; await writeFile(RECORD, `${JSON.stringify(record, null, 2)}\n`); };

  const send = async (label: string, request: () => Promise<Hex>) => {
    const hash = await request();
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    console.log(`${label}: ${hash}${receipt.contractAddress ? ` -> ${receipt.contractAddress}` : ""}`);
    return { hash, address: receipt.contractAddress as Address | undefined };
  };
  const deploy = async (name: string, args: readonly unknown[]): Promise<Address> => {
    const { abi, bytecode } = await artifact(name);
    const { hash, address } = await send(`deploy ${name}`, () => wallet.deployContract({ abi: abi as never, bytecode, args: args as never }));
    if (!address) throw new Error(`${name} deployed without an address: ${hash}`);
    sponsorship["deployTx"] = { ...((sponsorship["deployTx"] as Record<string, Hex>) ?? {}), [name]: hash };
    return address;
  };

  let escrow = sponsorship["escrow"] as Address | undefined;
  if (!escrow) { escrow = await deploy("FleetCampaignEscrow", [operator.address]); sponsorship["escrow"] = escrow; await save(); }

  // A paymaster with a different fee than the recorded one is a new deployment; the record keeps the old under previousPaymasters.
  let paymaster = sponsorship["paymaster"] as Address | undefined;
  if (paymaster) {
    const fee = Number(await publicClient.readContract({ address: paymaster, abi: PAYMASTER_ABI, functionName: "feeBps" }).catch(() => -1));
    if (fee !== FEE_BPS) {
      console.log(`recorded paymaster ${paymaster} has fee ${fee} bps, not ${FEE_BPS}; deploying a new one`);
      sponsorship["previousPaymasters"] = [...((sponsorship["previousPaymasters"] as unknown[]) ?? []), { paymaster, feeBps: fee, retiredAt: new Date().toISOString() }];
      paymaster = undefined;
    }
  }
  if (!paymaster) {
    paymaster = await deploy("FleetPaymaster", [ENTRYPOINT_V07, operator.address, escrow, FEE_BPS]);
    sponsorship["paymaster"] = paymaster;
    sponsorship["feeBps"] = FEE_BPS;
    await save();
  }

  const settler = await publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "settler" });
  if (settler.toLowerCase() !== paymaster.toLowerCase()) {
    if (settler !== "0x0000000000000000000000000000000000000000") {
      throw new Error(`the escrow's settler is ${settler}, set once; a paymaster with a new fee needs a fresh escrow too: clear sponsorship.escrow in the record and rerun`);
    }
    await send("escrow.setSettler(paymaster)", () => wallet.writeContract({ address: escrow!, abi: ESCROW_ABI, functionName: "setSettler", args: [paymaster!] }));
  }

  const deposit = await publicClient.readContract({ address: paymaster, abi: PAYMASTER_ABI, functionName: "getDeposit" });
  if (deposit < FLOAT) {
    await send(`paymaster.deposit() ${formatEther(FLOAT - deposit)} ETH`, () => wallet.writeContract({ address: paymaster!, abi: PAYMASTER_ABI, functionName: "deposit", value: FLOAT - deposit }));
  }
  sponsorship["entryPoint"] = ENTRYPOINT_V07;
  sponsorship["operator"] = operator.address;
  sponsorship["deployedAt"] = sponsorship["deployedAt"] ?? new Date().toISOString();
  await save();

  console.log(`\nrecorded under sponsorship in ${RECORD}`);
  console.log("Set these in the host environment, then redeploy the service:");
  console.log(`  FLEET_SPONSOR_PAYMASTER_ADDRESS=${paymaster}`);
  console.log(`  FLEET_SPONSOR_ESCROW_ADDRESS=${escrow}`);
  console.log("  DATABASE_URL=<neon>   the sponsor ledger; without it daily caps hold per instance only");
  console.log(`The paymaster's float is ${formatEther(await publicClient.readContract({ address: paymaster, abi: PAYMASTER_ABI, functionName: "getDeposit" }))} ETH; top it up with paymaster.deposit() as sponsored volume grows.`);
};

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
