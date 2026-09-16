/**
 * The share card: one picture of a position, the kind people post when a
 * trade went their way, with the poster's referral link on it so the next
 * person lands in the bot. The plate is the chit mark torn along its seam,
 * the two halves pushed to the edges (landing/public/bot/share-bg.png); the
 * numbers sit in the dark between them. Text is set in IBM Plex from
 * landing/public/bot/fonts, so the host and one machine draw the same card.
 *
 * Every number on the card is what the bot read: the position's cost from
 * the trades it made, its value from the pool's fill right now. The card
 * says which chain, and says "testnet" when it is the playground.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export type ShareCard = {
  symbol: string;
  /** What was paid for what is held, in ETH, net of what sales returned. */
  costEth: number;
  /** What the position would fetch now, in ETH. */
  valueEth: number;
  /** Tokens held, already formatted. */
  held: string;
  chainLabel: string;
  testnet: boolean;
  refLink: string;
};

const INK = "#171513", PAPER = "#F5EFE5", CORAL = "#FF5A3C", MUTED = "#8C8479", GREEN = "#4BD37B";
/** The plate's own size; the card is drawn over it one to one. */
export const CARD_WIDTH = 1344, CARD_HEIGHT = 752;
const MID = CARD_WIDTH / 2;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Four significant figures under 1 ETH, three decimals above: 0.00198 stays 0.00198, 1.1368 reads 1.137. */
const fmtEth = (n: number): string => (n >= 1 ? n.toFixed(3) : n > 0 ? Number(n.toPrecision(4)).toString() : "0").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

/** The number that matters biggest, in the clear middle of the plate; everything else quiet. `plate` is the background as a data URI, or none for a plain ink ground. */
export const shareCardSvg = (card: ShareCard, plate?: string): string => {
  const pnl = card.valueEth - card.costEth;
  const pct = card.costEth > 0 ? (pnl / card.costEth) * 100 : null;
  const up = pnl >= 0;
  const big = pct === null ? "free ride" : `${up ? "+" : ""}${pct.toFixed(1)}%`;
  const colour = up ? GREEN : CORAL;
  const W = CARD_WIDTH, H = CARD_HEIGHT;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="halo" cx="0.5" cy="0.62" r="0.42"><stop offset="0" stop-color="${colour}" stop-opacity="0.16"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${INK}"/>
  ${plate ? `<image href="${plate}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>` : ""}
  <rect width="${W}" height="${H}" fill="url(#halo)"/>
  <text x="${MID}" y="88" text-anchor="middle" font-family="IBM Plex Mono" font-size="22" letter-spacing="4"><tspan fill="${CORAL}">CHIT BOT</tspan><tspan fill="${MUTED}"> · ${esc(card.chainLabel.toUpperCase())}${card.testnet ? " · TESTNET" : ""}</tspan></text>
  <text x="${MID}" y="236" text-anchor="middle" font-family="IBM Plex Sans" font-weight="700" font-size="76" fill="${PAPER}">$${esc(card.symbol.slice(0, 9))}</text>
  <text x="${MID}" y="500" text-anchor="middle" font-family="IBM Plex Sans" font-weight="700" font-size="196" letter-spacing="-8" fill="${colour}">${esc(big)}</text>
  <text x="${MID}" y="574" text-anchor="middle" font-family="IBM Plex Mono" font-size="30" fill="${PAPER}">${card.costEth > 0 ? `in ${fmtEth(card.costEth)} ETH` : "cost already back out"} · now ${fmtEth(card.valueEth)} ETH · ${esc(card.held)} ${esc(card.symbol)}</text>
  <text x="${MID}" y="610" text-anchor="middle" font-family="IBM Plex Mono" font-size="19" fill="${MUTED}">value is the pool's fill for the whole position right now, fee and impact included</text>
  <line x1="${MID - 360}" y1="650" x2="${MID + 360}" y2="650" stroke="${PAPER}" stroke-opacity="0.14"/>
  <text x="${MID}" y="698" text-anchor="middle" font-family="IBM Plex Mono" font-size="28"><tspan fill="${PAPER}" font-family="IBM Plex Sans">trade it yourself  </tspan><tspan fill="${CORAL}">${esc(card.refLink)}</tspan></text>
  ${card.testnet ? `<text x="${MID}" y="734" text-anchor="middle" font-family="IBM Plex Mono" font-size="17" fill="${MUTED}">test eth, test tokens, nothing real. the playground before mainnet.</text>` : ""}
</svg>`;
};

export type ShareRenderer = (card: ShareCard) => Promise<Uint8Array>;

const FONTS = ["IBMPlexSans-Bold.ttf", "IBMPlexSans.ttf", "IBMPlexMono-Medium.ttf"];

/** resvg over the SVG with the shipped plate and fonts; read once, drawn per card. */
export const createShareRenderer = (assetDir = path.resolve("landing/public/bot")): ShareRenderer => {
  const fontFiles = FONTS.map((f) => path.join(assetDir, "fonts", f));
  let plate: Promise<string> | undefined;
  return async (card) => {
    const { Resvg } = await import("@resvg/resvg-js");
    // The plate and the fonts must exist where the function runs; a missing file is a clear error, not a card in a fallback face.
    plate ??= readFile(path.join(assetDir, "share-bg.png")).then((b) => `data:image/png;base64,${b.toString("base64")}`).catch((e: unknown) => { plate = undefined; throw e; });
    const [bg] = await Promise.all([plate, ...fontFiles.map((f) => readFile(f))]);
    const png = new Resvg(shareCardSvg(card, bg), { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "IBM Plex Sans" } }).render().asPng();
    return new Uint8Array(png);
  };
};
