/**
 * GET /api/bot/watch: the clock for the chain watcher. Vercel's cron calls
 * it every five minutes with `Authorization: Bearer $CRON_SECRET` (the same
 * gate as the orders' clock and the buyback keeper); the route builds the
 * watcher and the alerts from the environment, runs one pass over the
 * blocks since the last and answers { from, to, buys, delivered }.
 *
 * Every buy the pass finds has two readers, in this order: the alerts
 * (bot-alerts.ts, the group's line and each subscriber's own) and the copy
 * desk (bot-copy.ts, `onVenueBuy`: a buy by a wallet leader is mirrored
 * into their followers' accounts and posted to the group, anyone else's is
 * nothing to it). The desk is the same one the session bot's webhook
 * holds, built by the same factory (bot-copy-runtime.ts) over this
 * function's own chain, signer and stores, because the cron and the
 * webhook are separate functions on the host and share nothing but the
 * store and the environment. Each reader is called on its own and caught
 * on its own, so the alerts still post when a mirror breaks and the
 * mirrors still run when Telegram is down; the watcher claims each hash
 * once before the readers run, so a buy reaches both once and neither
 * twice. The alerts read what they can and post it (a partner that does
 * not answer is a line saying so); the desk keeps a buy it could not read
 * before its own claim and reads it again at the start of the next pass
 * (`retryVenueBuys`, called here before the window), for a quarter of an
 * hour, so a chain or a store that blinked is a mirror five minutes late,
 * not a mirror lost; only a buy the desk can neither read nor keep is
 * lost, logged, not a pass.
 *
 * The variables, beside the session bot's own (bot-runtime.ts):
 *   CRON_SECRET                 who may be the clock; without it the route
 *                               refuses, because a pass posts to the group
 *   BOT_WATCH_OFF               1 stops the clock: the route answers
 *                               { state: "off" }, and the same switch hides
 *                               the 🔔 Alerts button in the bot
 *   BOT_WATCH_CHAIN_ID          4663 (default) or 46630 to rehearse; the
 *                               cursor and the seen hashes are per chain
 *   BOT_WATCH_BLOCKS_PER_RUN    how far the cursor moves in one pass at
 *                               most; default 600
 *   BOT_ALERT_GROUP_MIN_ETH     a buy of this much ETH or more is posted to
 *                               the group; default 0.5
 *   BOT_GROUP_CHAT_ID           the group, the same feed the copy desk posts
 *                               to; unset means subscribers only
 *   ROBINHOOD_MAINNET_RPC_URL   reads on 4663; default the public RPC. On
 *   FLEET_RPC_URL,              46630, the testnet's, as the session bot
 *   ROBINHOOD_TESTNET_RPC_URL   reads them
 *   DATABASE_URL                the cursor, the seen hashes and the
 *                               subscriptions (BOT_MEMORY_STORE=1 allows a
 *                               memory store on one machine only)
 *   TELEGRAM_BOT_TOKEN,         the messages, and the deep link on them
 *   BOT_USERNAME
 *   ORUS_PARTNER_API_KEY,       the partners' lines under each alert, as
 *   HEY_API_KEY, BOT_HEY_OFF    the token card reads them; without orus the
 *                               line says unknown, never nothing
 *   FLEET_TOKEN_ALLOWLIST       the tokens watched beside the venue token
 *                               ($CHIT on 4663, the testnet token on
 *                               46630): their pools are named through the
 *                               registry before the first log is read, and
 *                               a swap in any other pool is not a buy
 *   BOT_POOL_KEYS               the operator's record of pools beside the
 *                               chain's own ($CHIT's), token:fee:tickSpacing
 *                               :hooks each (pool-registry.ts): the desk
 *                               mirrors a token only through a recorded
 *                               pool, so an allowlisted token whose buys
 *                               should be mirrored is recorded here
 *   BOT_SIGNER_PRIVATE_KEY      session mode's signer, the one owners
 *                               granted sessions to: the desk sends a wallet
 *                               leader's mirrors with it, so the route
 *                               refuses without it, as the orders' does.
 *                               Its address is also the watcher's own
 *                               sender: a transaction the bot itself sent
 *                               (an account leader's tapped buy the webhook's
 *                               desk posted, a mirror, an order's fill, a
 *                               user's own buy) is not announced again or as
 *                               the signer's
 *   BOT_DAILY_EXECUTES,         the followers' daily allowance, the same
 *   BOT_DAILY_GAS_ETH           ledger the webhook's taps and mirrors write
 *
 * One pass at a time in this instance; across instances the store's claims
 * (bot-watch.ts, one statement per hash and per hourly mark) keep a buy
 * from being announced twice when two passes overlap. The twenty group
 * posts are a pass's own count, so two overlapping passes may post up to
 * forty between them, each buy once.
 */

import { neon } from "@neondatabase/serverless";
import { isHex, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isAddress, type Address } from "./types.js";
import { Alerts, MemoryAlertStore, NeonAlertStore, type AlertStore } from "./bot-alerts.js";
import { CHIT_MAINNET } from "./bot-bridge.js";
import { createBotChain, type BotChain } from "./bot-chain.js";
import type { CopyStore } from "./bot-copy.js";
import { createCopyDesk, dailyLimitsFromEnv, groupChatIdFromEnv } from "./bot-copy-runtime.js";
import { createHeyScanner } from "./bot-hey.js";
import { MemoryBotLinkStore, NeonBotLinkStore, type BotLinkStore } from "./bot-link.js";
import { createOrusScanner, type OrusScanner } from "./bot-orus.js";
import { createSessionChain, type SessionChain } from "./bot-session-chain.js";
import { createTelegram, type Telegram } from "./bot-telegram.js";
import { createWatchPort, MemoryWatchStore, NeonWatchStore, Watcher, type VenueBuy, type WatchPort, type WatchStore } from "./bot-watch.js";
import { recordedPoolsFromEnv } from "./pool-registry.js";
import { sweepTriggerAllowed } from "./sweep-trigger.js";

/** Uniswap v4 on Robinhood Chain, as bot-runtime has them (specs/001-fleet-mission/research.md). */
const ROUTER: Address = "0x8876789976decbfcbbbe364623c63652db8c0904";
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
/** The testnet venue token, as bot-runtime.ts has it; on mainnet the venue token is $CHIT (bot-bridge.ts, deployments/buyback-4663.json). */
const TESTNET_VENUE_TOKEN: Address = "0x13283ab8e1f2bc4297e9ec6480c80c59674af554";
const MAINNET = 4663;
const TESTNET = 46630;

/** The tokens the watcher is for: the chain's venue token first, then the allowlist, each once. A swap in any other pool is not a buy. */
export const watchTokens = (chainId: number, allowlist: Address[]): Address[] => {
  const out: Address[] = [];
  for (const t of [chainId === MAINNET ? CHIT_MAINNET : TESTNET_VENUE_TOKEN, ...allowlist]) {
    if (!out.some((have) => have.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
};

/** The bot's own sender, from the session signer's key when it is set: the address alone, the key is never held here. */
export const ownSendersFromEnv = (): Address[] => {
  const key = process.env.BOT_SIGNER_PRIVATE_KEY;
  if (!key || !isHex(key) || key.length !== 66) return [];
  return [privateKeyToAccount(key as Hex).address];
};

/** One reader of a buy, named for the log line when it throws. */
export type Reader = { name: string; read(b: VenueBuy): Promise<unknown> };

/**
 * The composed handler: each reader in turn, each caught on its own, so
 * one reader's failure is one log line and the next reader still runs; the
 * buy is handed to every reader exactly once, since the watcher claims the
 * hash before calling this.
 */
export const readInTurn = (readers: Reader[]) => async (b: VenueBuy): Promise<void> => {
  for (const r of readers) {
    await r.read(b).catch((e: unknown) => console.error(`bot watch: ${r.name} for ${b.txHash}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`));
  }
};

/** For tests: the parts a pass would otherwise build from the environment and the chain; orus from outside stands in for the partner (the readers gate on its answer). */
export type WatchRuntimeOverrides = { port?: WatchPort; store?: WatchStore; alertStore?: AlertStore; copyStore?: CopyStore; links?: BotLinkStore; session?: SessionChain; telegram?: Telegram; reads?: BotChain; orus?: OrusScanner };

let watcher: { run(): Promise<{ from: bigint; to: bigint; buys: number; delivered: number }>; alerts: Alerts } | undefined;
let overrides: WatchRuntimeOverrides = {};
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

const build = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token && !overrides.telegram) refuse("TELEGRAM_BOT_TOKEN is not set");
  const username = process.env.BOT_USERNAME;
  if (!username) refuse("BOT_USERNAME is not set");
  const chainId = process.env.BOT_WATCH_CHAIN_ID ? Number(process.env.BOT_WATCH_CHAIN_ID) : MAINNET;
  if (chainId !== MAINNET && chainId !== TESTNET) refuse("BOT_WATCH_CHAIN_ID must be 4663 (or 46630 to rehearse)");
  const rpcUrl = chainId === MAINNET
    ? process.env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"
    : process.env.FLEET_RPC_URL || process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
  const allowlist = (process.env.FLEET_TOKEN_ALLOWLIST ?? "").split(",").map((t) => t.trim()).filter(isAddress);
  const perRun = process.env.BOT_WATCH_BLOCKS_PER_RUN ? Number(process.env.BOT_WATCH_BLOCKS_PER_RUN) : undefined;
  if (perRun !== undefined && !(Number.isInteger(perRun) && perRun > 0)) refuse("BOT_WATCH_BLOCKS_PER_RUN must be a whole number");
  const groupMin = process.env.BOT_ALERT_GROUP_MIN_ETH?.trim();
  if (groupMin && !/^\d+(\.\d{1,18})?$/.test(groupMin)) refuse("BOT_ALERT_GROUP_MIN_ETH is not an amount in ETH");
  const groupChatId = groupChatIdFromEnv(refuse);
  const signerKey = process.env.BOT_SIGNER_PRIVATE_KEY;
  if (!overrides.session && (!signerKey || !isHex(signerKey) || signerKey.length !== 66)) refuse("BOT_SIGNER_PRIVATE_KEY must be the bot's 32-byte hex key (the one owners grant sessions to)");
  const daily = dailyLimitsFromEnv(refuse);
  const sql = overrides.store && overrides.alertStore && overrides.copyStore && overrides.links ? undefined : sqlFromEnv();
  const tokens = watchTokens(chainId, allowlist);
  // The operator's recorded pools go to both the reads (the desk's routes and quotes) and the port (which pool of a watched token is watched).
  const recordedPools = recordedPoolsFromEnv(refuse);
  const reads = overrides.reads ?? createBotChain({ chainId, rpcUrl, defaultToken: tokens[0]!, router: ROUTER, poolManager: POOL_MANAGER, recordedPools });
  const telegram = overrides.telegram ?? createTelegram(token!);
  const orus = overrides.orus ?? (process.env.ORUS_PARTNER_API_KEY ? createOrusScanner({ apiKey: process.env.ORUS_PARTNER_API_KEY, chainId, ...(process.env.ORUS_API_BASE ? { baseUrl: process.env.ORUS_API_BASE } : {}) }) : undefined);
  const hey = process.env.BOT_HEY_OFF === "1" ? undefined : createHeyScanner({ chainId, ...(process.env.HEY_API_KEY ? { apiKey: process.env.HEY_API_KEY } : {}), ...(process.env.HEY_API_BASE ? { baseUrl: process.env.HEY_API_BASE } : {}) });
  const alerts = new Alerts({
    store: overrides.alertStore ?? (sql ? new NeonAlertStore(sql) : new MemoryAlertStore()),
    reads,
    ...(orus ? { orus } : {}),
    ...(hey ? { hey } : {}),
    botUsername: username!,
    tell: (tgId, text, keyboard) => telegram.deliver({ kind: "send", chatId: tgId, text, ...(keyboard ? { keyboard } : {}) }),
    ...(groupChatId ? { feed: { chatId: groupChatId, post: (text, keyboard) => telegram.deliver({ kind: "send", chatId: groupChatId, text, keyboard }) } } : {}),
    ...(groupMin ? { groupMinWei: parseEther(groupMin) } : {}),
  });
  // The copy desk over this function's own parts, the way the webhook builds its own (bot-copy-runtime.ts): a wallet leader's buy is mirrored from here.
  const copy = createCopyDesk({
    links: overrides.links ?? (sql ? new NeonBotLinkStore(sql) : new MemoryBotLinkStore()),
    reads,
    session: overrides.session ?? createSessionChain({ chainId, rpcUrl, signerKey: signerKey as Hex }),
    telegram,
    ...(orus ? { orus } : {}),
    ...(hey ? { hey } : {}),
    ...daily,
    ...(overrides.copyStore ? { store: overrides.copyStore } : {}),
    botUsername: username!,
    refuse,
  });
  const inner = new Watcher({
    port: overrides.port ?? createWatchPort({ chainId, rpcUrl, poolManager: POOL_MANAGER, tokens, ownSenders: ownSendersFromEnv(), recordedPools }),
    store: overrides.store ?? (sql ? new NeonWatchStore(sql) : new MemoryWatchStore()),
    chainId,
    ...(perRun !== undefined ? { maxBlocksPerRun: perRun } : {}),
    // The alerts first, then the desk; each caught on its own, so one failure is one failure.
    onBuy: readInTurn([
      { name: "alerts", read: (b) => alerts.onBuy(b) },
      { name: "copy desk", read: (b) => copy.onVenueBuy(b) },
    ]),
  });
  return {
    alerts,
    async run() {
      alerts.beginRun();
      // The desk's kept buys first, oldest first, so a buy a read failed on last pass is mirrored before this pass's are; the desk's store being down is a line, not a pass lost.
      await copy.retryVenueBuys().catch((e: unknown) => console.error(`bot watch: kept venue buys not read: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`));
      return inner.run();
    },
  };
};

/** For tests: the watcher's parts from outside, and a fresh build on the next request. */
export const setWatchDepsForTests = (o: WatchRuntimeOverrides): void => {
  overrides = o;
  watcher = undefined;
};

const json = (body: unknown, status: number): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const handleWatchRequest = async (request: Request): Promise<Response> => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ code: "unauthorized", retryable: false, reason: "cron_secret_unset" }, 401);
  if (!sweepTriggerAllowed(request, secret)) return json({ code: "unauthorized", retryable: false, reason: "cron_secret" }, 401);
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "GET runs one pass" }, 405);
  // The switch that hides the button also stops the clock: while it is off, nothing is read and nothing is posted.
  if (process.env.BOT_WATCH_OFF === "1") return json({ state: "off" }, 200);
  if (inFlight) return json({ state: "in_flight" }, 200);
  inFlight = (async () => {
    try {
      watcher ??= build();
      const r = await watcher.run();
      return json({ state: "ran", from: r.from.toString(), to: r.to.toString(), buys: r.buys, delivered: r.delivered }, 200);
    } catch (e) {
      if (e instanceof ConfigFault) return json({ state: "not_configured", reason: e.message }, 503);
      console.error(`bot watch: ${e instanceof Error ? e.message : String(e)}`);
      return json({ state: "error", reason: e instanceof Error ? e.message.split("\n")[0] : String(e) }, 502);
    }
  })();
  try { return await inFlight; }
  finally { inFlight = undefined; }
};
