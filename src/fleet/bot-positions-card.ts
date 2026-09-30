/**
 * 📊 Positions on the mainnet bot (2026-10-01): what the session account
 * holds of every token the bot has traded for it, what selling it now would
 * return, and the P&L against the average price the bot's buys paid
 * (bot-positions.ts). In ETH, or in dollars at a price the caller passes.
 */
import type { BotChain } from "./bot-chain.js";
import { costBasis, positionRow, settleTrades, type PositionLedger, type TradeSettler } from "./bot-positions.js";
import type { Address } from "./types.js";

export type PositionsView = { unit: "eth" | "usd"; usdPerEth?: number };
export type PositionsParts = { ledger: PositionLedger; settle?: TradeSettler; reads: Pick<BotChain, "tokenInfo" | "tokenBalance" | "quoteSell" | "ethBalance"> };

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const units = (v: bigint, decimals: number, places: number): string => {
  const neg = v < 0n; const u = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const frac = (u % base).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return `${neg ? "-" : ""}${(u / base).toString()}${frac ? "." + frac : ""}`;
};
const usd = (n: number): string => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** An ETH amount in the view's unit; `signed` puts + or - in front. */
const money = (wei: bigint, view: PositionsView, signed = false): string => {
  const sign = signed ? (wei < 0n ? "-" : "+") : wei < 0n ? "-" : "";
  const abs = wei < 0n ? -wei : wei;
  if (view.unit === "usd" && view.usdPerEth !== undefined) return `${sign}${usd((Number(abs) / 1e18) * view.usdPerEth)}`;
  return `${sign}${units(abs, 18, 6)} ETH`;
};
const pct = (pnl: bigint, cost: bigint): string => (cost === 0n ? "" : ` (${pnl < 0n ? "" : "+"}${Math.round((Number(pnl) / Number(cost)) * 100)}%)`);

export const positionsCard = async (d: PositionsParts, account: Address, view: PositionsView): Promise<{ text: string; tokens: { token: Address; symbol: string }[] }> => {
  const trades = d.settle ? await settleTrades(d.ledger, d.settle, await d.ledger.forAccount(account)) : await d.ledger.forAccount(account);
  const bases = costBasis(trades);
  const known = new Set(bases.map((b) => b.token.toLowerCase()));
  for (const t of trades) if (!known.has(t.token.toLowerCase())) { known.add(t.token.toLowerCase()); bases.push({ token: t.token, ethIn: 0n, unitsIn: 0n, unitsOut: 0n }); }
  const read = await Promise.all(bases.map(async (b) => {
    const held = await d.reads.tokenBalance(b.token, account);
    if (held === 0n) return undefined;
    const [info, value] = await Promise.all([d.reads.tokenInfo(b.token), d.reads.quoteSell(b.token, held)]);
    return { info, row: positionRow(b, held, value ?? 0n) };
  }));
  const rows = read.filter((r): r is NonNullable<typeof r> => r !== undefined);
  const cash = await d.reads.ethBalance(account);
  const head = `📊 <b>your positions</b> · account <code>${short(account)}</code>`;
  if (rows.length === 0) return { text: [head, "", "no positions yet. paste a token's contract address to see its card and buy."].join("\n"), tokens: [] };
  const lines = rows.map(({ info, row }) => {
    const pnl = row.pnl === null || row.cost === null ? "cost unknown" : `P&amp;L <code>${money(row.pnl, view, true)}</code>${pct(row.pnl, row.cost)}`;
    return `<b>${info.symbol}</b> <code>${units(row.held, info.decimals, 4)}</code> · ≈ <code>${money(row.value, view)}</code> · ${pnl}`;
  });
  const value = rows.reduce((s, r) => s + r.row.value, 0n);
  const costed = rows.filter((r) => r.row.pnl !== null);
  const pnl = costed.reduce((s, r) => s + r.row.pnl!, 0n);
  const total = `total ≈ <code>${money(value, view)}</code>${costed.length ? ` · P&amp;L <code>${money(pnl, view, true)}</code>` : ""} · plus <code>${money(cash, view)}</code> in the account`;
  const note = view.unit === "usd" && view.usdPerEth !== undefined
    ? `<i>values are what selling now would return, after the pool's fee, at <code>${usd(view.usdPerEth)}</code> per ETH. P&amp;L is against the average price your buys through the bot paid.</i>`
    : "<i>values are what selling now would return, after the pool's fee. P&amp;L is against the average price your buys through the bot paid.</i>";
  return { text: [head, "", ...lines, "", total, note].join("\n"), tokens: rows.map(({ info, row }) => ({ token: row.token, symbol: info.symbol })) };
};
