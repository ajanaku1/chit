/**
 * The trading competition's scoring (rules agreed 2026-10-01), pure: the
 * entrants, their accounts' trades in the window and what each holding
 * would fetch at the end in; the two boards and the prizes out.
 *
 * Best PnL ($500), one number per wallet: (ETH back from sells + exit value of what
 * is still held - ETH spent on buys) / ETH spent on buys. Exit value is what
 * selling the whole holding returns, not a price, so a pumped thin pool
 * scores what it would really pay. Only trades in the window of at least the
 * minimum count (a buy by its ETH in, a sell by its ETH back), and at least
 * `minTrades` of them qualify a wallet. Units bought before the window, or
 * in trades under the minimum, carry no cost: what they sell for or are
 * worth is left out, so they cannot flatter the number. Break it ($150) is
 * judged by hand; its winner goes in `excluded`.
 *
 * Best ongoing trade ($350): the single holding still open at the end, bought in
 * the window, with the highest return on its cost, its cost at least the
 * minimum. One prize per person: the prizes are handed out biggest first,
 * each to the best-placed entrant not already holding one.
 */
import type { BotTrade } from "./bot-positions.js";
import type { Address } from "./types.js";

export type Holding = { held: bigint; exitWei: bigint };
export type Entrant = { tgId: string; nickname: string; trades: BotTrade[]; holdings: Map<string, Holding> };
export type ScoreRules = { start: Date; end: Date; minWei: bigint; minTrades: number };

export type PnlRow = { tgId: string; nickname: string; spent: bigint; back: bigint; bps: number; trades: number; qualified: boolean };
export type OngoingRow = { tgId: string; nickname: string; token: Address; cost: bigint; value: bigint; bps: number };
export type Prize = { prize: string; usd: number; board: "pnl" | "ongoing" };
export type Award = Prize & { tgId: string; nickname: string };

/** Biggest first: the order the prizes are handed out in, so a person placed for two keeps the bigger. */
export const PRIZES: Prize[] = [
  { prize: "best pnl", usd: 500, board: "pnl" },
  { prize: "best ongoing trade", usd: 350, board: "ongoing" },
];

/** The first competition, as announced: 2 to 9 October 2026, noon UTC to noon UTC, 0.0005 ETH a trade, five trades. */
export const FIRST_COMPETITION: ScoreRules = { start: new Date("2026-10-02T12:00:00Z"), end: new Date("2026-10-09T12:00:00Z"), minWei: 500_000_000_000_000n, minTrades: 5 };

const bps = (gain: bigint, cost: bigint): number => (cost === 0n ? 0 : Number((gain * 10_000n) / cost));
const share = (whole: bigint, part: bigint, of: bigint): bigint => (of === 0n ? 0n : (whole * part) / of);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** The trades that count: settled, landed, in the window, at least the minimum by their ETH. */
export const countedTrades = (trades: BotTrade[], r: ScoreRules): BotTrade[] =>
  trades.filter((t) => {
    const at = new Date(t.at).getTime();
    if (t.units === null || t.units === 0n || at < r.start.getTime() || at >= r.end.getTime()) return false;
    return (t.side === "buy" ? t.ethWei : t.ethOut ?? 0n) >= r.minWei;
  });

type Book = { token: Address; ethIn: bigint; unitsIn: bigint; unitsOut: bigint; ethOut: bigint };

const books = (trades: BotTrade[]): Book[] => {
  const by = new Map<string, Book>();
  for (const t of trades) {
    const b = by.get(t.token) ?? { token: t.token, ethIn: 0n, unitsIn: 0n, unitsOut: 0n, ethOut: 0n };
    if (t.side === "buy") { b.ethIn += t.ethWei; b.unitsIn += t.units!; } else { b.unitsOut += t.units!; b.ethOut += t.ethOut ?? 0n; }
    by.set(t.token, b);
  }
  return [...by.values()];
};

/** One token's part of the wallet: what the window's buys cost, what came back for their units, and what is still open. */
const settleBook = (b: Book, h: Holding | undefined) => {
  const sold = min(b.unitsOut, b.unitsIn);
  const open = min(h?.held ?? 0n, b.unitsIn - sold);
  const openValue = share(h?.exitWei ?? 0n, open, h?.held ?? 0n);
  return { back: share(b.ethOut, sold, b.unitsOut) + openValue, open, openValue, openCost: share(b.ethIn, open, b.unitsIn) };
};

export const scoreEntrant = (e: Entrant, r: ScoreRules): { pnl: PnlRow; ongoing: OngoingRow[] } => {
  const trades = countedTrades(e.trades, r);
  let spent = 0n, back = 0n;
  const ongoing: OngoingRow[] = [];
  for (const b of books(trades)) {
    const s = settleBook(b, e.holdings.get(b.token));
    spent += b.ethIn; back += s.back;
    if (s.open > 0n && s.openCost >= r.minWei) ongoing.push({ tgId: e.tgId, nickname: e.nickname, token: b.token, cost: s.openCost, value: s.openValue, bps: bps(s.openValue - s.openCost, s.openCost) });
  }
  const qualified = trades.length >= r.minTrades && spent > 0n;
  return { pnl: { tgId: e.tgId, nickname: e.nickname, spent, back, bps: bps(back - spent, spent), trades: trades.length, qualified }, ongoing };
};

/** Both boards, best first, and the prizes; `excluded` (team, an earlier winner such as break it) are scored but never awarded. */
export const scoreCompetition = (entrants: Entrant[], r: ScoreRules, excluded: Set<string> = new Set()) => {
  const scored = entrants.map((e) => scoreEntrant(e, r));
  const pnl = scored.map((s) => s.pnl).filter((p) => p.qualified).sort((a, b) => b.bps - a.bps || Number(b.spent - a.spent));
  const ongoing = scored.flatMap((s) => s.ongoing).sort((a, b) => b.bps - a.bps || Number(b.cost - a.cost));
  const taken = new Set(excluded);
  const awards: Award[] = [];
  for (const p of PRIZES) {
    const winner = (p.board === "pnl" ? pnl : ongoing).find((row) => !taken.has(row.tgId));
    if (!winner) continue;
    taken.add(winner.tgId);
    awards.push({ ...p, tgId: winner.tgId, nickname: winner.nickname });
  }
  return { pnl, ongoing, awards };
};
