/**
 * Stage 1 on-chain adapter for the campaign router.
 *
 * Binds the deployed escrow, factory, and session policy (plus the operator's
 * signer) behind the `FleetChain` port the router calls at create, fund,
 * activate, and buy. Everything chain-specific (viem clients, selectors, wei)
 * stays here so the router keeps speaking the wire types only.
 */

import { keccak256, stringToBytes, toFunctionSelector, type Address as ViemAddress, type Hex as ViemHex, type PublicClient, type WalletClient } from "viem";

import { runFleetBuy, type FleetBuyReport } from "./chain-buy.js";
import { accountsOf, createFleet, isEnrolled, openSession, readCampaign, registerCampaign, sessionOf, setSessionState, type OnChainCampaign, type OnChainSession } from "./chain-campaign.js";
import { readBudget } from "./operator-executor.js";
import type { Address, Budget, FleetAccountInit, Hex, Policy, Uint } from "./types.js";

export type ChainBuy = { account: Address; key: Hex; value: Uint; callData: Hex; maxCost: Uint };

export type ChainBuyOutcome = { account: Address; status: "sponsored" | "rejected"; txHash?: Hex };

/** The router's view of the chain: four operator-side steps, all evidence-backed. */
export type FleetChain = {
  registerCampaign(campaign: Hex, owner: Address): Promise<void>;
  readBudget(campaign: Hex): Promise<Budget>;
  /** Creates the fleet accounts and opens the session; returns the account addresses. */
  activate(campaign: Hex, inits: readonly FleetAccountInit[], policy: Policy): Promise<Address[]>;
  buy(campaign: Hex, router: Address, buys: readonly ChainBuy[]): Promise<{ results: ChainBuyOutcome[]; budget: Budget }>;
  /** Owner, budget, and open session as the chain holds them; undefined if unregistered. */
  loadCampaign(campaign: Hex): Promise<OnChainCampaign | undefined>;
  /** The session alone, for campaigns the escrow never knew about. */
  sessionOf(campaign: Hex): Promise<OnChainSession | undefined>;
  isEnrolled(campaign: Hex, account: Address): Promise<boolean>;
  /** The fleet accounts this campaign created, from the factory's own event. */
  accountsOf(campaign: Hex): Promise<Address[]>;
  /** Pause, resume, or revoke the session on-chain; returns the tx hash. */
  control(campaign: Hex, event: "pause" | "resume" | "revoke"): Promise<Hex>;
};

export type ChainAddresses = { escrow: Address; factory: Address; policy: Address };

/** Deterministic bytes32 campaign key for a service campaign id. */
export const campaignKey = (id: string): Hex => keccak256(stringToBytes(id));

/** Selector for the approved function signature the policy enforces on-chain. */
export const functionSelector = (signature: string): Hex => toFunctionSelector(signature);

const toBudget = (budget: FleetBuyReport["budget"]): Budget => ({
  funded: budget.funded.toString(),
  reserved: budget.reserved.toString(),
  spent: budget.spent.toString(),
  unused: budget.unused.toString(),
});

const byAddress = (a: string, b: string): number => (a.toLowerCase() < b.toLowerCase() ? -1 : 1);

export const createFleetChain = (
  wallet: WalletClient,
  publicClient: PublicClient,
  addresses: ChainAddresses,
): FleetChain => ({
  async registerCampaign(campaign, owner) {
    await registerCampaign(wallet, publicClient, addresses.escrow, campaign, owner as ViemAddress);
  },

  async readBudget(campaign) {
    return toBudget(await readBudget(publicClient, addresses.escrow, campaign));
  },

  async activate(campaign, inits, policy) {
    // The factory and the policy both require strictly increasing addresses.
    const ordered = [...inits].sort((a, b) => byAddress(a.ownerAddress, b.ownerAddress));
    const accounts = await createFleet(wallet, publicClient, addresses.factory, addresses.policy, campaign, ordered);
    const enrolled = [...accounts].sort(byAddress);
    await openSession(wallet, publicClient, addresses.policy, campaign, {
      chainId: BigInt(policy.chainId),
      router: policy.router as ViemAddress,
      selector: functionSelector(policy.function),
      maxTradeValue: BigInt(policy.maxTradeValue),
      perAccountGas: BigInt(policy.perAccountGas),
      totalGas: BigInt(policy.totalGas),
      expiry: BigInt(Math.floor(Date.parse(policy.expiry) / 1000)),
    }, enrolled);
    return enrolled.map((account) => account.toLowerCase() as Address);
  },

  async buy(campaign, router, buys) {
    const report = await runFleetBuy(wallet, publicClient, {
      escrow: addresses.escrow,
      campaign,
      accounts: buys.map((buy) => ({
        account: buy.account as ViemAddress,
        key: buy.key as ViemHex,
        router: router as ViemAddress,
        value: BigInt(buy.value),
        callData: buy.callData as ViemHex,
        maxCost: BigInt(buy.maxCost),
      })),
    });
    return {
      results: report.results.map((r) => ({
        account: r.account.toLowerCase() as Address,
        status: r.status,
        ...(r.txHash ? { txHash: r.txHash as Hex } : {}),
      })),
      budget: toBudget(report.budget),
    };
  },

  loadCampaign(campaign) {
    return readCampaign(publicClient, addresses.escrow, addresses.policy, campaign);
  },

  sessionOf(campaign) {
    return sessionOf(publicClient, addresses.policy, campaign);
  },

  isEnrolled(campaign, account) {
    return isEnrolled(publicClient, addresses.policy, campaign, account as ViemAddress);
  },

  accountsOf(campaign) {
    return accountsOf(publicClient, addresses.factory, campaign) as Promise<Address[]>;
  },

  async control(campaign, event) {
    return (await setSessionState(wallet, publicClient, addresses.policy, campaign, event)) as Hex;
  },
});
