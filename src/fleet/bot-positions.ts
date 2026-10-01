/**
 * The mainnet bot's trade record, for Positions and their P&L (2026-10-01).
 *
 * Every buy and sell the bot sends from a session account is written down by
 * its hash the moment it is sent, whoever sent it: a tap, a mirrored buy
 * (bot-copy.ts), a fired order (bot-orders.ts). What it did is settled later
 * from the chain's own receipt: the tokens a buy brought into the account,
 * or nothing when it reverted. So a buy that was sent but not seen landing is
 * still counted right, once the chain answers.
 *
 * P&L is average cost: the ETH every settled buy of a token paid, over the
 * tokens those buys brought, against what selling the holding would return
 * now. Units the record cannot account for (sent to the account from
 * outside, or bought before the record began) are shown without a cost.
 */
import type { Address, Hex } from "./types.js";

/** Addresses are kept lowercase, so a token pasted in any case is one token. */
const lower = (a: string): Address => a.toLowerCase() as Address;

export type TradeSide = "buy" | "sell";

export type BotTrade = {
  hash: Hex;
  account: Address;
  token: Address;
  side: TradeSide;
  /** A buy's ETH in; 0 for a sell (what a sale returned is not needed for average cost). */
  ethWei: bigint;
  /** A sell's units sent; 0 for a buy, whose units are what the receipt shows arriving. */
  asked: bigint;
  /** Tokens in (buy) or out (sell); null until settled from the receipt. */
  units: bigint | null;
  /** A sell's ETH back: its floor when sent, what the account's balance rose by once it landed (saleProceeds). Absent for a buy. */
  ethOut?: bigint;
  at: string;
};

/** What the receipt says: undefined while the chain has none yet. */
export type TradeReceipt = { status: "success" | "reverted"; received: bigint } | undefined;

export type PositionLedger = {
  /** Written when the trade is sent; the same hash twice is one trade. */
  note(trade: BotTrade): Promise<void>;
  settle(hash: Hex, units: bigint): Promise<void>;
  /** What a landed sell returned, measured when it landed. */
  proceeds(hash: Hex, wei: bigint): Promise<void>;
  forAccount(account: Address): Promise<BotTrade[]>;
};

/** The chain's answer for a sent trade: its status, and the token units that reached the account in it. */
export type TradeSettler = (hash: Hex, token: Address, account: Address) => Promise<TradeReceipt>;

export class MemoryPositionLedger implements PositionLedger {
  readonly trades = new Map<string, BotTrade>();
  async note(t: BotTrade) { if (!this.trades.has(t.hash.toLowerCase())) this.trades.set(t.hash.toLowerCase(), { ...t, account: lower(t.account), token: lower(t.token) }); }
  async settle(hash: Hex, units: bigint) { const t = this.trades.get(hash.toLowerCase()); if (t) t.units = units; }
  async proceeds(hash: Hex, wei: bigint) { const t = this.trades.get(hash.toLowerCase()); if (t) t.ethOut = wei; }
  async forAccount(account: Address) { const a = lower(account); return [...this.trades.values()].filter((t) => t.account === a).map((t) => ({ ...t })); }
}

type Row = Record<string, unknown>;
export type PositionSql = { query(sql: string, params?: unknown[]): Promise<readonly Row[]> };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bot_session_trades (tx_hash TEXT PRIMARY KEY, account TEXT NOT NULL, token TEXT NOT NULL, side TEXT NOT NULL, eth_wei NUMERIC(40,0) NOT NULL, asked NUMERIC(60,0) NOT NULL, units NUMERIC(60,0), at TIMESTAMPTZ NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS bot_session_trades_account ON bot_session_trades (account)`,
  `ALTER TABLE bot_session_trades ADD COLUMN IF NOT EXISTS eth_out NUMERIC(40,0)`,
];

const rowTrade = (r: Row): BotTrade => ({
  hash: String(r.tx_hash) as Hex, account: lower(String(r.account)), token: lower(String(r.token)), side: String(r.side) as TradeSide,
  ethWei: BigInt(String(r.eth_wei)), asked: BigInt(String(r.asked)), units: r.units === null || r.units === undefined ? null : BigInt(String(r.units)), at: new Date(String(r.at)).toISOString(),
  ...(r.eth_out === null || r.eth_out === undefined ? {} : { ethOut: BigInt(String(r.eth_out)) }),
});

/** Neon, beside the bot's other tables; the schema is applied once per instance. */
export class NeonPositionLedger implements PositionLedger {
  #ready: Promise<void> | undefined;
  constructor(private readonly sql: PositionSql) {}
  #init(): Promise<void> {
    return (this.#ready ??= (async () => { for (const s of SCHEMA) await this.sql.query(s); })().catch((e) => { this.#ready = undefined; throw e; }));
  }
  async note(t: BotTrade) {
    await this.#init();
    await this.sql.query(
      `INSERT INTO bot_session_trades (tx_hash, account, token, side, eth_wei, asked, units, at, eth_out) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (tx_hash) DO NOTHING`,
      [t.hash.toLowerCase(), lower(t.account), lower(t.token), t.side, t.ethWei.toString(), t.asked.toString(), t.units === null ? null : t.units.toString(), t.at, t.ethOut === undefined ? null : t.ethOut.toString()],
    );
  }
  async settle(hash: Hex, units: bigint) {
    await this.#init();
    await this.sql.query(`UPDATE bot_session_trades SET units = $2 WHERE tx_hash = $1`, [hash.toLowerCase(), units.toString()]);
  }
  async proceeds(hash: Hex, wei: bigint) {
    await this.#init();
    await this.sql.query(`UPDATE bot_session_trades SET eth_out = $2 WHERE tx_hash = $1`, [hash.toLowerCase(), wei.toString()]);
  }
  async forAccount(account: Address) {
    await this.#init();
    return (await this.sql.query(`SELECT * FROM bot_session_trades WHERE account = $1 ORDER BY at`, [lower(account)])).map(rowTrade);
  }
}

/**
 * Settles every unsettled trade the chain has answered for: a landed buy is the tokens its receipt brought, a landed
 * sell the units it was sent with, a reverted one nothing. A trade the chain has no receipt for yet stays unsettled.
 */
export const settleTrades = async (ledger: PositionLedger, settler: TradeSettler, trades: BotTrade[]): Promise<BotTrade[]> =>
  Promise.all(trades.map(async (t) => {
    if (t.units !== null) return t;
    const receipt = await settler(t.hash, t.token, t.account).catch(() => undefined);
    if (!receipt) return t;
    const units = receipt.status === "reverted" ? 0n : t.side === "buy" ? receipt.received : t.asked;
    await ledger.settle(t.hash, units);
    return { ...t, units };
  }));

/** Per token, from settled trades: ETH the buys paid, the units they brought, the units sold. */
export type CostBasis = { token: Address; ethIn: bigint; unitsIn: bigint; unitsOut: bigint };

export const costBasis = (trades: BotTrade[]): CostBasis[] => {
  const by = new Map<string, CostBasis>();
  for (const t of trades) {
    if (t.units === null) continue;
    const c = by.get(t.token) ?? { token: t.token, ethIn: 0n, unitsIn: 0n, unitsOut: 0n };
    if (t.side === "buy" && t.units > 0n) { c.ethIn += t.ethWei; c.unitsIn += t.units; }
    if (t.side === "sell") c.unitsOut += t.units;
    by.set(t.token, c);
  }
  return [...by.values()];
};

/**
 * One row of Positions. `cost` is what the held units the record accounts for cost, at the average price the buys
 * paid; `unknownUnits` are held units it cannot account for, which carry no cost and so no P&L.
 */
export type PositionRow = { token: Address; held: bigint; value: bigint; cost: bigint | null; pnl: bigint | null; unknownUnits: bigint };

export const positionRow = (basis: CostBasis, held: bigint, value: bigint): PositionRow => {
  const recorded = basis.unitsIn - basis.unitsOut > 0n ? basis.unitsIn - basis.unitsOut : 0n;
  const costed = held < recorded ? held : recorded;
  if (basis.unitsIn === 0n || costed === 0n) return { token: basis.token, held, value, cost: null, pnl: null, unknownUnits: held };
  const cost = (basis.ethIn * costed) / basis.unitsIn;
  // The value of the costed share only, so units without a cost do not flatter the P&L.
  const costedValue = held === 0n ? 0n : (value * costed) / held;
  return { token: basis.token, held, value, cost, pnl: costedValue - cost, unknownUnits: held - costed };
};

/** Writes a sent trade down; a record that fails is logged and never stands in the way of the trade or its reply. */
export const noteSent = async (ledger: PositionLedger | undefined, t: Omit<BotTrade, "units">): Promise<void> => {
  if (!ledger) return;
  try { await ledger.note({ ...t, units: null }); }
  catch (error) { console.error("positions: trade not noted", t.hash, (error instanceof Error ? error.message : String(error)).split("\n")[0]); }
};

/**
 * What a landed sale returned: the account's balance after, less before. The bot pays the gas, so that rise is the
 * sale's ETH, unless something else moved the account in between; so it is held between the floor (a landed sale
 * returned at least that) and the quote, and a balance read that missed it counts the floor.
 */
export const saleProceeds = (before: bigint, after: bigint, floor: bigint, quote: bigint): bigint => {
  const rose = after - before;
  return rose < floor ? floor : rose > quote ? quote : rose;
};

/** Writes what a landed sale returned; like noteSent, a failure is logged and never stands in the way of the reply. */
export const noteProceeds = async (ledger: PositionLedger | undefined, hash: Hex, wei: bigint): Promise<void> => {
  if (!ledger) return;
  try { await ledger.proceeds(hash, wei); }
  catch (error) { console.error("positions: proceeds not noted", hash, (error instanceof Error ? error.message : String(error)).split("\n")[0]); }
};
