/**
 * The competition board: one fetch of /api/comp/board, drawn as two lists
 * and a clock. Nothing here reads a wallet or the chain; the figures are the
 * route's, and the route's are the scoring's.
 */

import { initHeaderWallet, initShell } from "./fleet/page-shared.js";

initHeaderWallet();
initShell({ pill: false });

type Row = { nickname: string; pct: number; trades: number; qualified: boolean };
type OpenRow = { nickname: string; symbol: string; pct: number };
type Board = {
  asOf: string; start: string; end: string; ended: boolean; minEth: string; minTrades: number;
  entrants: number; trades: number; pnl: Row[]; ongoing: OpenRow[];
  awards?: { prize: string; usd: number; nickname: string }[]; stale?: boolean;
};

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: ${id}`);
  return node;
};

const signed = (pct: number): string => `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
const utc = (iso: string): string => iso.slice(0, 16).replace("T", " ") + " UTC";

/** "ends in 2d 4h", "starts in 3h 10m", or "ended": whole units, the two largest. */
export const countdown = (now: Date, start: Date, end: Date): string => {
  const until = (to: Date): string => {
    const s = Math.max(0, Math.floor((to.getTime() - now.getTime()) / 1000));
    const parts = [[Math.floor(s / 86_400), "d"], [Math.floor((s % 86_400) / 3600), "h"], [Math.floor((s % 3600) / 60), "m"]] as const;
    const shown = parts.filter(([n]) => n > 0).slice(0, 2);
    return shown.length ? shown.map(([n, u]) => `${n}${u}`).join(" ") : "under a minute";
  };
  if (now < start) return `starts in ${until(start)}`;
  if (now < end) return `ends in ${until(end)}`;
  return "ended";
};

const li = (rank: number, name: string, figure: string, note?: string, muted = false): HTMLLIElement => {
  const item = document.createElement("li");
  item.className = muted ? "board-row board-row--pending" : "board-row";
  item.innerHTML = `<span class="board-row__rank">${rank}</span><span class="board-row__name"></span><span class="board-row__figure"></span>${note ? `<span class="board-row__note"></span>` : ""}`;
  (item.querySelector(".board-row__name") as HTMLElement).textContent = name;
  const fig = item.querySelector(".board-row__figure") as HTMLElement;
  fig.textContent = figure;
  if (note) (item.querySelector(".board-row__note") as HTMLElement).textContent = note;
  return item;
};

const draw = (b: Board): void => {
  const now = new Date();
  el("clock").textContent = `${countdown(now, new Date(b.start), new Date(b.end))} · ${utc(b.start)} to ${utc(b.end)}`;
  el("stat-entrants").textContent = String(b.entrants);
  el("stat-trades").textContent = String(b.trades);
  el("stat-asof").textContent = utc(b.asOf);
  el("stale").hidden = !b.stale;
  el("rule-min").textContent = b.minEth;
  el("rule-trades").textContent = String(b.minTrades);

  const pnl = el("pnl-list");
  pnl.replaceChildren(...b.pnl.map((r, i) => li(i + 1, r.nickname, signed(r.pct), r.qualified ? `${r.trades} trades` : `${r.trades}/${b.minTrades} trades, not ranked yet`, !r.qualified)));
  el("pnl-empty").hidden = b.pnl.length > 0;

  const open = el("open-list");
  open.replaceChildren(...b.ongoing.map((r, i) => li(i + 1, r.nickname, signed(r.pct), r.symbol)));
  el("open-empty").hidden = b.ongoing.length > 0;

  if (b.ended && b.awards) {
    el("awards-list").replaceChildren(...b.awards.map((a, i) => li(i + 1, a.nickname, `$${a.usd}`, a.prize)));
    el("awards").hidden = false;
    el("pnl-h").textContent = "Final standings";
  }
};

const load = async (): Promise<void> => {
  try {
    const res = await fetch("/api/comp/board", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`board ${res.status}`);
    draw((await res.json()) as Board);
  } catch {
    el("clock").textContent = "The board is not answering right now. Refresh in a minute.";
  }
};

void load();
// The clock and the figures both move: once a minute is enough for either.
setInterval(() => void load(), 60_000);
