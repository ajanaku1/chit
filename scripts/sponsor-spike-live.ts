/**
 * The gas-sponsorship spike on Robinhood Chain testnet (46630), for real.
 *
 * What test/fork/sponsor-spike.test.ts proves on a fork, this lands on the
 * chain and records: a throwaway smart account that has never held ETH makes
 * one sponsored call through FleetPaymaster, the sponsor's escrow budget pays
 * what the op cost, and the operator is the bundler. It writes the addresses
 * and hashes under `sponsorship` in deployments/fleet-46630.json.
 *
 * It deploys its own escrow and paymaster on the first run and reuses them
 * after. The fleet escrow in the record cannot be used: it was deployed on
 * 2026-08-31, the settler role the paymaster needs was added on 2026-09-01,
 * and the deployed bytecode has no `setSettler`. A sponsor budget separate
 * from the fleet budgets is the better shape anyway.
 *
 * Reads, never invents:
 *   DEPLOYER_PRIVATE_KEY        the operator key, funded on 46630 (about
 *                               0.005 ETH covers deploys, the deposit, the
 *                               budget and the op; deposit and budget are
 *                               recoverable through the contracts)
 *   ROBINHOOD_TESTNET_RPC_URL   optional; defaults to the public testnet RPC
 *
 * Run:  npm run sponsor-spike:live
 * A throwaway owner key is generated per run and never written anywhere; the
 * account it controls is recorded by address only.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  http,
  isHex,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  ENTRYPOINT_V07,
  SIMPLE_ACCOUNT_ABI,
  SIMPLE_ACCOUNT_FACTORY_ABI,
  SIMPLE_ACCOUNT_FACTORY_V07,
  buildSponsoredOp,
  simpleAccountInitCode,
  spikeGasPlan,
} from "../src/fleet/sponsored-op.js";

const DEFAULT_RPC = "https://rpc.testnet.chain.robinhood.com";
const RECORD = path.resolve("deployments/fleet-46630.json");
const RPC_URL = process.env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC;

/** The fleet app sponsoring itself: one budget, named so it cannot be mistaken for a fleet campaign. */
const SPONSOR = keccak256(stringToHex("sponsor:chit-fleet-app"));
const PAYMASTER_DEPOSIT = parseEther("0.002");
const SPONSOR_BUDGET = parseEther("0.001");

const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const ESCROW_ABI = parseAbi([
  "function settler() view returns (address)",
  "function setSettler(address settler_)",
  "function registerCampaign(bytes32 campaign, address owner)",
  "function ownerOf(bytes32 campaign) view returns (address)",
  "function fund(bytes32 campaign) payable",
  "function budget(bytes32 campaign) view returns (uint256 funded, uint256 reserved, uint256 spent, uint256 unused)",
  "function reservationOf(bytes32 campaign, bytes32 key) view returns ((uint256 amount, uint256 committed, uint64 lockedUntil, uint8 state))",
]);
const PAYMASTER_ABI = parseAbi([
  "function deposit() payable",
  "function getDeposit() view returns (uint256)",
  "event Sponsored(bytes32 indexed campaign, bytes32 indexed key, address indexed sender)",
]);
const PROBE_ABI = parseAbi([
  "function ping(bytes32 note)",
  "function pings(address account) view returns (uint256)",
  "event Pinged(address indexed account, bytes32 note)",
]);

type Sponsorship = {
  escrow?: Address;
  paymaster?: Address;
  probe?: Address;
  sponsor?: Hex;
  deployTx?: Record<string, Hex>;
  runs?: unknown[];
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

  const record = JSON.parse(await readFile(RECORD, "utf8")) as Record<string, unknown> & { sponsorship?: Sponsorship };
  const sponsorship: Sponsorship = record.sponsorship ?? {};
  const save = async (): Promise<void> => {
    record.sponsorship = sponsorship;
    await writeFile(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  };

  const balance = await publicClient.getBalance({ address: operator.address });
  console.log(`operator ${operator.address} holds ${formatEther(balance)} ETH on 46630`);
  if (balance < parseEther("0.005")) throw new Error("fund the operator with at least 0.005 ETH before the spike");

  // The sender type, checked before anything is spent (spec, Assumptions).
  const implementation = await publicClient.readContract({
    address: SIMPLE_ACCOUNT_FACTORY_V07, abi: SIMPLE_ACCOUNT_FACTORY_ABI, functionName: "accountImplementation",
  });
  const boundEntryPoint = await publicClient.readContract({ address: implementation, abi: SIMPLE_ACCOUNT_ABI, functionName: "entryPoint" });
  if (boundEntryPoint.toLowerCase() !== ENTRYPOINT_V07) {
    throw new Error(`the SimpleAccount factory at ${SIMPLE_ACCOUNT_FACTORY_V07} serves ${boundEntryPoint}, not EntryPoint v0.7; the spike needs a v0.7 account`);
  }

  const send = async (label: string, request: () => Promise<Hex>): Promise<{ hash: Hex; address?: Address }> => {
    const hash = await request();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    console.log(`${label}: ${hash}${receipt.contractAddress ? ` -> ${receipt.contractAddress}` : ""}`);
    return receipt.contractAddress ? { hash, address: receipt.contractAddress as Address } : { hash };
  };
  const deploy = async (name: string, args: readonly unknown[]): Promise<Address> => {
    const { abi, bytecode } = await artifact(name);
    const { hash, address } = await send(`deploy ${name}`, () =>
      wallet.deployContract({ abi: abi as never, bytecode, args: args as never }),
    );
    if (!address) throw new Error(`${name} deployed without an address: ${hash}`);
    sponsorship.deployTx = { ...(sponsorship.deployTx ?? {}), [name]: hash };
    return address;
  };

  // --- the sponsor's side, once ---
  if (!sponsorship.escrow) {
    sponsorship.escrow = await deploy("FleetCampaignEscrow", [operator.address]);
    await save();
  }
  if (!sponsorship.paymaster) {
    sponsorship.paymaster = await deploy("FleetPaymaster", [ENTRYPOINT_V07, operator.address, sponsorship.escrow, 0]);
    await save();
  }
  if (!sponsorship.probe) {
    sponsorship.probe = await deploy("FleetSponsorProbe", []);
    await save();
  }
  const { escrow, paymaster, probe } = sponsorship as Required<Pick<Sponsorship, "escrow" | "paymaster" | "probe">>;
  sponsorship.sponsor = SPONSOR;

  const settler = await publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "settler" });
  if (settler.toLowerCase() !== paymaster.toLowerCase()) {
    if (settler !== "0x0000000000000000000000000000000000000000") {
      throw new Error(`the sponsorship escrow's settler is ${settler}, not this paymaster; the role is set once, deploy a fresh escrow`);
    }
    await send("escrow.setSettler(paymaster)", () =>
      wallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "setSettler", args: [paymaster] }),
    );
  }
  let owner: Address = "0x0000000000000000000000000000000000000000";
  try {
    owner = await publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "ownerOf", args: [SPONSOR] });
  } catch {
    // CampaignMissing: not registered yet.
  }
  if (owner === "0x0000000000000000000000000000000000000000") {
    await send("escrow.registerCampaign(sponsor, operator)", () =>
      wallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "registerCampaign", args: [SPONSOR, operator.address] }),
    );
  }
  const budget = await publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "budget", args: [SPONSOR] });
  if (budget[3] < SPONSOR_BUDGET / 2n) {
    await send(`escrow.fund(sponsor) ${formatEther(SPONSOR_BUDGET)} ETH`, () =>
      wallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "fund", args: [SPONSOR], value: SPONSOR_BUDGET }),
    );
  }
  const deposit = await publicClient.readContract({ address: paymaster, abi: PAYMASTER_ABI, functionName: "getDeposit" });
  if (deposit < PAYMASTER_DEPOSIT / 2n) {
    await send(`paymaster.deposit() ${formatEther(PAYMASTER_DEPOSIT)} ETH`, () =>
      wallet.writeContract({ address: paymaster, abi: PAYMASTER_ABI, functionName: "deposit", value: PAYMASTER_DEPOSIT }),
    );
  }
  await save();

  // --- the user's side: an account that has never existed, holding nothing ---
  const throwawayOwner = privateKeyToAccount(generatePrivateKey());
  const salt = 0n;
  const sender = await publicClient.readContract({
    address: SIMPLE_ACCOUNT_FACTORY_V07, abi: SIMPLE_ACCOUNT_FACTORY_ABI, functionName: "getAddress", args: [throwawayOwner.address, salt],
  });
  const senderBalanceBefore = await publicClient.getBalance({ address: sender });
  const senderCodeBefore = await publicClient.getCode({ address: sender });
  if (senderBalanceBefore !== 0n || senderCodeBefore) throw new Error(`fresh account ${sender} is not fresh`);
  console.log(`throwaway smart account ${sender} (no ETH, not deployed)`);

  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? (await publicClient.getGasPrice());
  const plan = spikeGasPlan(baseFee);
  const key = keccak256(stringToHex(`sponsor-spike:${sender}:${block.number}`));
  const note = keccak256(stringToHex(`chit sponsor spike ${new Date().toISOString()}`));
  const validUntil = Number(block.timestamp) + 600;

  const { op, maxCost } = await buildSponsoredOp({
    sender, initCode: simpleAccountInitCode(throwawayOwner.address, salt), nonce: 0n,
    target: probe, data: encodeFunctionData({ abi: PROBE_ABI, functionName: "ping", args: [note] }),
    plan, paymaster, sponsor: SPONSOR, key, chainId, validUntil,
    signSponsorship: (digest) => operator.signMessage({ message: { raw: digest } }),
  });
  const userOpHash = await publicClient.readContract({ address: ENTRYPOINT_V07, abi: entryPoint07Abi, functionName: "getUserOpHash", args: [op] });
  const signed = { ...op, signature: await throwawayOwner.signMessage({ message: { raw: userOpHash } }) };

  const budgetBefore = await publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "budget", args: [SPONSOR] });
  const depositBefore = await publicClient.readContract({ address: paymaster, abi: PAYMASTER_ABI, functionName: "getDeposit" });
  const operatorBefore = await publicClient.getBalance({ address: operator.address });

  // The operator bundles: handleOps from its own key, itself as beneficiary,
  // priced as the op is so the refund matches what it paid.
  const { hash } = await send("EntryPoint.handleOps([op], operator)", () =>
    wallet.writeContract({
      address: ENTRYPOINT_V07, abi: entryPoint07Abi, functionName: "handleOps", args: [[signed], operator.address],
      gas: 2_000_000n, maxFeePerGas: plan.maxFeePerGas, maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
    }),
  );
  const receipt = await publicClient.getTransactionReceipt({ hash });
  const [opEvent] = parseEventLogs({ abi: entryPoint07Abi, eventName: "UserOperationEvent", logs: receipt.logs });
  const [pinged] = parseEventLogs({ abi: PROBE_ABI, eventName: "Pinged", logs: receipt.logs });
  const [sponsored] = parseEventLogs({ abi: PAYMASTER_ABI, eventName: "Sponsored", logs: receipt.logs });
  if (!opEvent?.args.success) throw new Error(`the op did not succeed: ${hash}`);
  if (pinged?.args.account.toLowerCase() !== sender.toLowerCase()) throw new Error(`the probe did not see ${sender}: ${hash}`);
  if (sponsored?.args.key !== key) throw new Error(`the paymaster did not settle key ${key}: ${hash}`);

  const budgetAfter = await publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "budget", args: [SPONSOR] });
  const depositAfter = await publicClient.readContract({ address: paymaster, abi: PAYMASTER_ABI, functionName: "getDeposit" });
  const operatorAfter = await publicClient.getBalance({ address: operator.address });
  const senderBalanceAfter = await publicClient.getBalance({ address: sender });
  const senderCodeAfter = await publicClient.getCode({ address: sender });
  const spent = budgetAfter[2] - budgetBefore[2];
  const charged = depositBefore - depositAfter;

  const run = {
    at: new Date().toISOString(),
    block: receipt.blockNumber.toString(),
    txHash: hash,
    userOpHash,
    sender,
    senderType: "SimpleAccount v0.7 from the canonical factory, deployed by the op's own initCode",
    senderEthBefore: senderBalanceBefore.toString(),
    senderEthAfter: senderBalanceAfter.toString(),
    senderDeployed: Boolean(senderCodeAfter && senderCodeAfter !== "0x"),
    target: probe,
    note,
    key,
    maxCost: maxCost.toString(),
    actualGasUsed: opEvent.args.actualGasUsed.toString(),
    chargedToDeposit: charged.toString(),
    entryPointActualGasCost: opEvent.args.actualGasCost.toString(),
    committedFromBudget: spent.toString(),
    notCoveredByBudget: (charged - spent).toString(),
    reservedAfter: budgetAfter[1].toString(),
    bundler: operator.address,
    bundlerGasUsed: receipt.gasUsed.toString(),
    bundlerEffectiveGasPrice: receipt.effectiveGasPrice.toString(),
    /** The bundler transaction's gas: the operator's real outlay (the deposit charge is refunded to it as beneficiary). */
    operatorOutlayWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    /** Outlay minus what the sponsor's budget committed: the operator's share until a fee covers it. */
    operatorUncoveredWei: (receipt.gasUsed * receipt.effectiveGasPrice - spent).toString(),
    operatorEoaDeltaWei: (operatorBefore - operatorAfter).toString(),
  };
  sponsorship.runs = [...(sponsorship.runs ?? []), run];
  await save();

  console.log("");
  console.log(`sponsored op ${userOpHash} in ${hash}`);
  console.log(`  account ${sender}: ${formatEther(senderBalanceAfter)} ETH before and after, deployed=${run.senderDeployed}`);
  console.log(`  budget: committed ${spent} wei of a ${maxCost} wei ceiling; ${budgetAfter[1]} wei still reserved`);
  console.log(`  deposit: charged ${charged} wei, refunded to the operator as beneficiary`);
  console.log(`  operator: outlay ${receipt.gasUsed * receipt.effectiveGasPrice} wei on the bundler transaction, ${receipt.gasUsed * receipt.effectiveGasPrice - spent} wei of it not covered by the budget`);
  console.log(`recorded under sponsorship.runs in ${RECORD}`);
};

main().catch((error: unknown) => { console.error(error); process.exit(1); });
