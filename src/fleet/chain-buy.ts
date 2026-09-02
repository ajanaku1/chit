/**
 * Stage 1 on-chain fleet buy service.
 *
 * Ties the operator-executes buy to the deployed escrow: confirm the campaign is
 * funded on-chain, then run one sponsored buy per account, settling each against
 * the escrow. A per-account failure is isolated (that account is rejected and its
 * reservation rolled back) while the rest proceed. This is what the buy route
 * calls once the service is configured with the operator key and the deployed
 * addresses.
 */

import type { Address, Hex, PublicClient, WalletClient } from "viem";

import { executeSponsoredBuy, readBudget, type BuyResult } from "./operator-executor.js";

export type AccountBuy = {
  account: Address;
  key: Hex;
  router: Address;
  value: bigint;
  callData: Hex;
  maxCost: bigint;
};

export type FleetBuyRequest = {
  escrow: Address;
  campaign: Hex;
  accounts: readonly AccountBuy[];
};

export type AccountOutcome = {
  account: Address;
  status: "sponsored" | "rejected";
  txHash?: Hex;
  gasCost?: bigint;
  reason?: string;
};

export type FleetBuyReport = {
  results: AccountOutcome[];
  budget: { funded: bigint; reserved: bigint; spent: bigint; unused: bigint };
};

/** Confirms the campaign holds at least `required` unused ETH on-chain. */
export const verifyCampaignFunding = async (
  publicClient: PublicClient,
  escrow: Address,
  campaign: Hex,
  required: bigint,
): Promise<boolean> => {
  const budget = await readBudget(publicClient, escrow, campaign);
  return budget.unused >= required;
};

/**
 * Runs one sponsored buy per account and reports the outcome, then reads the
 * final on-chain budget. Each account settles independently; one failure does
 * not block the others.
 */
export const runFleetBuy = async (
  wallet: WalletClient,
  publicClient: PublicClient,
  request: FleetBuyRequest,
): Promise<FleetBuyReport> => {
  const results: AccountOutcome[] = [];

  for (const buy of request.accounts) {
    try {
      const settled: BuyResult = await executeSponsoredBuy(wallet, publicClient, {
        escrow: request.escrow,
        account: buy.account,
        campaign: request.campaign,
        key: buy.key,
        router: buy.router,
        value: buy.value,
        callData: buy.callData,
        maxCost: buy.maxCost,
      });
      results.push({ account: buy.account, status: "sponsored", txHash: settled.txHash, gasCost: settled.actualGasCost });
    } catch (error) {
      results.push({ account: buy.account, status: "rejected", reason: (error as Error).message });
    }
  }

  const budget = await readBudget(publicClient, request.escrow, request.campaign);
  return { results, budget };
};
