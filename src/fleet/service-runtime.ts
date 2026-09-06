/**
 * Shared Fleet service runtime for the Vercel handlers.
 *
 * One router instance per warm serverless instance, wired entirely from
 * environment configuration. The CHIT RPC endpoint, token address, published
 * fee facts, funding-verification RPC, and operator key are all supplied, never
 * invented; whatever is missing leaves the corresponding capability answering
 * 503 instead of substituting a default fact.
 */

import { createPublicClient, createWalletClient, defineChain, http, isHex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "./campaign-routes.js";
import { CampaignService } from "./campaign-service.js";
import { createFleetChain, type FleetChain } from "./chain-service.js";
import { validateFeeConfig, type FeeConfig } from "./eligibility.js";
import { isAddress, type Address, type Uint } from "./types.js";

// The primary wallet signs challenges over the page origin it is on
// (window.location.origin), so this must be the served site, chit.tools.
// FLEET_ORIGIN overrides it for previews.
const ORIGIN = process.env.FLEET_ORIGIN || "https://chit.tools";
const FLEET_CHAIN_ID = 46630; // Robinhood Chain testnet
const DEFAULT_RPC = "https://rpc.testnet.chain.robinhood.com";
const BALANCE_OF_SELECTOR = "0x70a08231";

/**
 * Deployed Stage 1 contracts on 46630, as recorded in deployments/fleet-46630.json
 * (deployed 2026-08-31). Override with FLEET_*_ADDRESS only after a redeploy.
 */
const DEPLOYED_46630 = {
  escrow: "0xd2c31ec466ead5f745bc6ba08cc49ff8435f1325",
  factory: "0x5c0e2ec619c11b66e0e0efb7931bccfa6b784ea6",
  policy: "0x57c7436bbbb40b08adef5c84f0aeaee0c4f3e011",
} as const;

/**
 * Stage 1 on-chain wiring. The only required secret is the operator's testnet
 * signer, read from FLEET_OPERATOR_PRIVATE_KEY or, as the deployer is also the
 * operator, DEPLOYER_PRIVATE_KEY. Without it, fund and buy answer 503.
 *   ROBINHOOD_TESTNET_RPC_URL    optional; defaults to the public testnet RPC
 *   FLEET_ESCROW_ADDRESS, FLEET_FACTORY_ADDRESS, FLEET_POLICY_ADDRESS
 *                                optional; default to the recorded deployment
 */
const chainFromEnv = (): FleetChain | undefined => {
  const key = process.env.FLEET_OPERATOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!key || !isHex(key) || key.length !== 66) return undefined;
  const escrow = process.env.FLEET_ESCROW_ADDRESS || DEPLOYED_46630.escrow;
  const factory = process.env.FLEET_FACTORY_ADDRESS || DEPLOYED_46630.factory;
  const policy = process.env.FLEET_POLICY_ADDRESS || DEPLOYED_46630.policy;
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
  // Vercel's TypeScript pass infers a json-rpc account on this client and
  // rejects the FleetChain call our local build accepts; the cast pins the
  // account-less PublicClient viem documents for createPublicClient.
  const publicClient = createPublicClient({ chain, transport }) as unknown as PublicClient;
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
