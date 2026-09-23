/**
 * Gas sponsorship: the hosted wiring.
 *
 * Builds the sponsor router once per function instance from the environment,
 * the way service-runtime.ts builds the fleet router, and serves
 * POST /api/fleet/sponsor. Kept in its own file so the sponsorship product
 * can be switched on, off, or redeployed without touching the fleet's wiring.
 *
 * Reads, never invents:
 *   FLEET_SPONSOR_PRIVATE_KEY                            the sponsor route's own account: signs sponsorships, bundles, registers sponsors
 *   FLEET_CHAIN_ID                                       46630 unless set; on 4663 sponsorship is off for the beta (FR-021)
 *   FLEET_SPONSOR_PAYMASTER_ADDRESS                      the FleetPaymaster deployed with a fee (scripts/sponsor-deploy-live.ts)
 *   FLEET_SPONSOR_ESCROW_ADDRESS                         the escrow that paymaster settles against
 *   DATABASE_URL                                         Neon; sponsors, policies and the daily ledger live there
 *   FLEET_ORIGIN, ROBINHOOD_TESTNET_RPC_URL, FLEET_NONCE_SECRET   as for the fleet
 *
 * Without the two addresses the route answers 503 with a reason, never a
 * guess. Without DATABASE_URL it runs on a memory store and says so in the
 * log: the daily caps then hold per instance only, which is fine on one
 * machine and not on a fleet of functions.
 *
 * The key is the route's own (T028). It used to be the pool operator's, from
 * the operator's variable: two services on one account and one nonce sequence
 * with no lock between them, and the key that moves the pool in a function
 * that never needs it. sponsorSignerFrom() below is the whole rule.
 */

import { neon } from "@neondatabase/serverless";
import { createPublicClient, createWalletClient, http, isHex, keccak256, stringToBytes, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignService } from "./campaign-service.js";
import { robinhoodChain } from "./chain-def.js";
import { createSponsorChain } from "./sponsor-chain.js";
import { SponsorRouter } from "./sponsor-routes.js";
import { SponsorService } from "./sponsor-service.js";
import { MemorySponsorStore, type SponsorStore } from "./sponsor-store.js";
import { NeonSponsorStore } from "./sponsor-store-neon.js";
import { isAddress, type Address } from "./types.js";

const ORIGIN = process.env.FLEET_ORIGIN || "https://chit.tools";
const CHAIN_ID = 46630;
const MAINNET = 4663;
const DEFAULT_RPC = "https://rpc.testnet.chain.robinhood.com";

const warned = new Set<string>();
const warnOnce = (what: string, message: string): void => {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(message);
};

type Env = Record<string, string | undefined>;
type Key = `0x${string}`;
export type SponsorSigner = { key: Key; shared: boolean } | { fault: string; off?: true };

const keyOf = (value: string | undefined): Key | undefined => (value && isHex(value) && value.length === 66 ? value : undefined);

/**
 * Which key the route signs with, or why it may not sign at all.
 *
 * Its own, from FLEET_SPONSOR_PRIVATE_KEY. The operator's key under that name
 * is refused: the point is another account, not another variable. A key that
 * is set and malformed is a fault and never a reason to fall back. On mainnet
 * the answer is no, whatever is configured.
 *
 * One fallback stands, on testnet only and said in the log: with no key of its
 * own the route still signs with the operator's. The sponsor set deployed on
 * 46630 names the pool operator as its operator, so until that set is
 * redeployed for a sponsor account there is no other key it could sign with.
 */
export const sponsorSignerFrom = (env: Env): SponsorSigner => {
  if (Number(env["FLEET_CHAIN_ID"] || CHAIN_ID) === MAINNET) return { fault: "sponsorship is off on mainnet for the beta (FR-021)", off: true };
  const operator = keyOf(env["FLEET_OPERATOR_PRIVATE_KEY"] || env["DEPLOYER_PRIVATE_KEY"]);
  const own = env["FLEET_SPONSOR_PRIVATE_KEY"];
  if (own) {
    const key = keyOf(own);
    if (!key) return { fault: "FLEET_SPONSOR_PRIVATE_KEY is not a 32-byte hex key" };
    if (operator && key.toLowerCase() === operator.toLowerCase()) {
      return { fault: "FLEET_SPONSOR_PRIVATE_KEY is the operator's key: the sponsor route needs an account of its own" };
    }
    return { key, shared: false };
  }
  return operator ? { key: operator, shared: true } : { fault: "no key: set FLEET_SPONSOR_PRIVATE_KEY" };
};

const nonceSecretFromEnv = (key: Key): string => {
  const own = process.env.FLEET_NONCE_SECRET;
  if (own && own.length >= 32) return own;
  return keccak256(stringToBytes(`chit-fleet-challenge-v1|${key}`));
};

const addressFromEnv = (name: string): Address | undefined => {
  const value = process.env[name];
  return isAddress(value) ? value : undefined;
};

const clients = (key: `0x${string}`) => {
  const rpcUrl = process.env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC;
  const chain = robinhoodChain(CHAIN_ID, rpcUrl);
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
let off = false;

export const getSponsorRouter = (): SponsorRouter | undefined => {
  if (router || fault) return router;
  const signer = sponsorSignerFrom(process.env);
  if ("fault" in signer) { fault = signer.fault; off = signer.off === true; return undefined; }
  if (signer.shared) {
    warnOnce("key", "FLEET_SPONSOR_PRIVATE_KEY is not set: the sponsor route signs with the pool operator's key, two services on one nonce sequence");
  }
  const paymaster = addressFromEnv("FLEET_SPONSOR_PAYMASTER_ADDRESS");
  const escrow = addressFromEnv("FLEET_SPONSOR_ESCROW_ADDRESS");
  if (!paymaster || !escrow) { fault = "FLEET_SPONSOR_PAYMASTER_ADDRESS and FLEET_SPONSOR_ESCROW_ADDRESS must both be set"; return undefined; }
  const { wallet, publicClient } = clients(signer.key);
  const nonceSecret = nonceSecretFromEnv(signer.key);
  const auth = new CampaignService({ origin: ORIGIN, chainId: CHAIN_ID, maxTtlSeconds: 600 }, { nonceSecret });
  const chain = createSponsorChain(wallet, publicClient, { paymaster, escrow });
  const service = new SponsorService({ store: storeFromEnv(), chain });
  router = new SponsorRouter({ auth, service });
  return router;
};

export const handleSponsorRequest = async (request: Request, allowedActions?: readonly string[]): Promise<Response> => {
  const active = getSponsorRouter();
  if (!active) {
    console.error(`sponsor route refused: ${fault}`);
    return Response.json({ code: "dependency_evidence_invalid", retryable: false, reason: off ? "sponsorship_off" : "sponsorship_not_configured" }, { status: 503 });
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
