/**
 * Scores the trading competition (src/fleet/comp-score.ts). Run it the
 * moment the competition ends: open holdings are valued at what selling
 * them returns when it runs, through the same pools the bot quotes (set
 * BOT_POOL_KEYS as production has it). No key: the only write is the trade
 * record's settling from receipts, the same one Positions makes.
 *
 *   DATABASE_URL=… npm run comp-score -- [--exclude <tg id>,<tg id>] \
 *     [--start 2026-10-02T12:00:00Z --end 2026-10-09T12:00:00Z] [--min 0.0005] [--trades 5]
 *
 * Without dates it scores the first competition (FIRST_COMPETITION).
 *
 * Prints both boards by nickname, then the awards with each winner's
 * Telegram id, to message them in the bot. Never a wallet on the boards.
 */

import { neon } from "@neondatabase/serverless";
import { formatEther, parseEther } from "viem";
import { generatePrivateKey } from "viem/accounts";

import { createBotChain } from "../src/fleet/bot-chain.js";
import { NeonCompStore } from "../src/fleet/bot-comp.js";
import { NeonBotLinkStore } from "../src/fleet/bot-link.js";
import { NeonPositionLedger, settleTrades } from "../src/fleet/bot-positions.js";
import { createSessionChain } from "../src/fleet/bot-session-chain.js";
import { FIRST_COMPETITION, scoreCompetition, type Entrant, type Holding } from "../src/fleet/comp-score.js";
import { recordedPoolsFromEnv } from "../src/fleet/pool-registry.js";
import type { Address } from "../src/fleet/types.js";

const CHAIN_ID = 4663;
const RPC_URL = process.env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const ROUTER: Address = "0x8876789976decbfcbbbe364623c63652db8c0904";
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

const fail = (why: string): never => { console.error(`comp-score: ${why}`); process.exit(1); };
const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const date = (name: string, fallback: Date): Date => { const raw = arg(name); if (!raw) return fallback; const d = new Date(raw); return Number.isNaN(d.getTime()) ? fail(`--${name} must be a date, like 2026-10-05T00:00:00Z`) : d; };

const url = process.env.DATABASE_URL ?? fail("DATABASE_URL is not set");
const rules = { start: date("start", FIRST_COMPETITION.start), end: date("end", FIRST_COMPETITION.end), minWei: arg("min") ? parseEther(arg("min")!) : FIRST_COMPETITION.minWei, minTrades: Number(arg("trades") ?? FIRST_COMPETITION.minTrades) };
const excluded = new Set((arg("exclude") ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const sql = neon(url);
const port = { query: (q: string, p?: unknown[]) => sql.query(q, p) as Promise<readonly Record<string, unknown>[]> };
const [entries, links, ledger] = [new NeonCompStore(port), new NeonBotLinkStore(port), new NeonPositionLedger(port)];
// defaultToken is the playground's, never read here.
const reads = createBotChain({ chainId: CHAIN_ID, rpcUrl: RPC_URL, defaultToken: ROUTER, router: ROUTER, poolManager: POOL_MANAGER, recordedPools: recordedPoolsFromEnv(fail) });
// Only its receipt reader is used; a throwaway key that never signs.
const settle = createSessionChain({ chainId: CHAIN_ID, rpcUrl: RPC_URL, signerKey: generatePrivateKey() }).settle ?? fail("the session chain reads no receipts");

/** Each open token's balance in the account and what selling all of it returns now. */
const holdingsOf = async (account: Address, tokens: Address[]): Promise<Map<string, Holding>> => {
  const out = new Map<string, Holding>();
  for (const token of tokens) {
    const held = await reads.tokenBalance(token, account);
    out.set(token, { held, exitWei: held === 0n ? 0n : (await reads.quoteSell(token, held)) ?? 0n });
  }
  return out;
};

const entrants: Entrant[] = [];
for (const e of await entries.all()) {
  const link = await links.getLink(e.tgId);
  if (!link || link.chainId !== CHAIN_ID) { console.warn(`${e.nickname}: no mainnet account linked, not scored`); continue; }
  const trades = await settleTrades(ledger, settle, await ledger.forAccount(link.account));
  const tokens = [...new Set(trades.filter((t) => t.side === "buy").map((t) => t.token))];
  entrants.push({ tgId: e.tgId, nickname: e.nickname, trades, holdings: await holdingsOf(link.account, tokens) });
}

const { pnl, ongoing, awards } = scoreCompetition(entrants, rules, excluded);
const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;
console.log(`window ${rules.start.toISOString()} to ${rules.end.toISOString()}, min ${formatEther(rules.minWei)} ETH a trade, ${rules.minTrades} trades to qualify, ${entrants.length} scored\n`);
console.log("best pnl");
pnl.forEach((p, i) => console.log(`${i + 1}. ${p.nickname}  ${pct(p.bps)}  spent ${formatEther(p.spent)} ETH, ${p.trades} trades${excluded.has(p.tgId) ? "  (excluded)" : ""}`));
console.log("\nbest ongoing trade");
ongoing.slice(0, 10).forEach((o, i) => console.log(`${i + 1}. ${o.nickname}  ${pct(o.bps)}  ${o.token}  cost ${formatEther(o.cost)} ETH${excluded.has(o.tgId) ? "  (excluded)" : ""}`));
console.log("\nawards");
for (const a of awards) console.log(`$${a.usd}  ${a.prize}  ${a.nickname}  tg ${a.tgId}`);
