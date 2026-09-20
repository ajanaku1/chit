/**
 * Big-wallet alerts: when the watcher (bot-watch.ts) hands in a buy the
 * chain wrote, one message to the group for a buy over the group's line
 * and one private message to each user whose own line it clears. The
 * message says what the chain says and nothing more: who paid how much ETH
 * for which token, the hash, and the partners' lines as the token card
 * shows them. Orus's line is the only word on the token; when orus has no
 * read, or is not wired into this bot, the line says unknown, because a
 * missing read printed as nothing would read as clean. HEY the same.
 *
 * The bounds, because a group fed from a public chain can be flooded by
 * anyone with ETH to spend: at most twenty group posts a run (the rest of
 * the window's buys are still handed to the other handlers, only the group
 * is spared), and one private message per user per token an hour, kept in
 * the store so every instance keeps the same count. A user's line is
 * theirs: on or off, and the ETH per buy under which nothing is sent
 * (bot-alert-cards.ts is the card). The group's line is the operator's,
 * BOT_ALERT_GROUP_MIN_ETH, half an ETH by default.
 *
 * Nothing in here sends a transaction or reads a key; a failure is logged
 * and the run goes on to the next buy.
 */

import type { Address } from "viem";
import type { BotChain } from "./bot-chain.js";
import { heyLine, type HeyScanner } from "./bot-hey.js";
import { orusLine, type OrusScanner } from "./bot-orus.js";
import { esc, type Keyboard } from "./bot-telegram.js";
import type { VenueBuy } from "./bot-watch.js";

export type AlertSub = { tgId: string; minEthWei: bigint; on: boolean };

export interface AlertStore {
  get(tgId: string): Promise<AlertSub | undefined>;
  put(sub: AlertSub): Promise<void>;
  /** Every subscription that is on. */
  active(): Promise<AlertSub[]>;
  /** When this user was last told about this token, for the hourly bound. */
  lastTold(tgId: string, token: Address): Promise<Date | undefined>;
  markTold(tgId: string, token: Address, at: Date): Promise<void>;
}

export type AlertsDeps = {
  store: AlertStore;
  /** Token reads: the symbol, as the token card reads it. */
  reads: Pick<BotChain, "tokenInfo">;
  orus?: OrusScanner;
  hey?: HeyScanner;
  /** One private message to a subscriber. */
  tell: (tgId: string, text: string, keyboard?: Keyboard) => Promise<void>;
  /** The group the copy desk posts to; absent means no group posts, subscribers are still told. */
  feed?: { chatId: string; post(text: string, keyboard: Keyboard): Promise<void> };
  /** The bot's @username without the @, for the deep link into the token card. */
  botUsername: string;
  /** ETH in one buy at or over which the group is told; default 0.5. */
  groupMinWei?: bigint;
  /** Group posts in one run at most; default 20. */
  maxGroupPerRun?: number;
  /** How long after one private alert on a token the same user is not told about it again; default an hour. */
  dmEveryMs?: number;
  now?: () => Date;
};

export const DEFAULT_GROUP_MIN_WEI = 5n * 10n ** 17n;
export const DEFAULT_MAX_GROUP_PER_RUN = 20;
export const DEFAULT_DM_EVERY_MS = 3_600_000;
/** What a fresh subscription is set to: the group's default line. */
export const DEFAULT_USER_MIN_WEI = DEFAULT_GROUP_MIN_WEI;

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const eth = (wei: bigint, places = 4): string => {
  const w = wei / 10n ** 18n, f = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, places).replace(/0+$/, "");
  return `${w}${f ? "." + f : ""}`;
};

export class Alerts {
  readonly #d: AlertsDeps;
  #groupPosts = 0;
  /** The subscriptions as read once this run; a window of many buys is one read, not one per buy. */
  #subs: AlertSub[] | undefined;

  constructor(d: AlertsDeps) { this.#d = d; }

  get #now(): Date { return this.#d.now ? this.#d.now() : new Date(); }

  /** A new run of the watcher: the group's count starts over and the subscriptions are read again. */
  beginRun(): void { this.#groupPosts = 0; this.#subs = undefined; }

  async #active(): Promise<AlertSub[]> { return (this.#subs ??= await this.#d.store.active()); }

  /** The buy as the group and the subscribers read it: the chain's facts, the hash, the partners' lines or unknown. */
  async describe(b: VenueBuy): Promise<{ text: string; symbol: string }> {
    const [info, scan, hey] = await Promise.all([
      this.#d.reads.tokenInfo(b.token).catch(() => undefined),
      this.#d.orus?.scan(b.token).catch(() => undefined),
      this.#d.hey?.scan(b.token).catch(() => undefined),
    ]);
    // The cashtag when the token names itself; a token without a symbol is shown by its address, never by a guessed name.
    const symbol = info?.symbol && info.symbol !== "?" ? info.symbol : "";
    const what = symbol ? `<b>$${esc(symbol)}</b>` : `<b>${short(b.token)}</b>`;
    const lines = [
      `<code>${short(b.buyer)}</code> bought <code>${eth(b.ethInWei)} ETH</code> of ${what} · <a href="https://robinhoodchain.blockscout.com/tx/${b.txHash}">${b.txHash.slice(0, 10)}…</a>`,
      `orus: ${scan && this.#d.orus ? orusLine(scan, this.#d.orus.link(b.token)) : "unknown, no read on this token right now. unknown is not safe."}`,
      `hey research lab: ${hey ? heyLine(hey) : "unknown, no page for this token."}`,
      `<i>read from the chain (the pool manager's swap log), not from us. the address is <code>${b.token}</code>.</i>`,
    ];
    return { text: lines.join("\n"), symbol: symbol || short(b.token) };
  }

  #door(token: Address): Keyboard {
    return [[{ text: "buy this", url: `https://t.me/${this.#d.botUsername}?start=t-${token}` }]];
  }

  /**
   * One buy in: the group when it clears the group's line and the run has
   * posts left, then each subscriber whose own line it clears and who was
   * not told about this token in the last hour. The reads happen once, and
   * only when someone is to be told.
   */
  async onBuy(b: VenueBuy): Promise<{ group: boolean; told: string[] }> {
    const groupMin = this.#d.groupMinWei ?? DEFAULT_GROUP_MIN_WEI;
    const toGroup = Boolean(this.#d.feed) && b.ethInWei >= groupMin && this.#groupPosts < (this.#d.maxGroupPerRun ?? DEFAULT_MAX_GROUP_PER_RUN);
    const subs = (await this.#active()).filter((s) => s.on && b.ethInWei >= s.minEthWei);
    if (!toGroup && !subs.length) return { group: false, told: [] };
    const { text } = await this.describe(b);
    let group = false;
    if (toGroup) {
      this.#groupPosts += 1;
      try {
        await this.#d.feed!.post(text, this.#door(b.token));
        group = true;
      } catch (error) {
        console.error(`bot alerts: group post for ${b.txHash} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
    }
    const told: string[] = [];
    const every = this.#d.dmEveryMs ?? DEFAULT_DM_EVERY_MS;
    for (const s of subs) {
      const last = await this.#d.store.lastTold(s.tgId, b.token);
      if (last && this.#now.getTime() - last.getTime() < every) continue;
      // Marked before the send: a run cut off between the two loses one alert instead of sending it twice.
      await this.#d.store.markTold(s.tgId, b.token, this.#now);
      try {
        await this.#d.tell(s.tgId, `${text}\n<i>your line is ${eth(s.minEthWei)} ETH a buy; 🔔 Alerts on your card changes it or turns this off. one message per token an hour at most.</i>`, this.#door(b.token));
        told.push(s.tgId);
      } catch (error) {
        console.error(`bot alerts: dm to ${s.tgId} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
    }
    return { group, told };
  }
}

// ---------- the stores ----------

/** One instance's memory: tests and one machine. */
export class MemoryAlertStore implements AlertStore {
  readonly subs = new Map<string, AlertSub>();
  readonly told = new Map<string, string>();
  async get(tgId: string) { const s = this.subs.get(tgId); return s ? { ...s } : undefined; }
  async put(sub: AlertSub) { this.subs.set(sub.tgId, { ...sub }); }
  async active() { return [...this.subs.values()].filter((s) => s.on).map((s) => ({ ...s })); }
  async lastTold(tgId: string, token: Address) { const at = this.told.get(`${tgId}|${token.toLowerCase()}`); return at ? new Date(at) : undefined; }
  async markTold(tgId: string, token: Address, at: Date) { this.told.set(`${tgId}|${token.toLowerCase()}`, at.toISOString()); }
}

type Row = Record<string, unknown>;
export type AlertSql = { query(sql: string, params?: unknown[]): Promise<readonly Row[]> };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bot_alert_subs (tg_id TEXT PRIMARY KEY, min_eth_wei NUMERIC(40,0) NOT NULL, "on" BOOLEAN NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS bot_alert_told (tg_id TEXT NOT NULL, token TEXT NOT NULL, at TIMESTAMPTZ NOT NULL, PRIMARY KEY (tg_id, token))`,
];
const rowSub = (r: Row): AlertSub => ({ tgId: String(r.tg_id), minEthWei: BigInt(String(r.min_eth_wei)), on: Boolean(r.on) });

export class NeonAlertStore implements AlertStore {
  #ready: Promise<void> | undefined;
  #writes = 0;
  constructor(private readonly sql: AlertSql) {}
  #init(): Promise<void> { return (this.#ready ??= (async () => { for (const s of SCHEMA) await this.sql.query(s); })().catch((e) => { this.#ready = undefined; throw e; })); }
  async get(tgId: string) { await this.#init(); const [r] = await this.sql.query(`SELECT * FROM bot_alert_subs WHERE tg_id = $1`, [tgId]); return r ? rowSub(r) : undefined; }
  async put(sub: AlertSub) {
    await this.#init();
    await this.sql.query(`INSERT INTO bot_alert_subs (tg_id, min_eth_wei, "on", updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (tg_id) DO UPDATE SET min_eth_wei = EXCLUDED.min_eth_wei, "on" = EXCLUDED."on", updated_at = NOW()`, [sub.tgId, sub.minEthWei.toString(), sub.on]);
  }
  async active() { await this.#init(); return (await this.sql.query(`SELECT * FROM bot_alert_subs WHERE "on" ORDER BY tg_id`)).map(rowSub); }
  async lastTold(tgId: string, token: Address) {
    await this.#init();
    const [r] = await this.sql.query(`SELECT at FROM bot_alert_told WHERE tg_id = $1 AND token = $2`, [tgId, token.toLowerCase()]);
    return r ? new Date(String(r.at)) : undefined;
  }
  async markTold(tgId: string, token: Address, at: Date) {
    await this.#init();
    await this.sql.query(`INSERT INTO bot_alert_told (tg_id, token, at) VALUES ($1, $2, $3) ON CONFLICT (tg_id, token) DO UPDATE SET at = EXCLUDED.at`, [tgId, token.toLowerCase(), at.toISOString()]);
    // The hourly bound needs nothing older than a day; the rest goes in passing.
    if (++this.#writes % 100 === 0) await this.sql.query(`DELETE FROM bot_alert_told WHERE at < NOW() - INTERVAL '1 day'`).catch(() => undefined);
  }
}
