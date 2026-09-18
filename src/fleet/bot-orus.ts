/**
 * Orus on the token card: the safety line. Orus (orusagent.xyz) scans tokens
 * on Robinhood Chain (honeypot, taxes, bundlers, holders, liquidity, deployer
 * history); the bot asks it once per card draw and shows one line under the
 * price, "checked by orus", with a link to them.
 *
 * The line never blocks a card: a slow, missing or refused answer draws the
 * card without it. Answers are kept for a minute per token, misses too, so a
 * refresh spam does not spend the partner quota (30 a minute). Every figure
 * is Orus's own; a null from them reads as "unknown", never as "safe".
 *
 *   ORUS_PARTNER_API_KEY   the partner key (Authorization: Bearer); absent
 *                          means no line and no call
 *   ORUS_API_BASE          default https://www.orusagent.xyz
 */

import { createPartnerScanner } from "./bot-partner.js";
import type { Address } from "./types.js";

export type OrusScan = {
  symbol: string | null;
  honeypot: boolean | null;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  bundlersPct: number | null;
  top10Pct: number | null;
  holders: number | null;
  liquidityUsd: number | null;
  lpBurnedPct: number | null;
  marketCapUsd: number | null;
  deployerLaunches: number | null;
  checkedAt: string;
};

export type OrusScanner = {
  /** The scan, or undefined when Orus has no answer right now (unknown token, quota, outage, slow). */
  scan(token: Address): Promise<OrusScan | undefined>;
  /** Where "checked by orus" points: the token's own page on Orus. */
  link(token: Address): string;
};

export type OrusConfig = {
  apiKey: string;
  chainId: number;
  baseUrl?: string;
  /** The card waits this long for Orus and no longer. */
  timeoutMs?: number;
  /** How long an answer (or a miss) is kept per token. */
  cacheMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
};

const DEFAULT_BASE = "https://www.orusagent.xyz";
/** Orus scans Robinhood Chain mainnet only; elsewhere the scanner keeps quiet and spends nothing. */
const SUPPORTED_CHAINS = new Set([4663]);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** Orus's answer reduced to what the card says. Unknown fields stay null. */
export const readScan = (body: unknown): OrusScan | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const j = body as Record<string, Record<string, unknown> | undefined>;
  const token = j.token ?? {}, market = j.market ?? {}, security = j.security ?? {}, risk = j.risk ?? {}, deployer = j.deployer ?? {};
  if (typeof token.address !== "string") return undefined;
  return {
    symbol: typeof token.symbol === "string" ? token.symbol : null,
    honeypot: bool(security.isHoneypot),
    buyTaxPct: num(security.buyTaxPct),
    sellTaxPct: num(security.sellTaxPct),
    bundlersPct: num(risk.bundlersPct),
    top10Pct: num(risk.top10Pct),
    holders: num(risk.holdersCount),
    liquidityUsd: num(market.liquidityUsd),
    lpBurnedPct: num(security.liquidityBurnPct),
    marketCapUsd: num(market.marketCapUsd),
    deployerLaunches: num(deployer.launches),
    checkedAt: typeof j.checkedAt === "string" ? (j.checkedAt as string) : new Date().toISOString(),
  };
};

const usd = (v: number): string => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}m` : v >= 1_000 ? `$${Math.round(v / 1_000)}k` : `$${Math.round(v)}`);
const pct = (v: number): string => `${v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)}%`;

/**
 * The line as the card shows it. Facts in the order a degen reads them:
 * honeypot, taxes, bundlers, top holders, holders, liquidity, deployer.
 * Nothing is inferred: a null is "unknown", and a clean scan still says
 * what was checked rather than "safe".
 */
export const orusLine = (scan: OrusScan, link: string): string => {
  const parts: string[] = [];
  parts.push(scan.honeypot === null ? "honeypot unknown" : scan.honeypot ? "⚠️ honeypot" : "no honeypot");
  if (scan.buyTaxPct !== null || scan.sellTaxPct !== null) parts.push(`tax ${scan.buyTaxPct ?? "?"}/${scan.sellTaxPct ?? "?"}`);
  if (scan.bundlersPct !== null) parts.push(`bundled ${pct(scan.bundlersPct)}`);
  if (scan.top10Pct !== null) parts.push(`top 10 hold ${pct(scan.top10Pct)}`);
  if (scan.holders !== null) parts.push(`${Math.round(scan.holders).toLocaleString("en-US")} holders`);
  if (scan.liquidityUsd !== null) parts.push(`liq ${usd(scan.liquidityUsd)}${scan.lpBurnedPct !== null && scan.lpBurnedPct >= 99 ? ", burned" : ""}`);
  if (scan.deployerLaunches !== null) parts.push(`deployer ${scan.deployerLaunches} launch${scan.deployerLaunches === 1 ? "" : "es"}`);
  return `${parts.join(" · ")} · <a href="${link}">checked by orus</a>`;
};

export const createOrusScanner = (config: OrusConfig): OrusScanner => {
  const base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const doFetch = config.fetch ?? fetch;
  const inner = createPartnerScanner<OrusScan>({
    name: "orus",
    chainId: config.chainId,
    supportedChains: [...SUPPORTED_CHAINS],
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.cacheMs !== undefined ? { cacheMs: config.cacheMs } : {}),
    ...(config.now ? { now: config.now } : {}),
    ask: async (token, signal) => {
      const url = `${base}/api/v1/scan?chainId=${config.chainId}&token=${token.toLowerCase()}&include=none`;
      const r = await doFetch(url, { headers: { authorization: `Bearer ${config.apiKey}`, accept: "application/json" }, signal });
      if (!r.ok) {
        // 404 is a token Orus has not indexed: silence, not an error. The rest is worth a line in the log.
        if (r.status !== 404) console.warn(`orus scan ${r.status} for ${token}`);
        return undefined;
      }
      return readScan(await r.json());
    },
  });
  return {
    scan: (token) => inner.scan(token),
    link(token) {
      // Orus's token page, /token/<chainId>/<address> (their words, 17 September: simple for now, being worked on).
      return `${base}/token/${config.chainId}/${token.toLowerCase()}`;
    },
  };
};
