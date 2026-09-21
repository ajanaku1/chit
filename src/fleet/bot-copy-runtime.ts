/**
 * The copy desk, built the same way wherever a buy reaches it. Two
 * functions hold one: the session bot's webhook (bot-runtime.ts), where an
 * account leader's tapped buy is mirrored in the request that saw it land,
 * and the watcher's cron (bot-watch-runtime.ts), where a wallet leader's
 * venue buy is mirrored from the swap logs. They are separate functions on
 * the host, so nothing is shared between them but the store and the
 * environment; this factory is the one place that says how the desk is put
 * together, so a mirror is sized, gated, ordered and posted the same
 * whichever path brought the buy, and a variable is read the same way by
 * both.
 *
 * What the caller brings is what it already built for itself: the links,
 * the reads, the session chain (the bot's signer, which sends the mirrors),
 * Telegram, the partners' scanners and the bot's username. What is read
 * here: DATABASE_URL (or BOT_MEMORY_STORE=1) for the copy store, and
 * BOT_GROUP_CHAT_ID for the feed. `refuse` is the caller's, so a malformed
 * variable is reported in the caller's own words (a 503 from a route, a
 * refusal to start from the bot), and the daily limits are read through
 * `dailyLimitsFromEnv` with the same rule, by whoever needs them.
 */

import { neon } from "@neondatabase/serverless";
import { parseEther } from "viem";
import type { BotChain } from "./bot-chain.js";
import { CopyDesk, MemoryCopyStore, NeonCopyStore, type CopyStore } from "./bot-copy.js";
import type { HeyScanner } from "./bot-hey.js";
import type { BotLinkStore } from "./bot-link.js";
import type { OrusScanner } from "./bot-orus.js";
import type { SessionChain } from "./bot-session-chain.js";
import type { Telegram } from "./bot-telegram.js";

/** The caller's way of saying a variable is wrong; it never returns. */
export type Refuse = (why: string) => never;

export type CopyDeskParts = {
  links: BotLinkStore;
  reads: BotChain;
  session: SessionChain;
  telegram: Telegram;
  orus?: OrusScanner;
  hey?: HeyScanner;
  botUsername: string;
  /** The follower's daily allowance, as dailyLimitsFromEnv read it; absent, the desk's defaults (the session bot's). */
  dailyExecutes?: number;
  dailyGasWei?: bigint;
  /** A store from outside (a test, one machine's file store); absent, the environment's. */
  store?: CopyStore;
  refuse: Refuse;
};

const warned = new Set<string>();
const warnOnce = (what: string, message: string): void => {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(message);
};

/** The copy store: Neon when DATABASE_URL is set, one instance's memory when BOT_MEMORY_STORE=1 allows it, a refusal otherwise; the same rule as every store the bot keeps. */
export const copyStoreFromEnv = (refuse: Refuse): CopyStore => {
  const url = process.env.DATABASE_URL;
  if (url) {
    const sql = neon(url);
    return new NeonCopyStore({ query: (query, params) => sql.query(query, params) as Promise<readonly Record<string, unknown>[]> });
  }
  if (process.env.BOT_MEMORY_STORE !== "1") refuse("DATABASE_URL is not set (BOT_MEMORY_STORE=1 allows a per-instance memory store on one machine only)");
  warnOnce("copy", "BOT_MEMORY_STORE=1: leaders and follows live in this instance's memory only");
  return new MemoryCopyStore();
};

/** BOT_DAILY_EXECUTES and BOT_DAILY_GAS_ETH: per user per UTC day, how many trades and how much gas the bot fronts; unset means the defaults, malformed is refused. */
export const dailyLimitsFromEnv = (refuse: Refuse): { dailyExecutes?: number; dailyGasWei?: bigint } => {
  const executes = process.env.BOT_DAILY_EXECUTES ? Number(process.env.BOT_DAILY_EXECUTES) : undefined;
  if (executes !== undefined && !(Number.isInteger(executes) && executes > 0)) refuse("BOT_DAILY_EXECUTES must be a whole number");
  const gas = process.env.BOT_DAILY_GAS_ETH?.trim();
  if (gas && !/^\d+(\.\d{1,18})?$/.test(gas)) refuse("BOT_DAILY_GAS_ETH is not an amount in ETH");
  return { ...(executes !== undefined ? { dailyExecutes: executes } : {}), ...(gas ? { dailyGasWei: parseEther(gas) } : {}) };
};

/** BOT_GROUP_CHAT_ID: the group the feed posts to, a Telegram chat id; unset or empty means no feed, anything else that is not a number is refused. */
export const groupChatIdFromEnv = (refuse: Refuse): string | undefined => {
  const id = process.env.BOT_GROUP_CHAT_ID?.trim();
  if (id !== undefined && id !== "" && !/^-?\d+$/.test(id)) refuse("BOT_GROUP_CHAT_ID must be a Telegram chat id (a number, -100… for a supergroup)");
  return id || undefined;
};

/**
 * The desk over the caller's parts. A follower is told in their private
 * chat (its id is their Telegram id); the feed only with BOT_GROUP_CHAT_ID.
 * Without orus the desk still opens but every mirror is skipped (unknown is
 * not safe), so the operator is told once at build.
 */
export const createCopyDesk = (p: CopyDeskParts): CopyDesk => {
  if (!p.orus) warnOnce("copy-orus", "ORUS_PARTNER_API_KEY is not set: leaders and followers work, but every mirrored buy is skipped until it is");
  const groupChatId = groupChatIdFromEnv(p.refuse);
  return new CopyDesk({
    store: p.store ?? copyStoreFromEnv(p.refuse),
    links: p.links, reads: p.reads, session: p.session,
    ...(p.orus ? { orus: p.orus } : {}),
    ...(p.hey ? { hey: p.hey } : {}),
    ...(p.dailyExecutes !== undefined ? { dailyExecutes: p.dailyExecutes } : {}),
    ...(p.dailyGasWei !== undefined ? { dailyGasWei: p.dailyGasWei } : {}),
    botUsername: p.botUsername,
    tell: (followerTgId, text) => p.telegram.deliver({ kind: "send", chatId: followerTgId, text }),
    ...(groupChatId ? { feed: { chatId: groupChatId, post: (text, keyboard) => p.telegram.deliver({ kind: "send", chatId: groupChatId, text, keyboard }) } } : {}),
  });
};
