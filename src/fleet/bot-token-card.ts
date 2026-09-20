/**
 * The token plate: the token card drawn as a picture, so the partners' marks
 * can sit on it. Telegram text carries no images, and the two partner lines
 * (orus's safety read, HEY's builder record) read better under their own
 * marks than as bare words. The plate holds what the caption holds, no more:
 * the symbol, the price and the pool, the two partner reads, the chain and
 * the mode. Numbers are the bot's own reads; a partner that did not answer
 * is drawn as "no read right now", never as a clean bill.
 *
 * Drawn like the share card: an SVG over an ink ground, set in IBM Plex
 * from landing/public/bot/fonts, rendered by resvg. The marks are PNGs in
 * landing/public/bot/partners (their public avatars, used with attribution
 * as the two deals say), read once and embedded as data URIs.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HeyScan } from "./bot-hey.js";
import type { OrusScan } from "./bot-orus.js";

export type TokenPlate = {
  symbol: string;
  address: string;
  /** Tokens per ETH, already formatted. */
  perEth: string;
  /** The pool's ETH side, already formatted. */
  poolEth: string;
  hooked: boolean;
  chainLabel: string;
  testnet: boolean;
  /** undefined: the scanner is not configured; null: it did not answer. */
  orus?: OrusScan | null;
  hey?: HeyScan | null;
};

const INK = "#171513", PAPER = "#F5EFE5", CORAL = "#FF5A3C", MUTED = "#8C8479", GREEN = "#4BD37B", LIME = "#CCFD04";
export const PLATE_WIDTH = 1344, PLATE_HEIGHT = 600;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

/** The safety read in words, the same facts the caption's orus line carries, without the link. */
export const orusPlateLine = (scan: OrusScan | null | undefined): { verdict: string; colour: string; detail: string } => {
  if (scan === undefined) return { verdict: "not configured", colour: MUTED, detail: "" };
  if (scan === null) return { verdict: "no read right now", colour: MUTED, detail: "orus did not answer; unknown is not safe" };
  const verdict = scan.honeypot === null ? "honeypot unknown" : scan.honeypot ? "honeypot" : "no honeypot";
  const colour = scan.honeypot === null ? MUTED : scan.honeypot ? CORAL : GREEN;
  const parts: string[] = [];
  if (scan.buyTaxPct !== null || scan.sellTaxPct !== null) parts.push(`tax ${scan.buyTaxPct ?? "?"}/${scan.sellTaxPct ?? "?"}`);
  if (scan.bundlersPct !== null) parts.push(`bundled ${pct(scan.bundlersPct)}`);
  if (scan.top10Pct !== null) parts.push(`top 10 hold ${pct(scan.top10Pct)}`);
  if (scan.holders !== null) parts.push(`${Math.round(scan.holders).toLocaleString("en-US")} holders`);
  return { verdict, colour, detail: parts.join(" · ") };
};

/** The builder read in words: status first, then the thirty-day counts, then the flag. Missing fields are left out, never zeroed. */
export const heyPlateLine = (scan: HeyScan | null | undefined): { verdict: string; colour: string; detail: string } => {
  if (scan === undefined) return { verdict: "not configured", colour: MUTED, detail: "" };
  if (scan === null) return { verdict: "no record", colour: MUTED, detail: "hey has nothing on this token; missing is unknown, not zero" };
  const verdict = scan.statusLabel ? scan.statusLabel.toLowerCase() : "unknown status";
  const colour = scan.statusLabel?.toLowerCase() === "shipping" ? GREEN : scan.statusLabel ? PAPER : MUTED;
  const parts: string[] = [];
  const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  if (scan.commits30d !== null) parts.push(count(scan.commits30d, "commit", "commits"));
  if (scan.releases30d !== null) parts.push(count(scan.releases30d, "release", "releases"));
  if (scan.ships30d !== null) parts.push(count(scan.ships30d, "ship", "ships"));
  if (scan.verifiedBuilder === true) parts.push("verified builder");
  return { verdict, colour, detail: parts.length ? parts.join(" · ") + " · last 30 days" : "" };
};

export type PlateMarks = { orus?: string; hey?: string };

/** One partner row: the mark in a rounded tile, the partner's name, the verdict in its colour, the detail under it. */
const partnerRow = (y: number, mark: string | undefined, name: string, tag: string, read: { verdict: string; colour: string; detail: string }, fallbackFill: string): string => {
  const x = 96;
  const tile = mark
    ? `<clipPath id="c${y}"><rect x="${x}" y="${y}" width="72" height="72" rx="18"/></clipPath><image href="${mark}" x="${x}" y="${y}" width="72" height="72" clip-path="url(#c${y})"/>`
    : `<rect x="${x}" y="${y}" width="72" height="72" rx="18" fill="${fallbackFill}"/>`;
  return `${tile}
  <text x="${x + 96}" y="${y + 24}" font-family="IBM Plex Mono" font-size="19" letter-spacing="3" fill="${MUTED}">${esc(tag.toUpperCase())}</text>
  <text x="${x + 96}" y="${y + 58}" font-family="IBM Plex Sans" font-weight="700" font-size="30"><tspan fill="${PAPER}">${esc(name)}</tspan><tspan fill="${MUTED}">  ·  </tspan><tspan fill="${read.colour}">${esc(read.verdict)}</tspan></text>
  ${read.detail ? `<text x="${x + 96}" y="${y + 92}" font-family="IBM Plex Mono" font-size="21" fill="${PAPER}" fill-opacity="0.78">${esc(read.detail)}</text>` : ""}`;
};

/** The plate as SVG. `marks` are the partners' marks as data URIs; a missing mark draws a plain tile. */
export const tokenPlateSvg = (card: TokenPlate, marks: PlateMarks = {}): string => {
  const W = PLATE_WIDTH, H = PLATE_HEIGHT;
  const orus = orusPlateLine(card.orus);
  const hey = heyPlateLine(card.hey);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="halo" cx="0.12" cy="0.2" r="0.6"><stop offset="0" stop-color="${CORAL}" stop-opacity="0.14"/><stop offset="1" stop-color="${CORAL}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${INK}"/>
  <rect width="${W}" height="${H}" fill="url(#halo)"/>
  <text x="96" y="78" font-family="IBM Plex Mono" font-size="20" letter-spacing="4"><tspan fill="${CORAL}">CHIT BOT</tspan><tspan fill="${MUTED}"> · ${esc(card.chainLabel.toUpperCase())}${card.testnet ? " · TESTNET" : " · YOUR KEYS STAY WITH YOU"}</tspan></text>
  <text x="96" y="176" font-family="IBM Plex Sans" font-weight="700" font-size="84" letter-spacing="-2" fill="${PAPER}">$${esc(card.symbol.slice(0, 12))}</text>
  <text x="96" y="226" font-family="IBM Plex Mono" font-size="24" fill="${PAPER}" xml:space="preserve"><tspan fill="${MUTED}">price </tspan><tspan>${esc(card.perEth)} ${esc(card.symbol.slice(0, 12))} per ETH</tspan><tspan fill="${MUTED}">    pool </tspan><tspan>${esc(card.poolEth)} ETH</tspan>${card.hooked ? `<tspan fill="${CORAL}">    hooked pool</tspan>` : ""}</text>
  <line x1="96" y1="262" x2="${W - 96}" y2="262" stroke="${PAPER}" stroke-opacity="0.12"/>
  ${partnerRow(292, marks.orus, "orus", "checked by", orus, LIME)}
  ${partnerRow(412, marks.hey, "hey research lab", "builder record", hey, PAPER)}
  <line x1="96" y1="${H - 62}" x2="${W - 96}" y2="${H - 62}" stroke="${PAPER}" stroke-opacity="0.12"/>
  <text x="96" y="${H - 30}" font-family="IBM Plex Mono" font-size="17" fill="${MUTED}">${esc(card.address)}</text>
  <text x="${W - 96}" y="${H - 30}" text-anchor="end" font-family="IBM Plex Mono" font-size="17" fill="${MUTED}">a partner that did not answer is unknown, never safe</text>
</svg>`;
};

export type TokenPlateRenderer = (card: TokenPlate) => Promise<Uint8Array>;

const FONTS = ["IBMPlexSans-Bold.ttf", "IBMPlexSans.ttf", "IBMPlexMono-Medium.ttf"];
const MARKS: (keyof PlateMarks)[] = ["orus", "hey"];

/** resvg over the SVG with the shipped fonts and marks; the marks are read once and a missing one draws a plain tile rather than failing the card. */
export const createTokenPlateRenderer = (assetDir = path.resolve("landing/public/bot")): TokenPlateRenderer => {
  const fontFiles = FONTS.map((f) => path.join(assetDir, "fonts", f));
  let marks: Promise<PlateMarks> | undefined;
  return async (card) => {
    const { Resvg } = await import("@resvg/resvg-js");
    marks ??= Promise.all(MARKS.map(async (m) => [m, await readFile(path.join(assetDir, "partners", `${m}.png`)).then((b) => `data:image/png;base64,${b.toString("base64")}`).catch(() => undefined)] as const))
      .then((pairs) => Object.fromEntries(pairs.filter(([, v]) => v)) as PlateMarks);
    const [loaded] = await Promise.all([marks, ...fontFiles.map((f) => readFile(f))]);
    const png = new Resvg(tokenPlateSvg(card, loaded), { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "IBM Plex Sans" } }).render().asPng();
    return new Uint8Array(png);
  };
};
