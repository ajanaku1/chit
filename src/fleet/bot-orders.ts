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
 * the price per token is at or below the level. The level is also the
 * fill's floor: the buy asks for at least the level's tokens (or the
 * quote's floor when that is higher), so a thin pool or a price that moved
 * back between the run's read and the send never fills under the level;
 * it waits instead. A DCA is an amount, an interval and a count; the first
 * buy is due at once, the rest one interval apart. A missed slot (the
 * session was paused, no quote) is retried at the next slot, not every five
 * minutes, so a pause does not burn the count.
 *
 * A refusal leaves the order open with the reason on it, because a paused
 * session is the owner's choice and not a reason to lose their order; three
 * refusals in a row fail it, so a dead session does not keep an order alive
 * for a month. The owner hears about every attempt in one line.
 *
 * Money is sent at most once per slot. Before the send the run claims the
 * order in one statement (only an open, unclaimed order takes the claim, so
 * a cancel that landed first stands and two runs cannot both send it), and
 * the run's write after the send only lands on an order that is still open,
 * so a cancel during the send is never overwritten. A run the platform
 * kills between the send and that write leaves the claim behind; the next
 * run finds it past its lease and settles the order as sent with the
 * outcome unknown (a limit closes, a DCA counts the slot) rather than
 * sending again. A send that throws is treated the same way, because an RPC
 * that timed out may still have relayed the transaction.
 *
 * Orders are bound to the chain they were placed on and the runner only
 * reads its own chain's. One run sends at most `maxPerRun` executes, taken
 * one per owner in turn so nobody's queue starves another's, and each owner
 * has the same daily budget of executes and fronted gas a tapped Buy has,
 * counted from a ledger every claim writes; over it, their orders wait for
 * tomorrow. An account keeps at most `MAX_OPEN_ORDERS` open at once.
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
  /** The chain the order was placed on; a runner on another chain never sees it. */
  chainId: number;
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
  /** Set (ISO) from the claim before a send until the write after it; left behind by a run that died in between. */
  firingAt?: string;
};

export interface OrderStore {
  /** A new order. Never touches a claim. */
  put(o: Order): Promise<void>;
  get(id: string): Promise<Order | undefined>;
  /** Every open order on the chain, oldest first, claimed ones included: the runner settles the stale claims. */
  open(chainId: number): Promise<Order[]>;
  openFor(tgId: string, chainId: number): Promise<Order[]>;
  /** One statement: marks the order as being sent now and writes the ledger, only when it is open and unclaimed; false otherwise. */
  claim(id: string, at: Date): Promise<boolean>;
  /** The runner's write after a send, a wait or a refusal; clears the claim. Only an order still open takes it, so a cancel meanwhile stands; false when it did not land. */
  settle(o: Order): Promise<boolean>;
  /** Cancels an open order; false when it was not open. */
  cancel(id: string): Promise<boolean>;
  /** How many sends the ledger holds for this owner on this chain since `since`. */
  firesSince(tgId: string, chainId: number, since: Date): Promise<number>;
}

export const newOrderId = (): string => randomBytes(8).toString("hex");
export const MAX_REFUSALS = 3;
export const DEFAULT_MAX_PER_RUN = 20;
/** Open orders one account keeps at once; the bot refuses the next one until one is cancelled or done. */
export const MAX_OPEN_ORDERS = 10;
/** A claim older than this belongs to a run the platform killed (api/bot/orders.js lives 300 s at most). */
export const FIRING_LEASE_MS = 6 * 60_000;
/** The same daily budget per owner a tapped Buy has (bot-session.ts), counted the same way: the gas ceiling of one execute at one gwei. */
const DAILY_DEFAULTS = { executes: 200, gasWei: 2_000_000_000_000_000n };
const GAS_CEILING_WEI = 700_000n * 1_000_000_000n;
/** New sends stop once a run has been going this long, so the platform's cut-off lands between orders, not inside one. */
const DEFAULT_RUN_BUDGET_MS = 200_000;

/**
 * What fires now, from a list of orders and the pools' current prices. Pure,
 * so a test can hand it a clock and a price. A token with no price (no pool,
 * a failed read) fires nothing; a DCA with no next time is malformed and
 * fires nothing either; an order a run is sending is not due again.
 */
export const due = (orders: readonly Order[], now: Date, perEthOf: (token: Address) => bigint | undefined): Order[] =>
  orders.filter((o) => {
    if (o.status !== "open" || o.firingAt) return false;
    if (o.kind === "limit") {
      const perEth = perEthOf(o.token);
      return o.triggerPerEth !== undefined && perEth !== undefined && perEth >= o.triggerPerEth;
    }
    return o.nextAt !== undefined && (o.remaining ?? 0) > 0 && Date.parse(o.nextAt) <= now.getTime();
  });

/** The same list, one order per owner in turn (each owner's own order kept), so one owner's queue never starves another's. */
export const fair = (orders: readonly Order[]): Order[] => {
  const byOwner = new Map<string, Order[]>();
  for (const o of orders) byOwner.set(o.tgId, [...(byOwner.get(o.tgId) ?? []), o]);
  const out: Order[] = [];
  for (let i = 0; out.length < orders.length; i++) for (const q of byOwner.values()) if (q[i]) out.push(q[i]!);
  return out;
};

/** The tokens one ETH buys at the level: what a limit buy must get at least. */
export const levelOut = (o: Order): bigint => (o.ethWei * (o.triggerPerEth ?? 0n)) / 10n ** 18n;

export type OrderRunnerDeps = {
  orders: OrderStore;
  links: BotLinkStore;
  reads: BotChain;
  session: SessionChain;
  telegram: Telegram;
  buySlippageBps?: number;
  maxPerRun?: number;
  /** Per owner, per UTC day: how many executes and how much gas the bot fronts through orders. */
  dailyExecutes?: number;
  dailyGasWei?: bigint;
  runBudgetMs?: number;
  now?: () => Date;
};

export type RunReport = { fired: number; landed: number; refused: number; waited: number };
type Outcome = "landed" | "sent" | "unknown" | "refused" | "waited" | "skipped";
type Budget = { executes: number; gasWei: bigint };

const eth = (wei: bigint): string => {
  const w = wei / 10n ** 18n, f = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 5).replace(/0+$/, "");
  return `${w}${f ? "." + f : ""}`;
};
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const label = (o: Order): string => (o.kind === "limit" ? "limit buy" : "dca");
const firstLine = (e: unknown): string => (e instanceof Error ? e.message.split("\n")[0]! : String(e));
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

export class OrderRunner {
  readonly #d: OrderRunnerDeps;
  constructor(d: OrderRunnerDeps) { this.#d = d; }
  get #now(): Date { return this.#d.now ? this.#d.now() : new Date(); }
  get #chainId(): number { return this.#d.session.chainId; }

  /** One pass: settle what a dead run left, read, price, fire what is due. Safe to call every five minutes; a run that finds nothing due reads and sends nothing. */
  async run(now: Date = this.#now): Promise<RunReport> {
    const report: RunReport = { fired: 0, landed: 0, refused: 0, waited: 0 };
    const started = Date.now();
    const open = await this.#d.orders.open(this.#chainId);
    if (!open.length) return report;
    // A claim left behind by a run that died: past its lease the order is settled as sent, never sent again.
    for (const o of open) if (o.firingAt && now.getTime() - Date.parse(o.firingAt) >= FIRING_LEASE_MS) await this.#cutOff(o, now, "the run that sent it was cut off before the answer came");
    // One price read per token, not one per order.
    const prices = new Map<string, bigint | undefined>();
    for (const token of new Set(open.map((o) => o.token.toLowerCase()))) {
      const info = await this.#d.reads.tokenInfo(token as Address).catch(() => undefined);
      prices.set(token, info && info.hasPool ? info.perEth : undefined);
    }
    const cap = this.#d.maxPerRun ?? DEFAULT_MAX_PER_RUN;
    const budgets = new Map<string, Budget>();
    let executes = 0;
    for (const o of fair(due(open, now, (t) => prices.get(t.toLowerCase())))) {
      if (executes >= cap || Date.now() - started >= (this.#d.runBudgetMs ?? DEFAULT_RUN_BUDGET_MS)) break;
      const outcome = await this.#fire(o, now, budgets);
      if (outcome === "skipped") continue;
      if (outcome === "waited") { report.waited += 1; continue; }
      report.fired += 1;
      if (outcome === "refused") report.refused += 1;
      else { executes += 1; if (outcome === "landed") report.landed += 1; }
    }
    return report;
  }

  /** The owner's sends today so far, from the ledger once per run and then counted along. */
  async #budget(tgId: string, now: Date, budgets: Map<string, Budget>): Promise<Budget> {
    const known = budgets.get(tgId);
    if (known) return known;
    const dayStart = new Date(now.toISOString().slice(0, 10));
    const executes = await this.#d.orders.firesSince(tgId, this.#chainId, dayStart);
    const b: Budget = { executes, gasWei: BigInt(executes) * GAS_CEILING_WEI };
    budgets.set(tgId, b);
    return b;
  }

  async #fire(o: Order, now: Date, budgets: Map<string, Budget>): Promise<Outcome> {
    const link = await this.#d.links.getLink(o.tgId);
    if (!link || link.account.toLowerCase() !== o.account.toLowerCase() || link.chainId !== o.chainId) return this.#refuse(o, now, "your telegram is no longer linked to the account this order was placed from");
    const [info, quote] = await Promise.all([this.#d.reads.tokenInfo(o.token), this.#d.reads.quoteBuy(o.token, o.ethWei)]);
    if (!info.hasPool || quote === null) return this.#refuse(o, now, "no quote from the pool right now");
    let minOut = minOutFor(quote, this.#d.buySlippageBps ?? 300);
    if (o.kind === "limit") {
      // The level is checked again on this read, not the run's: a price that slipped back is simply not due.
      if (info.perEth < (o.triggerPerEth ?? 0n)) return "skipped";
      const floor = levelOut(o);
      if (quote < floor) return this.#wait(o, now, `the pool gives fewer ${esc(info.symbol)} than your level for ${eth(o.ethWei)} ETH once the fee and the depth are in; the order waits for the price to move`);
      minOut = max(minOut, floor);
    }
    const budget = await this.#budget(o.tgId, now, budgets);
    if (budget.executes >= (this.#d.dailyExecutes ?? DAILY_DEFAULTS.executes)) return this.#wait(o, now, `that is ${this.#d.dailyExecutes ?? DAILY_DEFAULTS.executes} buys today from this account; the order waits for tomorrow`);
    if (budget.gasWei >= (this.#d.dailyGasWei ?? DAILY_DEFAULTS.gasWei)) return this.#wait(o, now, "the bot has fronted its daily gas for this account; the order waits for tomorrow");
    // The contract's own answer first, so a refused buy burns no gas and says why in the contract's words.
    const can = await this.#d.session.canExecute(o.account, this.#d.reads.router, UNIVERSAL_ROUTER_EXECUTE_SELECTOR, o.ethWei);
    if (!can.ok) return this.#refuse(o, now, `your session says no: ${can.why}`);
    const deadline = BigInt(Math.floor(now.getTime() / 1000) + 3600);
    const data = encodeV4EthBuy({ token: o.token, amountIn: o.ethWei, minOut, deadline, ...(info.poolKey ? { poolKey: info.poolKey } : {}) });
    // The claim is the last word before money moves: cancelled meanwhile, or held by another run, and nothing is sent.
    if (!(await this.#d.orders.claim(o.id, now))) return "skipped";
    budget.executes += 1;
    budget.gasWei += GAS_CEILING_WEI;
    let r: { hash: Hex; landed: boolean };
    try { r = await this.#d.session.execute(o.account, this.#d.reads.router, o.ethWei, data); }
    catch (e) { return this.#cutOff(o, now, `the send did not answer (${firstLine(e)})`); }
    // The buy went out: the order moves on whether or not the receipt was seen in time; the floor protects the fill either way.
    const next: Order = { ...o, refusals: 0 };
    delete next.lastError;
    delete next.firingAt;
    if (o.kind === "limit") next.status = "done";
    else {
      next.remaining = (o.remaining ?? 1) - 1;
      next.nextAt = new Date(now.getTime() + (o.everyMs ?? 0)).toISOString();
      if (next.remaining <= 0) next.status = "done";
    }
    const explorer = `https://robinhoodchain.blockscout.com/tx/${r.hash}`;
    const head = `${label(o)}: <code>${eth(o.ethWei)} ETH</code> into <b>${esc(info.symbol)}</b>`;
    if (!(await this.#d.orders.settle(next))) {
      await this.#tell(o.tgId, `${head} went out, <a href="${explorer}">${short(r.hash)}</a>, and the order was cancelled while it was in flight; nothing more is sent.`);
      return r.landed ? "landed" : "sent";
    }
    const tail = o.kind === "dca" ? (next.status === "done" ? " that was the last one." : ` ${next.remaining} left.`) : "";
    await this.#tell(o.tgId, r.landed
      ? `${head} landed, <a href="${explorer}">${short(r.hash)}</a>.${tail}`
      : `${head} sent, <a href="${explorer}">${short(r.hash)}</a>, not confirmed as landed; the floor protects the fill.${tail}`);
    return r.landed ? "landed" : "sent";
  }

  /** A send whose outcome is not known is never sent again on its own: a limit closes, a DCA counts the slot as spent. */
  async #cutOff(o: Order, now: Date, why: string): Promise<"unknown"> {
    const next: Order = { ...o, lastError: why };
    delete next.firingAt;
    if (o.kind === "limit") next.status = "failed";
    else {
      next.remaining = (o.remaining ?? 1) - 1;
      next.nextAt = new Date(now.getTime() + (o.everyMs ?? 0)).toISOString();
      if (next.remaining <= 0) next.status = "done";
    }
    await this.#d.orders.settle(next);
    await this.#tell(o.tgId, o.kind === "limit"
      ? `${label(o)} on <code>${o.token}</code>: ${esc(why)}. it is not sent again on its own: check the account on the explorer and set the order again if nothing landed.`
      : `${label(o)} on <code>${o.token}</code>: ${esc(why)}. that slot counts as spent so it cannot buy twice; check the account.${next.status === "done" ? " that was the last one." : ` ${next.remaining} left.`}`);
    return "unknown";
  }

  /** Not a refusal: the order waits with the reason on it. A DCA moves to its next slot without burning a buy, a limit stays armed; the owner hears the reason once, not every five minutes. */
  async #wait(o: Order, now: Date, why: string): Promise<"waited"> {
    const fresh = o.lastError !== why;
    if (o.kind === "limit" && !fresh) return "waited";
    const next: Order = { ...o, lastError: why };
    if (o.kind === "dca") next.nextAt = new Date(now.getTime() + (o.everyMs ?? 0)).toISOString();
    await this.#d.orders.settle(next);
    if (fresh) await this.#tell(o.tgId, `${label(o)} on <code>${o.token}</code>: ${esc(why)}.`);
    return "waited";
  }

  async #refuse(o: Order, now: Date, why: string): Promise<"refused"> {
    const refusals = o.refusals + 1;
    const next: Order = { ...o, refusals, lastError: why };
    if (refusals >= MAX_REFUSALS) next.status = "failed";
    // A DCA skips to its next slot rather than knocking every five minutes; a limit stays armed on the price.
    else if (o.kind === "dca") next.nextAt = new Date(now.getTime() + (o.everyMs ?? 0)).toISOString();
    if (!(await this.#d.orders.settle(next))) return "refused";
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

/** One instance's memory: tests and one machine. The same rules as Neon's: a put never touches a claim, a settle only lands on an open order. */
export class MemoryOrderStore implements OrderStore {
  readonly rows = new Map<string, Order>();
  readonly fires: { orderId: string; tgId: string; chainId: number; at: string }[] = [];
  async put(o: Order) { const was = this.rows.get(o.id); this.rows.set(o.id, { ...o, ...(was?.firingAt ? { firingAt: was.firingAt } : {}) }); }
  async get(id: string) { const o = this.rows.get(id); return o ? { ...o } : undefined; }
  async open(chainId: number) { return [...this.rows.values()].filter((o) => o.status === "open" && o.chainId === chainId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((o) => ({ ...o })); }
  async openFor(tgId: string, chainId: number) { return (await this.open(chainId)).filter((o) => o.tgId === tgId); }
  async claim(id: string, at: Date) {
    const o = this.rows.get(id);
    if (!o || o.status !== "open" || o.firingAt) return false;
    o.firingAt = at.toISOString();
    this.fires.push({ orderId: id, tgId: o.tgId, chainId: o.chainId, at: o.firingAt });
    return true;
  }
  async settle(o: Order) {
    const was = this.rows.get(o.id);
    if (!was || was.status !== "open") return false;
    const next: Order = { ...was, status: o.status, refusals: o.refusals };
    delete next.firingAt;
    if (o.remaining === undefined) delete next.remaining; else next.remaining = o.remaining;
    if (o.nextAt === undefined) delete next.nextAt; else next.nextAt = o.nextAt;
    if (o.lastError === undefined) delete next.lastError; else next.lastError = o.lastError;
    this.rows.set(o.id, next);
    return true;
  }
  async cancel(id: string) {
    const o = this.rows.get(id);
    if (!o || o.status !== "open") return false;
    o.status = "cancelled";
    return true;
  }
  async firesSince(tgId: string, chainId: number, since: Date) { return this.fires.filter((f) => f.tgId === tgId && f.chainId === chainId && Date.parse(f.at) >= since.getTime()).length; }
}

type Row = Record<string, unknown>;
export type OrderSql = { query(sql: string, params?: unknown[]): Promise<readonly Row[]> };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bot_orders (id TEXT PRIMARY KEY, tg_id TEXT NOT NULL, account TEXT NOT NULL, chain_id INTEGER NOT NULL DEFAULT 4663, token TEXT NOT NULL, kind TEXT NOT NULL, eth_wei NUMERIC(40,0) NOT NULL, trigger_per_eth NUMERIC(40,0), every_ms BIGINT, remaining INTEGER, next_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL, last_error TEXT, refusals INTEGER NOT NULL DEFAULT 0, firing_at TIMESTAMPTZ)`,
  // A table from before orders carried a chain and a claim.
  `ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT 4663`,
  `ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS firing_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS bot_orders_open_chain ON bot_orders (status, chain_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS bot_order_fires (id BIGSERIAL PRIMARY KEY, order_id TEXT NOT NULL, tg_id TEXT NOT NULL, chain_id INTEGER NOT NULL, fired_at TIMESTAMPTZ NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS bot_order_fires_owner ON bot_order_fires (tg_id, chain_id, fired_at)`,
];

const rowOrder = (r: Row): Order => ({
  id: String(r.id), tgId: String(r.tg_id), account: String(r.account) as Address, chainId: Number(r.chain_id), token: String(r.token) as Address, kind: String(r.kind) as OrderKind,
  ethWei: BigInt(String(r.eth_wei)),
  ...(r.trigger_per_eth !== null && r.trigger_per_eth !== undefined ? { triggerPerEth: BigInt(String(r.trigger_per_eth)) } : {}),
  ...(r.every_ms !== null && r.every_ms !== undefined ? { everyMs: Number(r.every_ms) } : {}),
  ...(r.remaining !== null && r.remaining !== undefined ? { remaining: Number(r.remaining) } : {}),
  ...(r.next_at ? { nextAt: new Date(String(r.next_at)).toISOString() } : {}),
  createdAt: new Date(String(r.created_at)).toISOString(), status: String(r.status) as OrderStatus,
  ...(r.last_error ? { lastError: String(r.last_error) } : {}),
  refusals: Number(r.refusals ?? 0),
  ...(r.firing_at ? { firingAt: new Date(String(r.firing_at)).toISOString() } : {}),
});

/** Neon: beside the bot's links; the schema is applied once per instance. Every runner write is one conditional statement, never a read then a write. */
export class NeonOrderStore implements OrderStore {
  #ready: Promise<void> | undefined;
  constructor(private readonly sql: OrderSql) {}
  #init(): Promise<void> { return (this.#ready ??= (async () => { for (const s of SCHEMA) await this.sql.query(s); })().catch((e) => { this.#ready = undefined; throw e; })); }
  async put(o: Order) {
    await this.#init();
    await this.sql.query(
      `INSERT INTO bot_orders (id, tg_id, account, chain_id, token, kind, eth_wei, trigger_per_eth, every_ms, remaining, next_at, created_at, status, last_error, refusals) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET remaining = EXCLUDED.remaining, next_at = EXCLUDED.next_at, status = EXCLUDED.status, last_error = EXCLUDED.last_error, refusals = EXCLUDED.refusals`,
      [o.id, o.tgId, o.account, o.chainId, o.token, o.kind, o.ethWei.toString(), o.triggerPerEth?.toString() ?? null, o.everyMs ?? null, o.remaining ?? null, o.nextAt ?? null, o.createdAt, o.status, o.lastError ?? null, o.refusals],
    );
  }
  async get(id: string) { await this.#init(); const [r] = await this.sql.query(`SELECT * FROM bot_orders WHERE id = $1`, [id]); return r ? rowOrder(r) : undefined; }
  async open(chainId: number) { await this.#init(); return (await this.sql.query(`SELECT * FROM bot_orders WHERE status = 'open' AND chain_id = $1 ORDER BY created_at`, [chainId])).map(rowOrder); }
  async openFor(tgId: string, chainId: number) { await this.#init(); return (await this.sql.query(`SELECT * FROM bot_orders WHERE status = 'open' AND chain_id = $1 AND tg_id = $2 ORDER BY created_at`, [chainId, tgId])).map(rowOrder); }
  async claim(id: string, at: Date) {
    await this.#init();
    const rows = await this.sql.query(
      `WITH claimed AS (UPDATE bot_orders SET firing_at = $2 WHERE id = $1 AND status = 'open' AND firing_at IS NULL RETURNING id, tg_id, chain_id)
       INSERT INTO bot_order_fires (order_id, tg_id, chain_id, fired_at) SELECT id, tg_id, chain_id, $2 FROM claimed RETURNING order_id`,
      [id, at.toISOString()],
    );
    return rows.length === 1;
  }
  async settle(o: Order) {
    await this.#init();
    const rows = await this.sql.query(
      `UPDATE bot_orders SET remaining = $2, next_at = $3, status = $4, last_error = $5, refusals = $6, firing_at = NULL WHERE id = $1 AND status = 'open' RETURNING id`,
      [o.id, o.remaining ?? null, o.nextAt ?? null, o.status, o.lastError ?? null, o.refusals],
    );
    return rows.length === 1;
  }
  async cancel(id: string) {
    await this.#init();
    const rows = await this.sql.query(`UPDATE bot_orders SET status = 'cancelled' WHERE id = $1 AND status = 'open' RETURNING id`, [id]);
    return rows.length === 1;
  }
  async firesSince(tgId: string, chainId: number, since: Date) {
    await this.#init();
    const [r] = await this.sql.query(`SELECT COUNT(*)::int AS n FROM bot_order_fires WHERE tg_id = $1 AND chain_id = $2 AND fired_at >= $3`, [tgId, chainId, since.toISOString()]);
    return Number(r?.n ?? 0);
  }
}
