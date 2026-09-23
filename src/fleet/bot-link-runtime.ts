/**
 * POST /api/bot/link: the Sessions page posts { nonce, account, signature }
 * after the owner signed the link message; the route verifies it against
 * the chain (owner()) and the nonce store and answers with the link, or a
 * refusal in words. GET ?nonce=… says whether a nonce is still good, so the
 * page can say "expired" before asking for a signature. Session mode only.
 */

import { type Address, createPublicClient, http } from "viem";
import { neon } from "@neondatabase/serverless";
import { robinhoodChain } from "./chain-def.js";
import { LinkError, MemoryBotLinkStore, NeonBotLinkStore, NONCE_TTL_MS, verifyLink, type BotLinkStore } from "./bot-link.js";
import { SESSION_ACCOUNT_ABI } from "./session-keys.js";

let links: BotLinkStore | undefined;
let ownerReader: ((account: Address) => Promise<Address | undefined>) | undefined;

const chainIdFromEnv = (): number => Number(process.env.FLEET_CHAIN_ID || 46630);

const store = (): BotLinkStore => {
  if (links) return links;
  const url = process.env.DATABASE_URL;
  if (url) {
    const sql = neon(url);
    return (links = new NeonBotLinkStore({ query: (q, p) => sql.query(q, p) as Promise<readonly Record<string, unknown>[]> }));
  }
  if (process.env.BOT_MEMORY_STORE !== "1") throw new Error("DATABASE_URL is not set");
  return (links = new MemoryBotLinkStore());
};

const ownerOf = (): ((account: Address) => Promise<Address | undefined>) => {
  if (ownerReader) return ownerReader;
  const chainId = chainIdFromEnv();
  const rpcUrl = process.env.FLEET_RPC_URL || (chainId === 4663 ? process.env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com" : process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com");
  const chain = robinhoodChain(chainId, rpcUrl);
  const pub = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 2, timeout: 15_000 }) });
  return (ownerReader = (account) => pub.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "owner" }).catch(() => undefined));
};

/** For tests: the store and the owner reader from outside; nothing else is overridable. */
export const setLinkDepsForTests = (deps: { links?: BotLinkStore; ownerOf?: (a: Address) => Promise<Address | undefined> }): void => {
  links = deps.links;
  ownerReader = deps.ownerOf;
};

const cors = (origin: string | null): Record<string, string> => {
  const site = (process.env.FLEET_ORIGIN || "https://chit.tools").replace(/\/+$/, "");
  return origin && origin === site ? { "access-control-allow-origin": origin, vary: "origin" } : {};
};
const json = (body: unknown, status: number, origin: string | null): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors(origin) } });

export const handleLinkRequest = async (request: Request, now = new Date()): Promise<Response> => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors(origin), "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" } });
  if (process.env.BOT_MODE !== "session") return json({ error: "the bot is not in session mode here" }, 404, origin);
  try {
    if (request.method === "GET") {
      const nonce = new URL(request.url).searchParams.get("nonce") ?? "";
      const n = /^[0-9a-f]{32}$/.test(nonce) ? await store().getNonce(nonce) : undefined;
      const fresh = Boolean(n && !n.usedAt && now.getTime() - Date.parse(n.issuedAt) <= NONCE_TTL_MS);
      return json({ ok: fresh, ...(n && !fresh ? { why: n.usedAt ? "used" : "expired" } : {}) }, 200, origin);
    }
    if (request.method !== "POST") return json({ error: "POST the link" }, 405, origin);
    let raw: unknown;
    try { raw = await request.json(); } catch { return json({ error: "body must be json" }, 400, origin); }
    if (!raw || typeof raw !== "object") return json({ error: "body must be json" }, 400, origin);
    const body = raw as { nonce?: unknown; account?: unknown; signature?: unknown };
    const link = await verifyLink(store(), chainIdFromEnv(), { nonce: body.nonce, account: body.account, signature: body.signature }, ownerOf(), now);
    return json({ ok: true, account: link.account, owner: link.owner, chainId: link.chainId, linkedAt: link.linkedAt }, 200, origin);
  } catch (e) {
    if (e instanceof LinkError) return json({ error: e.message }, e.status, origin);
    console.error(`bot link: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "could not verify the link right now; try again" }, 503, origin);
  }
};
