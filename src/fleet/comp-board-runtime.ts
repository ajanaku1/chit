/**
 * /api/comp/board: the competition's board as JSON, public, no key. The
 * stores and the chain are the mainnet bot's own (DATABASE_URL, the
 * Robinhood Chain RPC); a board is built at most once a minute per instance
 * and served from the edge for as long, so a page refresh never reaches the
 * database or the RPC. COMP_EXCLUDE_TG_IDS lists who is scored out of it.
 */
import { neon } from "@neondatabase/serverless";
import { generatePrivateKey } from "viem/accounts";

import { createBotChain } from "./bot-chain.js";
import { NeonCompStore } from "./bot-comp.js";
import { NeonBotLinkStore } from "./bot-link.js";
import { NeonPositionLedger } from "./bot-positions.js";
import { createSessionChain } from "./bot-session-chain.js";
import { buildBoard, type Board, type BoardDeps } from "./comp-board.js";
import { FIRST_COMPETITION } from "./comp-score.js";
import { recordedPoolsFromEnv } from "./pool-registry.js";
import type { Address } from "./types.js";

const CHAIN_ID = 4663;
const ROUTER: Address = "0x8876789976decbfcbbbe364623c63652db8c0904";
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
export const BOARD_TTL_MS = 60_000;

class ConfigFault extends Error {}
const refuse = (why: string): never => { throw new ConfigFault(why); };

const depsFromEnv = (): BoardDeps => {
  const url = process.env.DATABASE_URL ?? refuse("DATABASE_URL is not set");
  const sql = neon(url);
  const port = { query: (q: string, p?: unknown[]) => sql.query(q, p) as Promise<readonly Record<string, unknown>[]> };
  const rpcUrl = process.env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  // defaultToken is the playground's; the board never reads it. The session chain's key is throwaway: only its receipt reader is used.
  const reads = createBotChain({ chainId: CHAIN_ID, rpcUrl, defaultToken: ROUTER, router: ROUTER, poolManager: POOL_MANAGER, recordedPools: recordedPoolsFromEnv(refuse) });
  const settle = createSessionChain({ chainId: CHAIN_ID, rpcUrl, signerKey: generatePrivateKey() }).settle ?? refuse("the session chain reads no receipts");
  const excluded = new Set((process.env.COMP_EXCLUDE_TG_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  return { entries: new NeonCompStore(port), links: new NeonBotLinkStore(port), ledger: new NeonPositionLedger(port), settle, reads, rules: FIRST_COMPETITION, excluded };
};

const json = (body: unknown, status: number, maxAge = 0): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": maxAge ? `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 10}` : "no-store" } });

let cached: { board: Board; at: number } | undefined;
let inFlight: Promise<Board> | undefined;
let depsForTests: BoardDeps | undefined;
export const setBoardDepsForTests = (d: BoardDeps | undefined): void => { depsForTests = d; cached = undefined; inFlight = undefined; };

export const handleBoardRequest = async (request: Request, now = new Date()): Promise<Response> => {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  if (cached && now.getTime() - cached.at < BOARD_TTL_MS) return json(cached.board, 200, 60);
  try {
    // One build at a time per instance: a burst of refreshes shares it.
    inFlight ??= buildBoard(depsForTests ?? depsFromEnv(), now).finally(() => { inFlight = undefined; });
    const board = await inFlight;
    cached = { board, at: now.getTime() };
    return json(board, 200, 60);
  } catch (e) {
    if (e instanceof ConfigFault) return json({ error: "not configured", reason: e.message }, 503);
    // The last good board, with its age, beats a blank page when the RPC or the database is slow.
    if (cached) return json({ ...cached.board, stale: true }, 200, 60);
    return json({ error: "board unavailable", reason: e instanceof Error ? e.message.split("\n")[0] : String(e) }, 502);
  }
};
