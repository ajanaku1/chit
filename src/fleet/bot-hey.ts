/**
 * Hey Research Lab on the token card: the builder line. HEY (heyresearch.xyz)
 * records public, source-backed activity behind a token's project on
 * Robinhood Chain: commits, releases, ships, whether the builder is
 * verified, and a status ("Shipping", "Still Building", ...). The bot asks
 * once per card draw and shows one line, "see on HEY", linking to the
 * project's page there.
 *
 * Their three rules, kept here: found:false prints nothing (a token they
 * have no page for, or any chain but 4663); a missing field is skipped,
 * missing means unknown, not zero; 400 is a malformed address, 401 a bad
 * key, 429 slow down. A pure database read, about 200 ms, cached 60 s on
 * their side and a minute per token on ours.
 *
 *   HEY_API_KEY   a key from heyresearch.xyz/account (higher rate limit);
 *                 without one the bot asks anonymously (120 a minute)
 *   BOT_HEY_OFF   1 hides the line and stops the asks
 *   HEY_API_BASE  default https://heyresearch.xyz
 */

import { createPartnerScanner } from "./bot-partner.js";
import type { Address } from "./types.js";

export type HeyScan = {
  statusLabel: string | null;
  verifiedBuilder: boolean | null;
  commits30d: number | null;
  releases30d: number | null;
  ships30d: number | null;
  lastShip: string | null;
  projectName: string | null;
  /** Where the arrow goes: their cta.url, else project_url. */
  url: string;
};

export type HeyScanner = { scan(token: Address): Promise<HeyScan | undefined> };

export type HeyConfig = {
  chainId: number;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  cacheMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
};

const DEFAULT_BASE = "https://heyresearch.xyz";
/** HEY indexes Robinhood Chain mainnet only; elsewhere the scanner keeps quiet and spends nothing. */
const SUPPORTED_CHAINS = [4663];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** HEY's answer reduced to what the card says; undefined when they have no page for the token. */
export const readHey = (body: unknown): HeyScan | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const j = body as Record<string, unknown>;
  if (j.found !== true) return undefined;
  const activity = (j.activity ?? {}) as Record<string, unknown>;
  const cta = (j.cta ?? {}) as Record<string, unknown>;
  const project = (j.project ?? {}) as Record<string, unknown>;
  const url = str(cta.url) ?? str(j.project_url);
  if (!url) return undefined;
  return {
    statusLabel: str(j.status_label),
    verifiedBuilder: typeof j.verified_builder === "boolean" ? j.verified_builder : null,
    commits30d: num(activity.commits_30d),
    releases30d: num(activity.releases_30d),
    ships30d: num(activity.ships_30d),
    lastShip: str(activity.last_ship),
    projectName: str(project.name),
    url,
  };
};

const count = (n: number, one: string, many: string): string => `${Math.round(n).toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * The line as the card shows it, HEY's own format: status, commits,
 * releases, verified builder, the arrow. A missing field is left out, it
 * means they do not know, never that it is zero.
 */
export const heyLine = (scan: HeyScan): string => {
  const parts: string[] = [];
  if (scan.statusLabel) parts.push(scan.statusLabel.toLowerCase());
  if (scan.commits30d !== null) parts.push(count(scan.commits30d, "commit", "commits"));
  if (scan.releases30d !== null) parts.push(count(scan.releases30d, "release", "releases"));
  if (scan.verifiedBuilder === true) parts.push("verified builder");
  parts.push(`<a href="${scan.url}">see on HEY</a>`);
  return parts.join(" · ");
};

export const createHeyScanner = (config: HeyConfig): HeyScanner => {
  const base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const doFetch = config.fetch ?? fetch;
  return createPartnerScanner<HeyScan>({
    name: "hey",
    chainId: config.chainId,
    supportedChains: SUPPORTED_CHAINS,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.cacheMs !== undefined ? { cacheMs: config.cacheMs } : {}),
    ...(config.now ? { now: config.now } : {}),
    ask: async (token, signal) => {
      const url = `${base}/api/v1/scan?chain=${config.chainId}&token=${token.toLowerCase()}`;
      const headers: Record<string, string> = { accept: "application/json" };
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      const r = await doFetch(url, { headers, signal });
      if (!r.ok) {
        console.warn(`hey scan ${r.status} for ${token}`);
        return undefined;
      }
      return readHey(await r.json());
    },
  });
};
