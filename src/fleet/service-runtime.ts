/**
 * Shared Fleet service runtime for the Vercel handlers.
 *
 * One router instance per warm serverless instance, wired entirely from
 * environment configuration. The CHIT RPC endpoint, token address, published
 * fee facts, funding-verification RPC, and operator key are all supplied, never
 * invented; whatever is missing leaves the corresponding capability answering
 * 503 instead of substituting a default fact.
 */

import { createPublicClient, createWalletClient, defineChain, http, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "./campaign-routes.js";
import { CampaignService } from "./campaign-service.js";
import { createFleetChain, type FleetChain } from "./chain-service.js";
import { validateFeeConfig, type FeeConfig } from "./eligibility.js";
import { isAddress, type Address, type Uint } from "./types.js";

const ORIGIN = "https://chit-kohl.vercel.app";
const FLEET_CHAIN_ID = 46630; // Robinhood Chain testnet
const DEFAULT_RPC = "https://rpc.testnet.chain.robinhood.com";
const BALANCE_OF_SELECTOR = "0x70a08231";

/**
 * Stage 1 on-chain wiring. Needs the operator's testnet signer and the three
 * deployed addresses (copy from deployments/fleet-46630.json). Any missing
 * value leaves fund and buy answering 503, never a substituted default.
 *   FLEET_OPERATOR_PRIVATE_KEY   server-side operator signer (testnet only)
 *   FLEET_ESCROW_ADDRESS, FLEET_FACTORY_ADDRESS, FLEET_POLICY_ADDRESS
 *   ROBINHOOD_TESTNET_RPC_URL    optional; defaults to the public testnet RPC
 */
const chainFromEnv = (): FleetChain | undefined => {
  const { FLEET_OPERATOR_PRIVATE_KEY: key, FLEET_ESCROW_ADDRESS: escrow, FLEET_FACTORY_ADDRESS: factory, FLEET_POLICY_ADDRESS: policy } = process.env;
  if (!key || !isHex(key) || key.length !== 66) return undefined;
  if (!isAddress(escrow) || !isAddress(factory) || !isAddress(policy)) return undefined;
  const rpcUrl = process.env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC;
  const chain = defineChain({
    id: FLEET_CHAIN_ID,
    name: "Robinhood Chain Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl);
  const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport });
  const publicClient = createPublicClient({ chain, transport });
  return createFleetChain(wallet, publicClient, { escrow, factory, policy });
};

const feeConfigFromEnv = (): FeeConfig | undefined => {
  const { CHIT_FEE_THRESHOLD, CHIT_BASE_FEE, CHIT_FEE_DISCOUNT, CHIT_FEE_RECIPIENT } = process.env;
  if (!CHIT_FEE_THRESHOLD || !CHIT_BASE_FEE || !CHIT_FEE_DISCOUNT || !CHIT_FEE_RECIPIENT) return undefined;
  return validateFeeConfig({
    threshold: CHIT_FEE_THRESHOLD,
    baseFee: CHIT_BASE_FEE,
    discount: CHIT_FEE_DISCOUNT,
    feeAsset: "ETH",
    recipient: CHIT_FEE_RECIPIENT,
  });
};

/** Read-only `balanceOf` against the configured CHIT RPC (FR-002). */
const chitBalanceOf = async (wallet: Address): Promise<Uint> => {
  const rpcUrl = process.env.CHIT_RPC_URL;
  const token = process.env.CHIT_TOKEN_ADDRESS;
  if (!rpcUrl || !token) throw new Error("chit_configuration_missing");

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { to: token, data: `${BALANCE_OF_SELECTOR}${wallet.slice(2).toLowerCase().padStart(64, "0")}` },
        "latest",
      ],
    }),
  });
  const payload = (await response.json()) as { result?: unknown };
  if (!response.ok || typeof payload.result !== "string") throw new Error("chit_balance_unavailable");
  return BigInt(payload.result).toString();
};

// Campaign records live for the instance's lifetime in this MVP; durable
// storage is a later, separately-evidenced step.
let router: CampaignRouter | undefined;

/** Shared Vercel handler body for the three fleet routes. */
export const handleFleetRequest = async (
  request: Request,
  allowedActions?: readonly string[],
): Promise<Response> => {
  const active = getFleetRouter();
  try {
    const body: unknown = await request.json();
    const action = (body as { action?: unknown }).action;
    if (allowedActions && !allowedActions.includes(String(action))) {
      return Response.json({ code: "state_invalid", retryable: false }, { status: 409 });
    }
    const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
    const result = await active.handle(body, idempotencyKey);
    return Response.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("fleet route failed", error);
    return Response.json({ code: "dependency_evidence_invalid", retryable: true }, { status: 503 });
  }
};

/**
 * Open access on testnet (decided 2026-09-02): the router exists without any
 * CHIT fee facts and quotes zero. Configuring the CHIT_FEE_* set restores the
 * published-fee path; that is a later, privacy-preserving decision for mainnet.
 */
export const getFleetRouter = (): CampaignRouter => {
  if (router) return router;
  const feeConfig = feeConfigFromEnv();
  const chain = chainFromEnv();
  const deps: RouterDeps = {
    service: new CampaignService({ origin: ORIGIN, chainId: FLEET_CHAIN_ID, maxTtlSeconds: 300 }),
    ...(feeConfig ? { feeConfig, chitBalanceOf } : {}),
    // Without the chain, fund and buy answer 503 dependency_evidence_invalid.
    ...(chain ? { chain } : {}),
  };
  router = new CampaignRouter(deps);
  return router;
};
