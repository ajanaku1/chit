/**
 * Shared Fleet service runtime for the Vercel handlers.
 *
 * One router instance per warm serverless instance, wired entirely from
 * environment configuration. The CHIT RPC endpoint, token address, published
 * fee facts, funding-verification RPC, and operator key are all supplied, never
 * invented; whatever is missing leaves the corresponding capability answering
 * 503 instead of substituting a default fact.
 */

import { neon } from "@neondatabase/serverless";
import { createPublicClient, createWalletClient, defineChain, http, isHex, keccak256, stringToBytes, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "./campaign-routes.js";
import { CampaignService } from "./campaign-service.js";
import { createFleetPool } from "./chain-pool.js";
import { createFleetChain, type FleetChain } from "./chain-service.js";
import { createMarket, type MarketPort } from "./market.js";
import { ledgerKey } from "./pool-ledger.js";
import { createPoolService, type PoolPort } from "./pool-buy.js";
import { createMemoryStore, type StorePort } from "./store.js";
import { createNeonStore } from "./store-neon.js";
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
  /** Uniswap v4 PoolManager on 46630 (deployments/fleet-46630.json, venue.poolManager). */
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  /** The block that mined campaignEscrowTx 0xf464…708d; the fleet list scans events from here. */
  escrowBlock: 110732061n,
} as const;

/**
 * Stage 1 on-chain wiring. The only required secret is the operator's testnet
 * signer, read from FLEET_OPERATOR_PRIVATE_KEY or, as the deployer is also the
 * operator, DEPLOYER_PRIVATE_KEY. Without it, fund and buy answer 503.
 *   ROBINHOOD_TESTNET_RPC_URL    optional; defaults to the public testnet RPC
 *   FLEET_ESCROW_ADDRESS, FLEET_FACTORY_ADDRESS, FLEET_POLICY_ADDRESS
 *                                optional; default to the recorded deployment
 */
const operatorKeyFromEnv = (): `0x${string}` | undefined => {
  const key = process.env.FLEET_OPERATOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  return key && isHex(key) && key.length === 66 ? key : undefined;
};

/**
 * Challenge nonces must verify on whichever function instance receives the
 * signed action, so they are HMACs under a secret every instance derives the
 * same way from the operator key already in the environment. Domain-separated;
 * the key itself is never used directly.
 */
const nonceSecretFromEnv = (): string | undefined => {
  const own = process.env.FLEET_NONCE_SECRET;
  if (own && own.length >= 32) return own;
  const key = operatorKeyFromEnv();
  if (!key) return undefined;
  warnOnce("nonce", "FLEET_NONCE_SECRET is not set: challenge nonces are keyed from the operator key");
  return keccak256(stringToBytes(`chit-fleet-challenge-v1|${key}`));
};

/**
 * The ledger key opens every sealed depositor reference the pool holds. It
 * used to be derived from the operator key, so one leaked variable was the
 * custodian, the ledger and the nonce secret at once (audit A34). It can now
 * be its own secret. Changing it on a pool that already holds draws makes
 * their references unreadable, so set it before the first draw or not at
 * all; the derivation stays as the default so nothing deployed breaks.
 */
const ledgerKeyFromEnv = (operatorKey: `0x${string}`): `0x${string}` => {
  const own = process.env.FLEET_LEDGER_KEY;
  if (own && isHex(own) && own.length === 66) return own;
  warnOnce("ledger", "FLEET_LEDGER_KEY is not set: the ledger key is derived from the operator key");
  return ledgerKey(operatorKey);
};

/**
 * The shared store. With DATABASE_URL, Neon: every instance sees the same
 * idempotency results, nonce burns, slice claims and operator lock. Without
 * it, this instance's memory, with a warning, because on Vercel that means a
 * retry on a second instance can run twice.
 */
const storeFromEnv = (): StorePort => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    warnOnce("store", "DATABASE_URL is not set: idempotency and slice claims live in this instance only");
    return createMemoryStore();
  }
  const store = createNeonStore(neon(url));
  void store.initialize().catch((err: unknown) => console.error("fleet store: initialize failed", err));
  return store;
};

const warned = new Set<string>();
const warnOnce = (what: string, message: string): void => {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(message);
};

/**
 * Stage 2 pool address. Absent means the pool is not configured and the
 * balance/draw actions answer 503 rather than substituting a default.
 */
const poolAddressFromEnv = (): Address | undefined => {
  const address = process.env.FLEET_POOL_ADDRESS;
  return isAddress(address) ? address : undefined;
};

/**
 * Stage 2 pool service. Needs the operator signer and FLEET_POOL_ADDRESS; the
 * ledger key derives from the operator key, so no new secret is introduced.
 */
const poolFromEnv = (): PoolPort | undefined => {
  const key = operatorKeyFromEnv();
  const address = poolAddressFromEnv();
  if (!key || !address) return undefined;
  const { wallet, publicClient } = clients(key);
  return createPoolService(wallet, publicClient, createFleetPool(wallet, publicClient, address), ledgerKeyFromEnv(key));
};

/**
 * Tokens a sponsored buy may target, comma separated. Unset means any token,
 * which is the testnet default and is logged as such: on a chain where anyone
 * can seed a pool, an open buy route is a way to spend the operator's gas on
 * swaps that were never meant to fill.
 */
const allowedTokensFromEnv = (): Address[] | undefined => {
  const raw = process.env.FLEET_TOKEN_ALLOWLIST;
  if (!raw) return undefined;
  const tokens = raw.split(",").map((t) => t.trim()).filter(Boolean);
  const bad = tokens.filter((t) => !isAddress(t));
  if (bad.length > 0) throw new Error(`FLEET_TOKEN_ALLOWLIST holds a value that is not an address: ${bad.join(", ")}`);
  return tokens as Address[];
};

/** Slippage a sponsored buy tolerates, in basis points; unset means the router's default. */
const maxSlippageFromEnv = (): number | undefined => {
  const raw = process.env.FLEET_MAX_SLIPPAGE_BPS;
  if (!raw) return undefined;
  const bps = Number(raw);
  if (!Number.isInteger(bps) || bps < 1 || bps > 5_000) throw new Error(`FLEET_MAX_SLIPPAGE_BPS must be an integer between 1 and 5000, got ${raw}`);
  return bps;
};

/** Read-only market facts for the trading panel; the operator's client, no signing. */
const marketFromEnv = (): MarketPort | undefined => {
  const key = operatorKeyFromEnv();
  if (!key) return undefined;
  const poolManager = process.env.FLEET_POOL_MANAGER_ADDRESS || DEPLOYED_46630.poolManager;
  const escrow = process.env.FLEET_ESCROW_ADDRESS || DEPLOYED_46630.escrow;
  if (!isAddress(poolManager) || !isAddress(escrow)) return undefined;
  const { publicClient } = clients(key);
  return createMarket(publicClient, { poolManager, escrow, escrowFromBlock: DEPLOYED_46630.escrowBlock });
};

/** One operator-signed client pair for 46630, shared by every chain adapter. */
const clients = (key: `0x${string}`) => {
  const rpcUrl = process.env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC;
  const chain = defineChain({
    id: FLEET_CHAIN_ID,
    name: "Robinhood Chain Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  // The public testnet RPC drops requests under a burst, and one dropped read
  // fails the whole request. Batching turns a page's reads into one HTTP call,
  // and a retry absorbs the rest.
  const transport = http(rpcUrl, { batch: true, retryCount: 5, retryDelay: 250, timeout: 20_000 });
  return {
    wallet: createWalletClient({ account: privateKeyToAccount(key), chain, transport }),
    // Vercel's TypeScript pass infers a json-rpc account on this client and
    // rejects the adapter calls our local build accepts; the cast pins the
    // account-less PublicClient viem documents for createPublicClient.
    publicClient: createPublicClient({ chain, transport }) as unknown as PublicClient,
  };
};

const chainFromEnv = (): FleetChain | undefined => {
  const key = operatorKeyFromEnv();
  if (!key) return undefined;
  const escrow = process.env.FLEET_ESCROW_ADDRESS || DEPLOYED_46630.escrow;
  const factory = process.env.FLEET_FACTORY_ADDRESS || DEPLOYED_46630.factory;
  const policy = process.env.FLEET_POLICY_ADDRESS || DEPLOYED_46630.policy;
  if (!isAddress(escrow) || !isAddress(factory) || !isAddress(policy)) return undefined;
  const { wallet, publicClient } = clients(key);
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

/**
 * Every address the service is configured with must hold code. This is the
 * check that would have caught the September outage in a minute instead of
 * five days: FLEET_POOL_ADDRESS held the operator's own address, an EOA, and
 * every pool read came back empty until someone looked. It runs once, off
 * the request path, and marks the router unhealthy with a reason that names
 * the variable; the next request then answers 503 with that reason logged.
 */
let addressFault: string | undefined;

const verifyDeployedAddresses = async (): Promise<void> => {
  const key = operatorKeyFromEnv();
  if (!key) return;
  const { publicClient } = clients(key);
  const expected: Array<[string, string | undefined]> = [
    ["FLEET_POOL_ADDRESS", process.env.FLEET_POOL_ADDRESS],
    ["FLEET_ESCROW_ADDRESS", process.env.FLEET_ESCROW_ADDRESS || DEPLOYED_46630.escrow],
    ["FLEET_FACTORY_ADDRESS", process.env.FLEET_FACTORY_ADDRESS || DEPLOYED_46630.factory],
    ["FLEET_POLICY_ADDRESS", process.env.FLEET_POLICY_ADDRESS || DEPLOYED_46630.policy],
  ];
  for (const [name, address] of expected) {
    if (!address || !isAddress(address)) continue;
    try {
      const code = await publicClient.getCode({ address });
      if (!code || code === "0x") {
        addressFault = `${name} points at ${address}, which holds no code`;
        console.error(`fleet service misconfigured: ${addressFault}`);
        return;
      }
    } catch (error) {
      // The RPC, not the configuration; the request path has its own retries.
      console.warn(`could not verify ${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
};

/** The configuration fault the boot check found, if any; for the request path and for tests. */
export const configurationFault = (): string | undefined => addressFault;

// Campaign records live for the instance's lifetime in this MVP; durable
// storage is a later, separately-evidenced step.
let router: CampaignRouter | undefined;

/** Shared Vercel handler body for the three fleet routes. */
export const handleFleetRequest = async (
  request: Request,
  allowedActions?: readonly string[],
): Promise<Response> => {
  const active = getFleetRouter();
  if (addressFault) {
    console.error(`fleet route refused: ${addressFault}`);
    return Response.json({ code: "dependency_evidence_invalid", retryable: false, reason: "misconfigured_address" }, { status: 503 });
  }
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
    // The name and the first line, never the whole error: a viem error prints
    // the request it was building, and for a withdrawal that is the payee and
    // the amount beside the operator's address, in a log.
    console.error("fleet route failed:", error instanceof Error ? `${error.name}: ${error.message.split("\n")[0]}` : String(error));
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
  const nonceSecret = nonceSecretFromEnv();
  const pool = poolFromEnv();
  const market = marketFromEnv();
  const allowedTokens = allowedTokensFromEnv();
  const maxSlippageBps = maxSlippageFromEnv();
  const store = storeFromEnv();
  if (!allowedTokens) console.warn("FLEET_TOKEN_ALLOWLIST is not set: sponsored buys may target any token");
  void verifyDeployedAddresses();
  const deps: RouterDeps = {
    // Ten minutes, not five: signing means leaving the browser for the wallet
    // app, and a trader who takes longer than the TTL comes back to an expired
    // challenge, which reads as "it asked me to start over again".
    service: new CampaignService({ origin: ORIGIN, chainId: FLEET_CHAIN_ID, maxTtlSeconds: 600 }, { store, ...(nonceSecret ? { nonceSecret } : {}) }),
    store,
    ...(feeConfig ? { feeConfig, chitBalanceOf } : {}),
    // Without the chain, fund and buy answer 503 dependency_evidence_invalid.
    ...(chain ? { chain } : {}),
    ...(allowedTokens ? { allowedTokens } : {}),
    ...(maxSlippageBps !== undefined ? { maxSlippageBps } : {}),
    // Without the pool, balance and withdrawal answer 503 the same way.
    ...(pool ? { pool } : {}),
    // Without the market, tokenQuote, order, list and holdings answer 503 too.
    ...(market ? { market } : {}),
  };
  router = new CampaignRouter(deps);
  return router;
};
