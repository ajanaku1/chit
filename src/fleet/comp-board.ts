/**
 * The competition's live board (2026-10-04): what /app/board and the bot's
 * /board show while it runs, and the result once it has ended. The same
 * scoring as the final run (comp-score.ts), over the same stores, with open
 * holdings at what selling them returns now; so mid-week it is "if it ended
 * now", and the page says so. Nicknames only: no wallet, no Telegram id
 * leaves this module.
 */
import type { BotChain } from "./bot-chain.js";
import type { CompEntry, CompStore } from "./bot-comp.js";
import type { BotLinkStore } from "./bot-link.js";
import { settleTrades, type PositionLedger, type TradeSettler } from "./bot-positions.js";
import { PRIZES, scoreCompetition, scoreEntrant, type Entrant, type Holding, type ScoreRules } from "./comp-score.js";
import type { Address } from "./types.js";

export type BoardDeps = {
  entries: CompStore;
  links: BotLinkStore;
  ledger: PositionLedger;
  settle: TradeSettler;
  reads: Pick<BotChain, "chainId" | "tokenBalance" | "quoteSell" | "tokenInfo">;
  rules: ScoreRules;
  /** Telegram ids scored but never placed or awarded: the team, the break-it winner. */
  excluded?: Set<string>;
};

export type BoardRow = { nickname: string; pct: number; trades: number; qualified: boolean };
export type OngoingBoardRow = { nickname: string; symbol: string; pct: number };
export type Board = {
  asOf: string;
  start: string;
  end: string;
  ended: boolean;
  minEth: string;
  minTrades: number;
  entrants: number;
  trades: number;
  pnl: BoardRow[];
  ongoing: OngoingBoardRow[];
  prizes: { prize: string; usd: number }[];
  /** Set once the window has closed: the awards, by nickname. */
  awards?: { prize: string; usd: number; nickname: string }[];
};

const pct = (bps: number): number => Math.round(bps) / 100;
const eth = (wei: bigint): string => { const s = wei.toString().padStart(19, "0"); return `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, "") || "0"; };

/** Each open token's balance in the account and what selling all of it returns now. */
const holdingsOf = async (reads: BoardDeps["reads"], account: Address, tokens: Address[]): Promise<Map<string, Holding>> => {
  const out = new Map<string, Holding>();
  for (const token of tokens) {
    const held = await reads.tokenBalance(token, account).catch(() => 0n);
    const exitWei = held === 0n ? 0n : (await reads.quoteSell(token, held).catch(() => null)) ?? 0n;
    out.set(token, { held, exitWei });
  }
  return out;
};

/** The entrants with a linked account on this chain, their trades settled, their holdings valued. */
export const loadEntrants = async (d: BoardDeps, entries: CompEntry[]): Promise<Entrant[]> => {
  const entrants: Entrant[] = [];
  for (const e of entries) {
    const link = await d.links.getLink(e.tgId);
    if (!link || link.chainId !== d.reads.chainId) continue;
    const trades = await settleTrades(d.ledger, d.settle, await d.ledger.forAccount(link.account));
    const tokens = [...new Set(trades.filter((t) => t.side === "buy").map((t) => t.token))];
    entrants.push({ tgId: e.tgId, nickname: e.nickname, trades, holdings: await holdingsOf(d.reads, link.account, tokens) });
  }
  return entrants;
};

export const buildBoard = async (d: BoardDeps, now: Date): Promise<Board> => {
  const entries = await d.entries.all();
  const entrants = await loadEntrants(d, entries);
  const excluded = d.excluded ?? new Set<string>();
  const placed = entrants.filter((e) => !excluded.has(e.tgId));
  const scored = placed.map((e) => scoreEntrant(e, d.rules));
  // Everyone with a counted trade is on the board, the unqualified too, so a newcomer sees their own progress to five.
  const pnl = scored.map((s) => s.pnl).filter((p) => p.trades > 0).sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.bps - a.bps || Number(b.spent - a.spent));
  const ongoing = scored.flatMap((s) => s.ongoing).sort((a, b) => b.bps - a.bps || Number(b.cost - a.cost)).slice(0, 10);
  const symbols = new Map<string, string>();
  for (const o of ongoing) if (!symbols.has(o.token)) symbols.set(o.token, await d.reads.tokenInfo(o.token).then((i) => i.symbol).catch(() => `${o.token.slice(0, 6)}…`));
  const ended = now.getTime() >= d.rules.end.getTime();
  const count = entries.filter((e) => !excluded.has(e.tgId)).length;
  return {
    asOf: now.toISOString(), start: d.rules.start.toISOString(), end: d.rules.end.toISOString(), ended,
    minEth: eth(d.rules.minWei), minTrades: d.rules.minTrades,
    entrants: count, trades: scored.reduce((n, s) => n + s.pnl.trades, 0),
    pnl: pnl.map((p) => ({ nickname: p.nickname, pct: pct(p.bps), trades: p.trades, qualified: p.qualified })),
    ongoing: ongoing.map((o) => ({ nickname: o.nickname, symbol: symbols.get(o.token) ?? "", pct: pct(o.bps) })),
    prizes: PRIZES.map((p) => ({ prize: p.prize, usd: p.usd })),
    ...(ended ? { awards: scoreCompetition(entrants, d.rules, excluded).awards.map((a) => ({ prize: a.prize, usd: a.usd, nickname: a.nickname })) } : {}),
  };
};
