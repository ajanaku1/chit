/**
 * Standing orders on the mainnet bot: a limit buy and a DCA, both on the
 * session an owner granted the bot's key. The owner sets the order from the
 * token card; a cron (api/bot/orders.js, every five minutes) reads what is
 * open, asks the pool where the price is, and fires what is due as the same
 * one `execute` a tapped Buy would be: canExecute first, the quote, the
 * floor, the bot's key signing, the account paying. Nothing here holds a
 * key of the owner's, and an order never widens what the session allows:
 * a buy the account refuses is refused, in the contract's words.
 *
 * A limit buy names the price as tokens per ETH, the way the card shows it:
 * it fires when the pool gives at least that many tokens for one ETH, so
 * the price per token is at or below the level. A DCA is an amount, an
 * interval and a count; the first buy is due at once, the rest one interval
 * apart. A missed slot (the session was paused, no quote) is retried at the
 * next slot, not every five minutes, so a pause does not burn the count.
 *
 * A refusal leaves the order open with the reason on it, because a paused
 * session is the owner's choice and not a reason to lose their order; three
 * refusals in a row fail it, so a dead session does not keep an order alive
 * for a month. The owner hears about every attempt in one line. One run
 * sends at most `maxPerRun` executes, so a cron gone wrong cannot drain the
 * signer's gas float in a burst.
 */

import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import type { BotChain } from "./bot-chain.js";
import type { BotLinkStore } from "./bot-link.js";
import type { SessionChain } from "./bot-session-chain.js";
import { esc, type Telegram } from "./bot-telegram.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, encodeV4EthBuy, minOutFor } from "./v4-swap.js";

export type OrderKind = "limit" | "dca";
export type OrderStatus = "open" | "done" | "cancelled" | "failed";

export type Order = {
  id: string;
  tgId: string;
  /** The session account the order was placed from; the link must still name it when the order fires. */
  account: Address;
  token: Address;
  kind: OrderKind;
  /** ETH per buy. */
  ethWei: bigint;
  /** Limit: tokens per ETH in the token's base units; fires when the pool's perEth is at or above it. */
  triggerPerEth?: bigint;
  /** DCA: the interval, how many buys are left, and when the next one is due (ISO). */
  everyMs?: number;
  remaining?: number;
  nextAt?: string;
  createdAt: string;
  status: OrderStatus;
  lastError?: string;
  /** Refusals in a row; reset by a buy that goes out, three of them fail the order. */
  refusals: number;
};

export interface OrderStore {
  put(o: Order): Promise<void>;
  get(id: string): Promise<Order | undefined>;
  /** Every open order, oldest first: the order the runner fires them in. */
  open(): Promise<Order[]>;
  openFor(tgId: string): Promise<Order[]>;
}

export const newOrderId = (): string => randomBytes(8).toString("hex");
export const MAX_REFUSALS = 3;
export const DEFAULT_MAX_PER_RUN = 20;

/**
 * What fires now, from a list of orders and the pools' current prices. Pure,
 * so a test can hand it a clock and a price. A token with no price (no pool,
 * a failed read) fires nothing; a DCA with no next time is malformed and
 * fires nothing either.
 */
export const due = (orders: readonly Order[], now: Date, perEthOf: (token: Address) => bigint | undefined): Order[] =>
  orders.filter((o) => {
    if (o.status !== "open") return false;
    if (o.kind === "limit") {
      const perEth = perEthOf(o.token);
      return o.triggerPerEth !== undefined && perEth !== undefined && perEth >= o.triggerPerEth;
    }
    return o.nextAt !== undefined && (o.remaining ?? 0) > 0 && Date.parse(o.nextAt) <= now.getTime();
  });

export type OrderRunnerDeps = {
  orders: OrderStore;
  links: BotLinkStore;
  reads: BotChain;
  session: SessionChain;
  telegram: Telegram;
  buySlippageBps?: number;
  maxPerRun?: number;
  now?: () => Date;
};

export type RunReport = { fired: number; landed: number; refused: number };

const eth = (wei: bigint): string => {
  const w = wei / 10n ** 18n, f = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 5).replace(/0+$/, "");
  return `${w}${f ? "." + f : ""}`;
};
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const label = (o: Order): string => (o.kind === "limit" ? "limit buy" : "dca");

export class OrderRunner {
  readonly #d: OrderRunnerDeps;
  constructor(d: OrderRunnerDeps) { this.#d = d; }
  get #now(): Date { return this.#d.now ? this.#d.now() : new Date(); }

  /** One pass: read, price, fire what is due. Safe to call every five minutes; a run that finds nothing due reads and sends nothing. */
  async run(now: Date = this.#now): Promise<RunReport> {
    const report: RunReport = { fired: 0, landed: 0, refused: 0 };
    const open = await this.#d.orders.open();
    if (!open.length) return report;
    // One price read per token, not one per order.
    const prices = new Map<string, bigint | undefined>();
    for (const token of new Set(open.map((o) => o.token.toLowerCase()))) {
      const info = await this.#d.reads.tokenInfo(token as Address).catch(() => undefined);
      prices.set(token, info && info.hasPool ? info.perEth : undefined);
    }
    const cap = this.#d.maxPerRun ?? DEFAULT_MAX_PER_RUN;
    let executes = 0;
    for (const o of due(open, now, (t) => prices.get(t.toLowerCase()))) {
      if (executes >= cap) break;
      report.fired += 1;
      const outcome = await this.#fire(o, now);
      if (outcome === "refused") report.refused += 1;
      else { executes += 1; if (outcome === "landed") report.landed += 1; }
    }
    return report;
  }

  async #fire(o: Order, now: Date): Promise<"landed" | "sent" | "refused"> {
    const link = await this.#d.links.getLink(o.tgId);
    if (!link || link.account.toLowerCase() !== o.account.toLowerCase()) return this.#refuse(o, now, "your telegram is no longer linked to the account this order was placed from");
    const [info, quote] = await Promise.all([this.#d.reads.tokenInfo(o.token), this.#d.reads.quoteBuy(o.token, o.ethWei)]);
    if (!info.hasPool || quote === null) return this.#refuse(o, now, "no quote from the pool right now");
    // The contract's own answer first, so a refused buy burns no gas and says why in the contract's words.
    const can = await this.#d.session.canExecute(o.account, this.#d.reads.router, UNIVERSAL_ROUTER_EXECUTE_SELECTOR, o.ethWei);
    if (!can.ok) return this.#refuse(o, now, `your session says no: ${can.why}`);
    const minOut = minOutFor(quote, this.#d.buySlippageBps ?? 300);
    const deadline = BigInt(Math.floor(now.getTime() / 1000) + 3600);
    const data = encodeV4EthBuy({ token: o.token, amountIn: o.ethWei, minOut, deadline, ...(info.poolKey ? { poolKey: info.poolKey } : {}) });
    let r: { hash: Hex; landed: boolean };
    try { r = await this.#d.session.execute(o.account, this.#d.reads.router, o.ethWei, data); }
    catch (e) { return this.#refuse(o, now, `the send failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }
    // The buy went out: the order moves on whether or not the receipt was seen in time; the floor protects the fill either way.
    const next: Order = { ...o, refusals: 0 };
    delete next.lastError;
    if (o.kind === "limit") next.status = "done";
    else {
      next.remaining = (o.remaining ?? 1) - 1;
      next.nextAt = new Date(now.getTime() + (o.everyMs ?? 0)).toISOString();
      if (next.remaining <= 0) next.status = "done";
    }
    await this.#d.orders.put(next);
    const explorer = `https://robinhoodchain.blockscout.com/tx/${r.hash}`;
    const tail = o.kind === "dca" ? (next.status === "done" ? " that was the last one." : ` ${next.remaining} left.`) : "";
    await this.#tell(o.tgId, r.landed
      ? `${label(o)}: <code>${eth(o.ethWei)} ETH</code> into <b>${esc(info.symbol)}</b> landed, <a href="${explorer}">${short(r.hash)}</a>.${tail}`
      : `${label(o)}: <code>${eth(o.ethWei)} ETH</code> into <b>${esc(info.symbol)}</b> sent, <a href="${explorer}">${short(r.hash)}</a>, not confirmed as landed; the floor protects the fill.${tail}`);
    return r.landed ? "landed" : "sent";
  }

  async #refuse(o: Order, now: Date, why: string): Promise<"refused"> {
    const refusals = o.refusals + 1;
    const next: Order = { ...o, refusals, lastError: why };
    if (refusals >= MAX_REFUSALS) next.status = "failed";
    // A DCA skips to its next slot rather than knocking every five minutes; a limit stays armed on the price.
    else if (o.kind === "dca") next.nextAt = new Date(now.getTime() + (o.everyMs ?? 0)).toISOString();
    await this.#d.orders.put(next);
    await this.#tell(o.tgId, next.status === "failed"
      ? `${label(o)} on <code>${o.token}</code>: ${esc(why)}. that is ${MAX_REFUSALS} refusals in a row, so the order is off; set it again when the session is back.`
      : `${label(o)} on <code>${o.token}</code>: ${esc(why)}. the order stays on; ${o.kind === "dca" ? "next try at the next slot" : "next try when the price is still there"} (${refusals} of ${MAX_REFUSALS}).`);
    return "refused";
  }

  /** The owner's private chat is their telegram id. A message that does not go out never fails the run. */
  async #tell(tgId: string, text: string): Promise<void> {
    try { await this.#d.telegram.deliver({ kind: "send", chatId: tgId, text }); }
    catch (e) { console.error(`bot orders: telegram: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

/** One instance's memory: tests and one machine. */
export class MemoryOrderStore implements OrderStore {
  readonly rows = new Map<string, Order>();
  async put(o: Order) { this.rows.set(o.id, { ...o }); }
  async get(id: string) { const o = this.rows.get(id); return o ? { ...o } : undefined; }
  async open() { return [...this.rows.values()].filter((o) => o.status === "open").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((o) => ({ ...o })); }
  async openFor(tgId: string) { return (await this.open()).filter((o) => o.tgId === tgId); }
}

type Row = Record<string, unknown>;
export type OrderSql = { query(sql: string, params?: unknown[]): Promise<readonly Row[]> };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bot_orders (id TEXT PRIMARY KEY, tg_id TEXT NOT NULL, account TEXT NOT NULL, token TEXT NOT NULL, kind TEXT NOT NULL, eth_wei NUMERIC(40,0) NOT NULL, trigger_per_eth NUMERIC(40,0), every_ms BIGINT, remaining INTEGER, next_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL, last_error TEXT, refusals INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS bot_orders_open ON bot_orders (status, created_at)`,
];

const rowOrder = (r: Row): Order => ({
  id: String(r.id), tgId: String(r.tg_id), account: String(r.account) as Address, token: String(r.token) as Address, kind: String(r.kind) as OrderKind,
  ethWei: BigInt(String(r.eth_wei)),
  ...(r.trigger_per_eth !== null && r.trigger_per_eth !== undefined ? { triggerPerEth: BigInt(String(r.trigger_per_eth)) } : {}),
  ...(r.every_ms !== null && r.every_ms !== undefined ? { everyMs: Number(r.every_ms) } : {}),
  ...(r.remaining !== null && r.remaining !== undefined ? { remaining: Number(r.remaining) } : {}),
  ...(r.next_at ? { nextAt: new Date(String(r.next_at)).toISOString() } : {}),
  createdAt: new Date(String(r.created_at)).toISOString(), status: String(r.status) as OrderStatus,
  ...(r.last_error ? { lastError: String(r.last_error) } : {}),
  refusals: Number(r.refusals ?? 0),
});

/** Neon: beside the bot's links; the schema is applied once per instance. */
export class NeonOrderStore implements OrderStore {
  #ready: Promise<void> | undefined;
  constructor(private readonly sql: OrderSql) {}
  #init(): Promise<void> { return (this.#ready ??= (async () => { for (const s of SCHEMA) await this.sql.query(s); })().catch((e) => { this.#ready = undefined; throw e; })); }
  async put(o: Order) {
    await this.#init();
    await this.sql.query(
      `INSERT INTO bot_orders (id, tg_id, account, token, kind, eth_wei, trigger_per_eth, every_ms, remaining, next_at, created_at, status, last_error, refusals) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET remaining = EXCLUDED.remaining, next_at = EXCLUDED.next_at, status = EXCLUDED.status, last_error = EXCLUDED.last_error, refusals = EXCLUDED.refusals`,
      [o.id, o.tgId, o.account, o.token, o.kind, o.ethWei.toString(), o.triggerPerEth?.toString() ?? null, o.everyMs ?? null, o.remaining ?? null, o.nextAt ?? null, o.createdAt, o.status, o.lastError ?? null, o.refusals],
    );
  }
  async get(id: string) { await this.#init(); const [r] = await this.sql.query(`SELECT * FROM bot_orders WHERE id = $1`, [id]); return r ? rowOrder(r) : undefined; }
  async open() { await this.#init(); return (await this.sql.query(`SELECT * FROM bot_orders WHERE status = 'open' ORDER BY created_at`)).map(rowOrder); }
  async openFor(tgId: string) { await this.#init(); return (await this.sql.query(`SELECT * FROM bot_orders WHERE status = 'open' AND tg_id = $1 ORDER BY created_at`, [tgId])).map(rowOrder); }
}
