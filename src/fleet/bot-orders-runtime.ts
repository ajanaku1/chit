/**
 * GET /api/bot/orders: the clock for the bot's standing orders. Vercel's
 * cron calls it every five minutes with `Authorization: Bearer $CRON_SECRET`
 * (the same gate as the buyback keeper); the route builds the runner from
 * the environment, runs one pass and answers { fired, landed, refused }.
 *
 * The same variables the session bot reads (bot-runtime), and its own chain:
 *   CRON_SECRET                 who may be the clock; without it the route
 *                               refuses, because a pass sends executes
 *   BOT_ORDERS_OFF              1 stops the clock: the route answers
 *                               { state: "off" } and nothing is sent, the
 *                               same switch that hides the buttons in the bot
 *   BOT_ORDERS_CHAIN_ID         4663 (default) or 46630 to rehearse; the
 *                               runner reads only the orders placed on its
 *                               chain, so a testnet bot sharing the database
 *                               never has its orders acted on against mainnet
 *   BOT_SIGNER_PRIVATE_KEY      the bot's key, the one owners granted
 *   ROBINHOOD_MAINNET_RPC_URL   reads and sends on 4663; default the public
 *   FLEET_RPC_URL,              RPC. On 46630, the testnet's, as the session
 *   ROBINHOOD_TESTNET_RPC_URL   bot reads them
 *   DATABASE_URL                the links and the orders (BOT_MEMORY_STORE=1
 *                               allows a memory store on one machine only)
 *   TELEGRAM_BOT_TOKEN          one line to the owner per attempt
 *   BOT_ORDERS_PER_RUN          at most this many executes a pass; default 20
 *   BOT_DAILY_EXECUTES,         per owner per day, the same budget a tapped
 *   BOT_DAILY_GAS_ETH           Buy has; over it their orders wait for tomorrow
 *
 * One pass at a time in this instance, and across instances the store's
 * claim (bot-orders.ts): two pingers landing together, or a run the platform
 * killed mid-send, never fire the same order twice.
 */

import { neon } from "@neondatabase/serverless";
import { isHex, parseEther, type Hex } from "viem";
import { isAddress, type Address } from "./types.js";
import { createBotChain } from "./bot-chain.js";
import { MemoryBotLinkStore, NeonBotLinkStore, type BotLinkStore } from "./bot-link.js";
import { MemoryOrderStore, NeonOrderStore, OrderRunner, type OrderStore } from "./bot-orders.js";
import { createSessionChain, type SessionChain } from "./bot-session-chain.js";
import { createTelegram, type Telegram } from "./bot-telegram.js";
import { sweepTriggerAllowed } from "./sweep-trigger.js";

/** Uniswap v4 on Robinhood Chain, as bot-runtime has them (specs/001-fleet-mission/research.md). */
const ROUTER: Address = "0x8876789976decbfcbbbe364623c63652db8c0904";
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
/** The reads want a default token (the playground's first card); the runner never shows one, so the venue token stands in. */
const VENUE_TOKEN: Address = "0x13283ab8e1f2bc4297e9ec6480c80c59674af554";
const MAINNET = 4663;
const TESTNET = 46630;

export type OrdersRuntimeOverrides = { orders?: OrderStore; links?: BotLinkStore; session?: SessionChain; telegram?: Telegram; reads?: ReturnType<typeof createBotChain> };

let runner: OrderRunner | undefined;
let overrides: OrdersRuntimeOverrides = {};
let inFlight: Promise<Response> | undefined;

class ConfigFault extends Error {}
const refuse = (why: string): never => { throw new ConfigFault(why); };

const sqlFromEnv = () => {
  const url = process.env.DATABASE_URL;
  if (url) {
    const sql = neon(url);
    return { query: (q: string, p?: unknown[]) => sql.query(q, p) as Promise<readonly Record<string, unknown>[]> };
  }
  if (process.env.BOT_MEMORY_STORE !== "1") refuse("DATABASE_URL is not set (BOT_MEMORY_STORE=1 allows a per-instance memory store on one machine only)");
  return undefined;
};

const build = (): OrderRunner => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token && !overrides.telegram) refuse("TELEGRAM_BOT_TOKEN is not set");
  const signerKey = process.env.BOT_SIGNER_PRIVATE_KEY;
  if (!overrides.session && (!signerKey || !isHex(signerKey) || signerKey.length !== 66)) refuse("BOT_SIGNER_PRIVATE_KEY must be the bot's 32-byte hex key (the one owners grant sessions to)");
  const chainId = process.env.BOT_ORDERS_CHAIN_ID ? Number(process.env.BOT_ORDERS_CHAIN_ID) : MAINNET;
  if (chainId !== MAINNET && chainId !== TESTNET) refuse("BOT_ORDERS_CHAIN_ID must be 4663 (or 46630 to rehearse)");
  const rpcUrl = chainId === MAINNET
    ? process.env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"
    : process.env.FLEET_RPC_URL || process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
  const allowlist = (process.env.FLEET_TOKEN_ALLOWLIST ?? "").split(",").map((t) => t.trim()).filter(isAddress);
  const perRun = process.env.BOT_ORDERS_PER_RUN ? Number(process.env.BOT_ORDERS_PER_RUN) : undefined;
  if (perRun !== undefined && !(Number.isInteger(perRun) && perRun > 0)) refuse("BOT_ORDERS_PER_RUN must be a whole number");
  const dailyExecutes = process.env.BOT_DAILY_EXECUTES ? Number(process.env.BOT_DAILY_EXECUTES) : undefined;
  if (dailyExecutes !== undefined && !(Number.isInteger(dailyExecutes) && dailyExecutes > 0)) refuse("BOT_DAILY_EXECUTES must be a whole number");
  const dailyGas = process.env.BOT_DAILY_GAS_ETH?.trim();
  if (dailyGas && !/^\d+(\.\d{1,18})?$/.test(dailyGas)) refuse("BOT_DAILY_GAS_ETH is not an amount in ETH");
  const sql = overrides.orders && overrides.links ? undefined : sqlFromEnv();
  return new OrderRunner({
    orders: overrides.orders ?? (sql ? new NeonOrderStore(sql) : new MemoryOrderStore()),
    links: overrides.links ?? (sql ? new NeonBotLinkStore(sql) : new MemoryBotLinkStore()),
    reads: overrides.reads ?? createBotChain({ chainId, rpcUrl, defaultToken: allowlist[0] ?? VENUE_TOKEN, router: ROUTER, poolManager: POOL_MANAGER }),
    session: overrides.session ?? createSessionChain({ chainId, rpcUrl, signerKey: signerKey as Hex }),
    telegram: overrides.telegram ?? createTelegram(token!),
    ...(perRun !== undefined ? { maxPerRun: perRun } : {}),
    ...(dailyExecutes !== undefined ? { dailyExecutes } : {}),
    ...(dailyGas ? { dailyGasWei: parseEther(dailyGas) } : {}),
  });
};

/** For tests: the runner's parts from outside, and a fresh build on the next request. */
export const setOrdersDepsForTests = (o: OrdersRuntimeOverrides): void => {
  overrides = o;
  runner = undefined;
};

const json = (body: unknown, status: number): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const handleOrdersRequest = async (request: Request, now = new Date()): Promise<Response> => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ code: "unauthorized", retryable: false, reason: "cron_secret_unset" }, 401);
  if (!sweepTriggerAllowed(request, secret)) return json({ code: "unauthorized", retryable: false, reason: "cron_secret" }, 401);
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "GET runs one pass" }, 405);
  // The switch that hides the buttons also stops the clock: while it is off, no order is acted on.
  if (process.env.BOT_ORDERS_OFF === "1") return json({ state: "off" }, 200);
  if (inFlight) return json({ state: "in_flight" }, 200);
  inFlight = (async () => {
    try {
      runner ??= build();
      const report = await runner.run(now);
      return json({ state: "ran", ...report }, 200);
    } catch (e) {
      if (e instanceof ConfigFault) return json({ state: "not_configured", reason: e.message }, 503);
      console.error(`bot orders: ${e instanceof Error ? e.message : String(e)}`);
      return json({ state: "error", reason: e instanceof Error ? e.message.split("\n")[0] : String(e) }, 502);
    }
  })();
  try { return await inFlight; }
  finally { inFlight = undefined; }
};
