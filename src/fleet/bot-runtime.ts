/**
 * Chit Bot: the hosted wiring. POST /api/bot is Telegram's webhook.
 *
 * Reads, never invents:
 *   TELEGRAM_BOT_TOKEN           the bot (BotFather)
 *   TELEGRAM_WEBHOOK_SECRET      any long string; also given to setWebhook, and
 *                                checked on every update
 *   BOT_USERNAME                 the bot's @username without the @, for the
 *                                "open the bot" link in groups
 *   BOT_KEY_SECRET               seals the playground keys at rest (32+ chars)
 *   BOT_FAUCET_PRIVATE_KEY       a throwaway key with test ETH that tops new
 *                                wallets up; never the operator's
 *   BOT_FAUCET_ETH               what /start hands out; default 0.02
 *   DATABASE_URL                 Neon; the wallets live there. Without it a
 *                                memory store, per instance, which on a fleet
 *                                of functions means a user meets a different
 *                                wallet on each; fine on one machine only.
 *   FLEET_CHAIN_ID, FLEET_RPC_URL, FLEET_POOL_ADDRESS, FLEET_TOKEN_ALLOWLIST
 *                                as for the service; the first allowlisted
 *                                token is the one the bot trades
 */

import { neon } from "@neondatabase/serverless";
import { isHex } from "viem";

import { isAddress, type Address } from "./types.js";
import { createBotChain } from "./bot-chain.js";
import { createFetchFleetApi } from "./bot-fleet.js";
import { ChitBot } from "./bot-handlers.js";
import { createTelegram } from "./bot-telegram.js";
import { MemoryBotWalletStore, NeonBotWalletStore, type BotWalletStore } from "./bot-wallets.js";

const CHAIN_ID = Number(process.env.FLEET_CHAIN_ID || 46630);
const DEFAULT_RPC = CHAIN_ID === 4663 ? "https://rpc.mainnet.chain.robinhood.com" : "https://rpc.testnet.chain.robinhood.com";
/** Uniswap v4 on Robinhood Chain, same addresses on both chains (specs/001-fleet-mission/research.md). */
const ROUTER: Address = "0x8876789976decbfcbbbe364623c63652db8c0904";
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
/** The testnet venue token, as recorded; FLEET_TOKEN_ALLOWLIST's first entry wins. */
const TESTNET_VENUE_TOKEN: Address = "0x13283ab8e1f2bc4297e9ec6480c80c59674af554";

const warned = new Set<string>();
const warnOnce = (what: string, message: string): void => {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(message);
};

const storeFromEnv = (): BotWalletStore => {
  const url = process.env.DATABASE_URL;
  if (url) {
    const sql = neon(url);
    return new NeonBotWalletStore({ query: (query, params) => sql.query(query, params) as Promise<readonly Record<string, unknown>[]> });
  }
  warnOnce("store", "DATABASE_URL is not set: the bot's wallets live in this instance's memory only");
  return new MemoryBotWalletStore();
};

let bot: ChitBot | undefined;
let fault: string | undefined;

export const getBot = (): ChitBot | undefined => {
  if (bot || fault) return bot;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const keySecret = process.env.BOT_KEY_SECRET;
  const username = process.env.BOT_USERNAME;
  if (!token) { fault = "TELEGRAM_BOT_TOKEN is not set"; return undefined; }
  if (!keySecret || keySecret.length < 32) { fault = "BOT_KEY_SECRET must be 32+ characters"; return undefined; }
  if (!username) { fault = "BOT_USERNAME is not set"; return undefined; }
  if (CHAIN_ID !== 46630) { fault = "the playground bot runs on testnet only; on mainnet the bot holds no keys"; return undefined; }
  const faucetKey = process.env.BOT_FAUCET_PRIVATE_KEY;
  if (faucetKey && (!isHex(faucetKey) || faucetKey.length !== 66)) { fault = "BOT_FAUCET_PRIVATE_KEY is not a 32-byte hex key"; return undefined; }
  const allowlist = (process.env.FLEET_TOKEN_ALLOWLIST ?? "").split(",").map((t) => t.trim()).filter(isAddress);
  const token0 = allowlist[0] ?? TESTNET_VENUE_TOKEN;
  const pool = process.env.FLEET_POOL_ADDRESS;
  const faucetEth = process.env.BOT_FAUCET_ETH;

  const chain = createBotChain({
    chainId: CHAIN_ID,
    rpcUrl: process.env.FLEET_RPC_URL || process.env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC,
    defaultToken: token0,
    router: ROUTER,
    poolManager: POOL_MANAGER,
    ...(isAddress(pool) ? { pool } : {}),
    ...(faucetKey ? { faucetKey: faucetKey as `0x${string}` } : {}),
  });
  if (!faucetKey) warnOnce("faucet", "BOT_FAUCET_PRIVATE_KEY is not set: new wallets get no test ETH");
  const site = process.env.FLEET_ORIGIN || "https://chit.tools";
  bot = new ChitBot({
    store: storeFromEnv(),
    chain,
    telegram: createTelegram(token),
    // The fleet from the chat drives the hosted service on the same host; BOT_FLEET_OFF=1 hides the buttons until it is wired.
    ...(process.env.BOT_FLEET_OFF === "1" ? {} : { fleetApi: createFetchFleetApi(site) }),
    keySecret,
    botUsername: username,
    ...(faucetEth ? { faucetWei: BigInt(Math.round(Number(faucetEth) * 1e18)) } : {}),
    siteUrl: site,
  });
  return bot;
};

export const handleBotRequest = async (request: Request): Promise<Response> => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new Response("forbidden", { status: 403 });
  }
  const active = getBot();
  if (!active) {
    console.error(`chit bot refused: ${fault}`);
    // 200 on purpose: Telegram retries anything else forever.
    return Response.json({ ok: false, why: "bot_not_configured" }, { status: 200 });
  }
  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return Response.json({ ok: false }, { status: 200 });
  }
  await active.handle(update as never);
  return Response.json({ ok: true }, { status: 200 });
};
