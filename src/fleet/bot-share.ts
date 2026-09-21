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
  /** The partners' lines as plain text ("orus: …", "hey research lab: …"), at most two, each cut to fit the plate; none when nothing answered. */
  partners?: string[];
};

/** Fits a partner line to the plate: plain text, one line, the tail dropped with an ellipsis. */
export const partnerLine = (label: string, html: string, max = 100): string => {
  const plain = html.replace(/<[^>]+>/g, "").replace(/\s+·\s+(checked by orus|see on HEY)\s*$/i, "").replace(/\s+/g, " ").trim();
  const line = `${label}: ${plain}`;
  if (line.length <= max) return line;
  // Cut at a whole segment (the " · " joins), never mid-fact.
  const cut = line.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(" · ")).trimEnd() + " …";
};

const INK = "#171513", PAPER = "#F5EFE5", CORAL = "#FF5A3C", MUTED = "#8C8479", GREEN = "#4BD37B", SOFT = "#DED6CA";
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
  // With partner lines under the figures, the rule and the footer move down to make room; without them the card is as it was.
  const partners = (card.partners ?? []).slice(0, 2);
  const rule = partners.length ? 646 + partners.length * 26 : 650;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="halo" cx="0.5" cy="0.62" r="0.42"><stop offset="0" stop-color="${colour}" stop-opacity="0.16"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${INK}"/>
  ${plate ? `<image href="${plate}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>` : ""}
  <rect width="${W}" height="${H}" fill="url(#halo)"/>
  <g transform="translate(${MID - 22} 26) scale(0.6875)" aria-hidden="true">
    <rect width="64" height="64" rx="14" fill="${INK}"/>
    <path fill="${CORAL}" d="M14 14h36l4 4v28l-4 4H14l-4-4V18l4-4Z"/>
    <path fill="${INK}" d="M28 14h8v9l-4 4 4 5-4 5 4 4v9h-8v-7l-4-6 4-5-4-5 4-6v-7Z"/>
  </g>
  <text x="${MID}" y="104" text-anchor="middle" font-family="IBM Plex Mono" font-size="22" letter-spacing="4"><tspan fill="${CORAL}">CHIT BOT</tspan><tspan fill="${MUTED}"> · ${esc(card.chainLabel.toUpperCase())}${card.testnet ? " · TESTNET" : ""}</tspan></text>
  <text x="${MID}" y="236" text-anchor="middle" font-family="IBM Plex Sans" font-weight="700" font-size="76" fill="${PAPER}">$${esc(card.symbol.slice(0, 9))}</text>
  <text x="${MID}" y="500" text-anchor="middle" font-family="IBM Plex Sans" font-weight="700" font-size="196" letter-spacing="-8" fill="${colour}">${esc(big)}</text>
  <text x="${MID}" y="574" text-anchor="middle" font-family="IBM Plex Mono" font-size="30" fill="${PAPER}">${card.costEth > 0 ? `in ${fmtEth(card.costEth)} ETH` : "cost already back out"} · now ${fmtEth(card.valueEth)} ETH · ${esc(card.held)} ${esc(card.symbol)}</text>
  <text x="${MID}" y="610" text-anchor="middle" font-family="IBM Plex Mono" font-size="19" fill="${MUTED}">value is the pool's fill for the whole position right now, fee and impact included</text>
  ${partners.map((line, i) => `<text x="${MID}" y="${638 + i * 26}" text-anchor="middle" font-family="IBM Plex Mono" font-size="18"><tspan fill="${CORAL}">${esc(line.slice(0, line.indexOf(":") + 1))}</tspan><tspan fill="${SOFT}">${esc(line.slice(line.indexOf(":") + 1))}</tspan></text>`).join("")}
  <line x1="${MID - 360}" y1="${rule}" x2="${MID + 360}" y2="${rule}" stroke="${PAPER}" stroke-opacity="0.14"/>
  <text x="${MID}" y="${rule + (partners.length ? 36 : 48)}" text-anchor="middle" font-family="IBM Plex Mono" font-size="${partners.length ? 24 : 28}"><tspan fill="${PAPER}" font-family="IBM Plex Sans">trade it yourself  </tspan><tspan fill="${CORAL}">${esc(card.refLink)}</tspan></text>
  ${card.testnet && !partners.length ? `<text x="${MID}" y="734" text-anchor="middle" font-family="IBM Plex Mono" font-size="17" fill="${MUTED}">test eth, test tokens, nothing real. the playground before mainnet.</text>` : ""}
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
