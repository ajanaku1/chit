/**
 * Chit Bot: the hosted wiring. POST /api/bot is Telegram's webhook.
 *
 * Reads, never invents; refuses to serve rather than run half-configured:
 *   TELEGRAM_BOT_TOKEN           the bot (BotFather)
 *   TELEGRAM_WEBHOOK_SECRET      16+ characters; also given to setWebhook, and
 *                                required on every update (a request without
 *                                it is 403, and without the variable the bot
 *                                refuses to start: an open webhook would let
 *                                anyone drive any wallet by Telegram id)
 *   BOT_USERNAME                 the bot's @username without the @, for the
 *                                "open the bot" link in groups
 *   BOT_KEY_SECRET               seals the playground keys at rest: 32+ chars
 *                                with twelve distinct ones; never rotated
 *                                once wallets exist (the store's canary
 *                                catches a rotation and the bot stops)
 *   BOT_FAUCET_PRIVATE_KEY       a throwaway key with test ETH that tops new
 *                                wallets up; never the operator's
 *   BOT_FAUCET_ETH               what /start hands out; default 0.02
 *   BOT_FAUCET_DAILY_ETH         the faucet's budget per UTC day, across
 *                                everyone; default 0.5
 *   DATABASE_URL                 Neon; the wallets, locks and update ids live
 *                                there, shared by every function instance.
 *                                Required, because a memory store per
 *                                instance would hand a user a different
 *                                wallet on each; BOT_MEMORY_STORE=1 allows
 *                                it for one machine only.
 *   BOT_BRIDGE_OFF               1 hides the Bridge card (Relay routes into
 *                                Robinhood Chain and straight into CHIT)
 *   BOT_SHARE_OFF                1 hides the 📸 button (a position drawn as
 *                                a picture with the referral link on it)
 *   BOT_ASSET_DIR                where the share card's plate and fonts are
 *                                (default landing/public/bot, shipped with
 *                                the function)
 *   BOT_BANNER_BASE              where the cards' banners are: a URL
 *                                (default <FLEET_ORIGIN>/bot, the site
 *                                serves landing/public/bot) or a local folder
 *                                for one machine; home.png, buy.png,
 *                                refer.png, fleet.png. Empty string: no banners
 *   FLEET_CHAIN_ID, FLEET_RPC_URL, FLEET_POOL_ADDRESS, FLEET_TOKEN_ALLOWLIST
 *                                as for the service; the first allowlisted
 *                                token is the one the bot trades
 */

import { timingSafeEqual } from "node:crypto";

import { neon } from "@neondatabase/serverless";
import { isHex, parseEther } from "viem";

import { isAddress, type Address } from "./types.js";
import { createRelayBridge } from "./bot-bridge.js";
import { createShareRenderer } from "./bot-share.js";
import { createBotChain } from "./bot-chain.js";
import { createFetchFleetApi } from "./bot-fleet.js";
import { ChitBot } from "./bot-handlers.js";
import { createTelegram } from "./bot-telegram.js";
import { MemoryBotWalletStore, NeonBotWalletStore, secretIsStrong, type BotWalletStore } from "./bot-wallets.js";

const chainIdFromEnv = (): number => Number(process.env.FLEET_CHAIN_ID || 46630);
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

class ConfigFault extends Error {}
const refuse = (why: string): never => { throw new ConfigFault(why); };

const storeFromEnv = (): BotWalletStore => {
  const url = process.env.DATABASE_URL;
  if (url) {
    const sql = neon(url);
    return new NeonBotWalletStore({ query: (query, params) => sql.query(query, params) as Promise<readonly Record<string, unknown>[]> });
  }
  if (process.env.BOT_MEMORY_STORE !== "1") refuse("DATABASE_URL is not set (BOT_MEMORY_STORE=1 allows a per-instance memory store on one machine only)");
  warnOnce("store", "BOT_MEMORY_STORE=1: the bot's wallets live in this instance's memory only");
  return new MemoryBotWalletStore();
};

/** An amount in ETH from the environment, refused rather than guessed when malformed. */
const ethFromEnv = (name: string): bigint | undefined => {
  const raw = process.env[name];
  if (!raw) return undefined;
  if (!/^\d+(\.\d{1,18})?$/.test(raw.trim())) refuse(`${name} is not an amount in ETH`);
  return parseEther(raw.trim());
};

let bot: ChitBot | undefined;
let fault: string | undefined;

const build = (): ChitBot => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const keySecret = process.env.BOT_KEY_SECRET;
  const username = process.env.BOT_USERNAME;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token) refuse("TELEGRAM_BOT_TOKEN is not set");
  if (!webhookSecret || webhookSecret.length < 16) refuse("TELEGRAM_WEBHOOK_SECRET must be 16+ characters: without it anyone could post updates as any user");
  if (!keySecret || !secretIsStrong(keySecret)) refuse("BOT_KEY_SECRET must be 32+ characters with at least twelve distinct ones");
  if (!username) refuse("BOT_USERNAME is not set");
  const chainId = chainIdFromEnv();
  if (chainId !== 46630) refuse("the playground bot runs on testnet only; on mainnet the bot holds no keys");
  const faucetKey = process.env.BOT_FAUCET_PRIVATE_KEY;
  if (faucetKey && (!isHex(faucetKey) || faucetKey.length !== 66)) refuse("BOT_FAUCET_PRIVATE_KEY is not a 32-byte hex key");
  const allowlist = (process.env.FLEET_TOKEN_ALLOWLIST ?? "").split(",").map((t) => t.trim()).filter(isAddress);
  const token0 = allowlist[0] ?? TESTNET_VENUE_TOKEN;
  const pool = process.env.FLEET_POOL_ADDRESS;
  const faucetWei = ethFromEnv("BOT_FAUCET_ETH");
  const faucetDailyWei = ethFromEnv("BOT_FAUCET_DAILY_ETH");

  const chain = createBotChain({
    chainId,
    rpcUrl: process.env.FLEET_RPC_URL || process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com",
    defaultToken: token0,
    router: ROUTER,
    poolManager: POOL_MANAGER,
    ...(isAddress(pool) ? { pool } : {}),
    ...(faucetKey ? { faucetKey: faucetKey as `0x${string}` } : {}),
  });
  if (!faucetKey) warnOnce("faucet", "BOT_FAUCET_PRIVATE_KEY is not set: new wallets get no test ETH");
  const site = process.env.FLEET_ORIGIN || "https://chit.tools";
  const bannerBase = process.env.BOT_BANNER_BASE ?? `${site.replace(/\/+$/, "")}/bot`;
  const banners = bannerBase
    ? Object.fromEntries((["home", "buy", "refer", "fleet"] as const).map((k) => [k, `${bannerBase.replace(/[\\/]+$/, "")}/${k}.png`]))
    : undefined;
  return new ChitBot({
    store: storeFromEnv(),
    chain,
    telegram: createTelegram(token!),
    // The fleet from the chat drives the hosted service on the same host; BOT_FLEET_OFF=1 hides the buttons until it is wired.
    ...(process.env.BOT_FLEET_OFF === "1" ? {} : { fleetApi: createFetchFleetApi(site) }),
    // The Bridge card asks Relay for live routes; BOT_BRIDGE_OFF=1 hides it.
    ...(process.env.BOT_BRIDGE_OFF === "1" ? {} : { bridge: createRelayBridge() }),
    // Share cards are drawn from landing/public/bot (the plate and the fonts); BOT_SHARE_OFF=1 hides the 📸 button.
    ...(process.env.BOT_SHARE_OFF === "1" ? {} : { share: createShareRenderer(process.env.BOT_ASSET_DIR || undefined) }),
    keySecret: keySecret!,
    botUsername: username!,
    ...(faucetWei !== undefined ? { faucetWei } : {}),
    ...(faucetDailyWei !== undefined ? { faucetDailyWei } : {}),
    ...(banners ? { banners } : {}),
    siteUrl: site,
  });
};

export const getBot = (): ChitBot | undefined => {
  if (bot || fault) return bot;
  try {
    bot = build();
  } catch (error) {
    // A malformed variable is a refusal like a missing one, never a 500 Telegram retries forever.
    fault = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return undefined;
  }
  return bot;
};

/** For tests: forget the built bot and its fault, so the next request reads the environment again; and read why it refused. */
export const resetBotForTests = (): void => {
  bot = undefined;
  fault = undefined;
};
export const botFaultForTests = (): string | undefined => fault;

/** Constant-time on equal lengths; a missing or differently sized header is a plain no. */
const secretMatches = (header: string | null, secret: string | undefined): boolean => {
  if (!header || !secret) return false;
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

export const handleBotRequest = async (request: Request): Promise<Response> => {
  // Every update must carry the secret Telegram was given; no variable, no service (getBot refuses too).
  if (!secretMatches(request.headers.get("x-telegram-bot-api-secret-token"), process.env.TELEGRAM_WEBHOOK_SECRET)) {
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
