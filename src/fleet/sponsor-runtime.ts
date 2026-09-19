/**
 * Gas sponsorship: the hosted wiring.
 *
 * Builds the sponsor router once per function instance from the environment,
 * the way service-runtime.ts builds the fleet router, and serves
 * POST /api/fleet/sponsor. Kept in its own file so the sponsorship product
 * can be switched on, off, or redeployed without touching the fleet's wiring.
 *
 * Reads, never invents:
 *   FLEET_OPERATOR_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY   the operator: signs sponsorships, bundles, registers sponsors
 *   FLEET_SPONSOR_PAYMASTER_ADDRESS                      the FleetPaymaster deployed with a fee (scripts/sponsor-deploy-live.ts)
 *   FLEET_SPONSOR_ESCROW_ADDRESS                         the escrow that paymaster settles against
 *   DATABASE_URL                                         Neon; sponsors, policies and the daily ledger live there
 *   FLEET_ORIGIN, ROBINHOOD_TESTNET_RPC_URL, FLEET_NONCE_SECRET   as for the fleet
 *
 * Without the two addresses the route answers 503 with a reason, never a
 * guess. Without DATABASE_URL it runs on a memory store and says so in the
 * log: the daily caps then hold per instance only, which is fine on one
 * machine and not on a fleet of functions.
 */

import { neon } from "@neondatabase/serverless";
import { createPublicClient, createWalletClient, defineChain, http, isHex, keccak256, stringToBytes, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignService } from "./campaign-service.js";
import { createSponsorChain } from "./sponsor-chain.js";
import { SponsorRouter } from "./sponsor-routes.js";
import { SponsorService } from "./sponsor-service.js";
import { MemorySponsorStore, type SponsorStore } from "./sponsor-store.js";
import { NeonSponsorStore } from "./sponsor-store-neon.js";
import { isAddress, type Address } from "./types.js";

const ORIGIN = process.env.FLEET_ORIGIN || "https://chit.tools";
const CHAIN_ID = 46630;
const DEFAULT_RPC = "https://rpc.testnet.chain.robinhood.com";

const warned = new Set<string>();
const warnOnce = (what: string, message: string): void => {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(message);
};

const operatorKeyFromEnv = (): `0x${string}` | undefined => {
  const key = process.env.FLEET_OPERATOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  return key && isHex(key) && key.length === 66 ? key : undefined;
};

const nonceSecretFromEnv = (): string | undefined => {
  const own = process.env.FLEET_NONCE_SECRET;
  if (own && own.length >= 32) return own;
  const key = operatorKeyFromEnv();
  if (!key) return undefined;
  return keccak256(stringToBytes(`chit-fleet-challenge-v1|${key}`));
};

const addressFromEnv = (name: string): Address | undefined => {
  const value = process.env[name];
  return isAddress(value) ? value : undefined;
};

const clients = (key: `0x${string}`) => {
  const rpcUrl = process.env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC;
  const chain = defineChain({
    id: CHAIN_ID,
    name: "Robinhood Chain Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl, { batch: true, retryCount: 5, retryDelay: 250, timeout: 20_000 });
  return {
    wallet: createWalletClient({ account: privateKeyToAccount(key), chain, transport }),
    publicClient: createPublicClient({ chain, transport }) as unknown as PublicClient,
  };
};

const storeFromEnv = (): SponsorStore => {
  const url = process.env.DATABASE_URL;
  if (url) {
    const sql = neon(url);
    return new NeonSponsorStore({ query: (query, params) => sql.query(query, params) as Promise<readonly Record<string, unknown>[]> });
  }
  warnOnce("store", "DATABASE_URL is not set: the sponsor ledger is in memory, and daily caps hold per instance only");
  return new MemorySponsorStore();
};

let router: SponsorRouter | undefined;
let fault: string | undefined;

export const getSponsorRouter = (): SponsorRouter | undefined => {
  if (router || fault) return router;
  const key = operatorKeyFromEnv();
  const paymaster = addressFromEnv("FLEET_SPONSOR_PAYMASTER_ADDRESS");
  const escrow = addressFromEnv("FLEET_SPONSOR_ESCROW_ADDRESS");
  if (!key) { fault = "no operator key"; return undefined; }
  if (!paymaster || !escrow) { fault = "FLEET_SPONSOR_PAYMASTER_ADDRESS and FLEET_SPONSOR_ESCROW_ADDRESS must both be set"; return undefined; }
  const { wallet, publicClient } = clients(key);
  const nonceSecret = nonceSecretFromEnv();
  const auth = new CampaignService({ origin: ORIGIN, chainId: CHAIN_ID, maxTtlSeconds: 600 }, nonceSecret ? { nonceSecret } : {});
  const chain = createSponsorChain(wallet, publicClient, { paymaster, escrow });
  const service = new SponsorService({ store: storeFromEnv(), chain });
  router = new SponsorRouter({ auth, service });
  return router;
};

export const handleSponsorRequest = async (request: Request, allowedActions?: readonly string[]): Promise<Response> => {
  const active = getSponsorRouter();
  if (!active) {
    console.error(`sponsor route refused: ${fault}`);
    return Response.json({ code: "dependency_evidence_invalid", retryable: false, reason: "sponsorship_not_configured" }, { status: 503 });
  }
  try {
    const body: unknown = await request.json();
    const action = (body as { action?: unknown }).action;
    if (allowedActions && !allowedActions.includes(String(action))) {
      return Response.json({ code: "state_invalid", retryable: false }, { status: 409 });
    }
    const result = await active.handle(body);
    return Response.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("sponsor route failed:", error instanceof Error ? `${error.name}: ${error.message.split("\n")[0]}` : String(error));
    return Response.json({ code: "dependency_evidence_invalid", retryable: true }, { status: 503 });
  }
};
