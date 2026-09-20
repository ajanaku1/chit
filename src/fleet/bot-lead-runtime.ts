/**
 * POST /api/bot/lead: the Sessions page posts { nonce, wallet, signature,
 * handle } after a wallet leader signed the lead message with the wallet
 * they trade from; the route verifies the signature against the wallet and
 * the nonce against the link store (bot-copy.ts, claimLeadWallet) and
 * answers with the leader, or a refusal in words that says what to do next.
 * GET ?nonce=… says whether a nonce is still good, so the page can say
 * "expired" before asking for a signature. Session mode only, like the link
 * route it is modelled on (bot-link-runtime.ts); no chain read is needed,
 * because the proof is the wallet's own signature and nothing on chain
 * says who leads.
 */

import { neon } from "@neondatabase/serverless";
import { claimLeadWallet, LeadError, MemoryCopyStore, NeonCopyStore, type CopyStore } from "./bot-copy.js";
import { MemoryBotLinkStore, NeonBotLinkStore, NONCE_TTL_MS, type BotLinkStore } from "./bot-link.js";

let links: BotLinkStore | undefined;
let leaders: CopyStore | undefined;

const chainIdFromEnv = (): number => Number(process.env.FLEET_CHAIN_ID || 46630);

type Sql = { query(sql: string, params?: unknown[]): Promise<readonly Record<string, unknown>[]> };
const sqlFromEnv = (): Sql | undefined => {
  const url = process.env.DATABASE_URL;
  if (url) {
    const sql = neon(url);
    return { query: (q, p) => sql.query(q, p) as Promise<readonly Record<string, unknown>[]> };
  }
  if (process.env.BOT_MEMORY_STORE !== "1") throw new Error("DATABASE_URL is not set");
  return undefined;
};

/** The same two stores the bot writes: the link store for the nonce, the copy store for the leader. */
const stores = (): { links: BotLinkStore; leaders: CopyStore } => {
  if (links && leaders) return { links, leaders };
  const sql = sqlFromEnv();
  links ??= sql ? new NeonBotLinkStore(sql) : new MemoryBotLinkStore();
  leaders ??= sql ? new NeonCopyStore(sql) : new MemoryCopyStore();
  return { links, leaders };
};

/** For tests: the stores from outside; nothing else is overridable. */
export const setLeadDepsForTests = (deps: { links?: BotLinkStore; leaders?: CopyStore }): void => {
  links = deps.links;
  leaders = deps.leaders;
};

const cors = (origin: string | null): Record<string, string> => {
  const site = (process.env.FLEET_ORIGIN || "https://chit.tools").replace(/\/+$/, "");
  return origin && origin === site ? { "access-control-allow-origin": origin, vary: "origin" } : {};
};
const json = (body: unknown, status: number, origin: string | null): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors(origin) } });

export const handleLeadRequest = async (request: Request, now = new Date()): Promise<Response> => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors(origin), "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" } });
  if (process.env.BOT_MODE !== "session") return json({ error: "the bot is not in session mode here" }, 404, origin);
  try {
    if (request.method === "GET") {
      const nonce = new URL(request.url).searchParams.get("nonce") ?? "";
      const n = /^[0-9a-f]{32}$/.test(nonce) ? await stores().links.getNonce(nonce) : undefined;
      const fresh = Boolean(n && !n.usedAt && now.getTime() - Date.parse(n.issuedAt) <= NONCE_TTL_MS);
      return json({ ok: fresh, ...(n && !fresh ? { why: n.usedAt ? "used" : "expired" } : {}) }, 200, origin);
    }
    if (request.method !== "POST") return json({ error: "POST the claim" }, 405, origin);
    let raw: unknown;
    try { raw = await request.json(); } catch { return json({ error: "body must be json" }, 400, origin); }
    if (!raw || typeof raw !== "object") return json({ error: "body must be json" }, 400, origin);
    const body = raw as { nonce?: unknown; wallet?: unknown; signature?: unknown; handle?: unknown };
    const { links: l, leaders: c } = stores();
    const leader = await claimLeadWallet(c, l, chainIdFromEnv(), { nonce: body.nonce, wallet: body.wallet, signature: body.signature, handle: body.handle ?? "" }, now);
    return json({ ok: true, wallet: leader.wallet, handle: leader.handle, chainId: chainIdFromEnv(), since: leader.since }, 200, origin);
  } catch (e) {
    if (e instanceof LeadError) return json({ error: e.message }, e.status, origin);
    console.error(`bot lead: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "could not verify the claim right now; try again" }, 503, origin);
  }
};
