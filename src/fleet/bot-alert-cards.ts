/**
 * The 🔔 Alerts card in the mainnet bot: on or off, and the line in ETH per
 * buy under which the user is not told. The alerts themselves come from
 * the watcher's cron (bot-watch-runtime.ts, bot-alerts.ts), not from a
 * request here; this card only writes the user's subscription, so the
 * session bot routes the taps and the reply and nothing else.
 *
 * What the card says, because it is the whole promise: a buy is read from
 * the chain (the pool manager's swap log), not from us, and only in the
 * pools of $CHIT and the tokens this bot lists, never in a pool a stranger
 * opened; the message names who sent how much ETH for which token and
 * carries the hash; the orus line under it is the only word on the token,
 * and unknown is not safe; one message per token an hour at most. No link is needed: the alert
 * goes to the Telegram chat that turned it on.
 *
 * Callbacks owned here (all under Telegram's 64 bytes):
 *   alerts        the card
 *   al:on, al:off on at the current line (the default when none was set), off
 *   al:ask        the reply prompt for the line in ETH per buy
 */

import { type AlertStore, DEFAULT_USER_MIN_WEI, eth } from "./bot-alerts.js";
import type { Keyboard, Telegram } from "./bot-telegram.js";

export type AlertCardsDeps = { store: AlertStore; telegram: Telegram };

const VERBS = new Set(["alerts", "al"]);
const toWei = (s: string): bigint | null => {
  if (!/^\d+(\.\d{1,18})?$/.test(s)) return null;
  const [w = "0", f = ""] = s.split(".");
  return BigInt(w) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
};
/** A line above this is a typo, not a wish: nobody waits for a thousand ETH buy on this chain. */
export const MAX_LINE_WEI = 1_000n * 10n ** 18n;
const btn = (text: string, data: string) => ({ text, callback_data: data });

const ABOUT = "big buys of $CHIT and the tokens this bot lists, read from the chain (the pool manager's swap log), not from us: who sent how much ETH for which token, with the hash. any other pool on the chain is not watched, so nobody can open one and post through it. the orus line under each is the only word on the token; unknown is not safe. one message per token an hour at most.";

export class AlertCards {
  readonly #d: AlertCardsDeps;
  readonly #pending = new Set<string>();

  constructor(d: AlertCardsDeps) { this.#d = d; }

  /** Whether a callback verb is this card's. */
  owns(verb: string): boolean { return VERBS.has(verb); }

  /** The row the home card adds. */
  homeRow(): Keyboard[number] { return [btn("🔔 Alerts", "alerts")]; }

  #say(chatId: string, text: string, keyboard?: Keyboard, ask?: string): Promise<void> {
    return this.#d.telegram.deliver({ kind: "send", chatId, text, ...(keyboard ? { keyboard } : {}), ...(ask ? { ask } : {}) });
  }

  async callback(chatId: string, tgId: string, verb: string, arg: string | undefined): Promise<void> {
    if (verb === "alerts") return this.card(chatId, tgId);
    switch (arg) {
      case "on": return this.#set(chatId, tgId, true);
      case "off": return this.#set(chatId, tgId, false);
      case "ask": return this.#ask(chatId, tgId);
      default: return this.card(chatId, tgId);
    }
  }

  /** A reply to the line prompt. True when it was consumed. */
  async reply(chatId: string, tgId: string, text: string, isReply: boolean): Promise<boolean> {
    if (!this.#pending.has(tgId) || !isReply) return false;
    this.#pending.delete(tgId);
    await this.#line(chatId, tgId, text.trim());
    return true;
  }

  async card(chatId: string, tgId: string): Promise<void> {
    const sub = await this.#d.store.get(tgId);
    const state = sub?.on ? `<b>on</b>: buys of <code>${eth(sub.minEthWei)} ETH</code> and up, in this chat.` : `<b>off</b>. turn it on to be told here${sub ? ` (your line was <code>${eth(sub.minEthWei)} ETH</code>)` : ""}.`;
    await this.#say(chatId, ["<b>🔔 alerts</b>", ABOUT, "", `alerts are ${state}`].join("\n"), [
      [sub?.on ? btn("Turn off", "al:off") : btn("Turn on", "al:on"), btn("Set the line", "al:ask")],
      [btn("← Back", "home")],
    ]);
  }

  async #set(chatId: string, tgId: string, on: boolean): Promise<void> {
    const sub = await this.#d.store.get(tgId);
    const minEthWei = sub?.minEthWei ?? DEFAULT_USER_MIN_WEI;
    await this.#d.store.put({ tgId, minEthWei, on });
    await this.#say(chatId, on
      ? `alerts on: a buy of <code>${eth(minEthWei)} ETH</code> or more of $CHIT or a listed token is told here, one per token an hour at most, read from the chain. Set the line changes the amount.`
      : "alerts off. nothing more is sent here; Turn on brings them back at your line.",
      [[btn("🔔 Alerts", "alerts"), btn("← Back", "home")]]);
  }

  async #ask(chatId: string, tgId: string): Promise<void> {
    this.#pending.add(tgId);
    await this.#say(chatId, `min ETH per buy to alert you, like 0.5. reply with a number (up to ${eth(MAX_LINE_WEI)}); setting it turns alerts on.`, undefined, "min ETH per buy, like 0.5");
  }

  /** The typed line, refused with the format and the way back when it does not fit. */
  async #line(chatId: string, tgId: string, text: string): Promise<void> {
    const wei = toWei(text);
    if (wei === null || wei <= 0n || wei > MAX_LINE_WEI) {
      return this.#say(chatId, `the line must be a number of ETH, like 0.5, above zero and up to ${eth(MAX_LINE_WEI)}. tap Set the line again to retry.`, [[btn("Set the line", "al:ask"), btn("← Back", "alerts")]]);
    }
    await this.#d.store.put({ tgId, minEthWei: wei, on: true });
    await this.#say(chatId, `alerts on at <code>${eth(wei)} ETH</code> a buy, in this chat, read from the chain. one message per token an hour at most.`, [[btn("🔔 Alerts", "alerts"), btn("← Back", "home")]]);
  }
}
