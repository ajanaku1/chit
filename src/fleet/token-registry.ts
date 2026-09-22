/**
 * The token registry: which tokens the beta trades, and in exactly which
 * pool. specs/003-mainnet-beta/contracts/token-registry.md is the contract;
 * FR-011 to FR-013 and FR-038 are the requirements. The registry is a
 * repository file, deployments/token-registry-<chainId>.json, reviewed like
 * code: not a runtime list, not user-editable, never discovered.
 *
 * What the reader holds the file to:
 *
 *   1. `poolId` equals the id derived from `poolKey`. A mismatch is a hard
 *      failure at load, not a warning: an entry that names one pool and pins
 *      another would quote in one and buy in the other.
 *   2. The pool is the token's ETH pool: currency0 is native ETH and
 *      currency1 is the token. The fleet buys with ETH and nothing else.
 *   3. `slippageBps` is the bound in force for that token, default 100 (1%,
 *      FR-013). A hooked pool records the bound measured on a fork, because
 *      the hook's fee is not in the local quote.
 *   4. `enabled: false` keeps the entry on file and offers it nowhere; what a
 *      fleet already holds of it stays movable (FR-038), which is the
 *      caller's to honour and this file's to make possible by never dropping
 *      the entry.
 *   5. The four checks of FR-012 are recorded per entry with a date. The
 *      liquidity check is repeated on the day the beta opens, against the
 *      chain, by `meetsLiquidity`: below fifty times the draw cap the token
 *      is not offered, whatever the file says.
 *
 * A file that cannot be read this way is refused with the token named. A
 * missing file is an empty registry: nothing to trade, said plainly, never
 * a fallback to a discovered pool.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { getAddress, isAddress, isHex } from "viem";

import { poolIdOf } from "./pool-registry.js";
import type { Address, Hex } from "./types.js";
import { NATIVE_ETH, type PoolKey } from "./v4-swap.js";

export type RegistryChecks = {
  /** A transfer moves exactly the amount sent, no fee taken, nobody refused. */
  ordinaryTransfer: boolean;
  /** True when the token restricts who may hold it; such a token is not offered. */
  holderRestrictions: boolean;
  /** The pool's ETH side at the current price when checked, in ETH as a decimal string. */
  liquidityEth: string;
  /** How many times the draw cap that liquidity was; fifty is the floor. */
  liquidityMultipleOfDrawCap: number;
  /** What the fork test found: quote and execution within the bound, and the bound it measured. */
  forkTest: string;
  checkedAt: string;
};

export type RegistryEntry = {
  token: Address;
  symbol: string;
  decimals: number;
  poolKey: PoolKey;
  poolId: Hex;
  slippageBps: number;
  enabled: boolean;
  checks?: RegistryChecks;
  /** Why an entry is disabled, or anything the reviewer should know. */
  note?: string;
};

export type TokenRegistry = { chainId: number; tokens: RegistryEntry[] };

/** FR-012: the ETH side of the pool must be at least this many draw caps. */
export const LIQUIDITY_MULTIPLE = 50n;
const DEFAULT_SLIPPAGE_BPS = 100;

const fail = (where: string, why: string): never => { throw new Error(`token registry: ${where}: ${why}`); };
const addr = (v: unknown, where: string): Address => (typeof v === "string" && isAddress(v) ? (getAddress(v).toLowerCase() as Address) : fail(where, `not an address: ${String(v)}`));
const int = (v: unknown, where: string, lo: number, hi: number): number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : fail(where, `expected an integer in [${lo}, ${hi}], got ${String(v)}`);

const readKey = (v: unknown, where: string): PoolKey => {
  if (!v || typeof v !== "object") return fail(where, "poolKey missing");
  const k = v as Record<string, unknown>;
  return {
    currency0: addr(k.currency0, `${where}.currency0`),
    currency1: addr(k.currency1, `${where}.currency1`),
    fee: int(k.fee, `${where}.fee`, 0, 1_000_000),
    tickSpacing: int(k.tickSpacing, `${where}.tickSpacing`, 1, 32_767),
    hooks: addr(k.hooks, `${where}.hooks`),
  };
};

const readChecks = (v: unknown, where: string): RegistryChecks | undefined => {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object") return fail(where, "checks is not an object");
  const c = v as Record<string, unknown>;
  const bool = (x: unknown, k: string): boolean => (typeof x === "boolean" ? x : fail(`${where}.${k}`, "expected true or false"));
  const str = (x: unknown, k: string): string => (typeof x === "string" && x.length > 0 ? x : fail(`${where}.${k}`, "expected text"));
  const when = str(c.checkedAt, "checkedAt");
  if (Number.isNaN(Date.parse(when))) return fail(`${where}.checkedAt`, `not a date: ${when}`);
  return {
    ordinaryTransfer: bool(c.ordinaryTransfer, "ordinaryTransfer"),
    holderRestrictions: bool(c.holderRestrictions, "holderRestrictions"),
    liquidityEth: str(c.liquidityEth, "liquidityEth"),
    liquidityMultipleOfDrawCap: typeof c.liquidityMultipleOfDrawCap === "number" && Number.isFinite(c.liquidityMultipleOfDrawCap) ? c.liquidityMultipleOfDrawCap : fail(`${where}.liquidityMultipleOfDrawCap`, "expected a number"),
    forkTest: str(c.forkTest, "forkTest"),
    checkedAt: when,
  };
};

const readEntry = (v: unknown, i: number): RegistryEntry => {
  if (!v || typeof v !== "object") return fail(`tokens[${i}]`, "not an object");
  const e = v as Record<string, unknown>;
  const token = addr(e.token, `tokens[${i}].token`);
  const where = `${typeof e.symbol === "string" ? e.symbol : token}`;
  const symbol = typeof e.symbol === "string" && /^[A-Za-z0-9$._-]{1,16}$/.test(e.symbol) ? e.symbol : fail(where, `symbol missing or odd: ${String(e.symbol)}`);
  const decimals = int(e.decimals, `${where}.decimals`, 0, 255);
  const poolKey = readKey(e.poolKey, `${where}.poolKey`);
  if (poolKey.currency0 !== NATIVE_ETH) fail(where, "the pool must be the token's ETH pool: currency0 is native ETH");
  if (poolKey.currency1 !== token) fail(where, `the pool's currency1 (${poolKey.currency1}) is not the token`);
  const poolId = typeof e.poolId === "string" && isHex(e.poolId) && e.poolId.length === 66 ? (e.poolId.toLowerCase() as Hex) : fail(where, `poolId missing or not 32 bytes: ${String(e.poolId)}`);
  const derived = poolIdOf(poolKey).toLowerCase();
  if (derived !== poolId) fail(where, `poolId ${poolId} is not the id of poolKey (${derived}); one of them names the wrong pool`);
  const slippageBps = e.slippageBps === undefined ? DEFAULT_SLIPPAGE_BPS : int(e.slippageBps, `${where}.slippageBps`, 1, 5_000);
  const enabled = typeof e.enabled === "boolean" ? e.enabled : fail(where, "enabled must be true or false, never assumed");
  const checks = readChecks(e.checks, `${where}.checks`);
  // An entry can be enabled only with its four checks on file and passed; the liquidity check is repeated live on top.
  if (enabled) {
    if (!checks) return fail(where, "enabled without its checks on file (FR-012)");
    if (!checks.ordinaryTransfer) fail(where, "enabled but its transfer check failed");
    if (checks.holderRestrictions) fail(where, "enabled but it restricts holders");
    if (checks.liquidityMultipleOfDrawCap < Number(LIQUIDITY_MULTIPLE)) fail(where, `enabled but its recorded liquidity is ${checks.liquidityMultipleOfDrawCap}× the draw cap, under ${LIQUIDITY_MULTIPLE}`);
  }
  return { token, symbol, decimals, poolKey, poolId, slippageBps, enabled, ...(checks ? { checks } : {}), ...(typeof e.note === "string" ? { note: e.note } : {}) };
};

/** The file's content held to the rules above; throws naming the entry and the rule when it cannot be. */
export const readTokenRegistry = (doc: unknown, expectChainId?: number): TokenRegistry => {
  if (!doc || typeof doc !== "object") return fail("file", "not an object");
  const d = doc as Record<string, unknown>;
  const chainId = int(d.chainId, "chainId", 1, 2 ** 31);
  if (expectChainId !== undefined && chainId !== expectChainId) fail("chainId", `the file is for ${chainId}, this runtime is on ${expectChainId}`);
  if (!Array.isArray(d.tokens)) return fail("tokens", "not a list");
  const tokens = d.tokens.map(readEntry);
  const seen = new Set<string>();
  for (const t of tokens) {
    if (seen.has(t.token)) fail(t.symbol, `listed twice (${t.token})`);
    seen.add(t.token);
  }
  return { chainId, tokens };
};

/** deployments/token-registry-<chainId>.json read and held to the rules; a missing file is an empty registry. */
export const loadTokenRegistry = async (chainId: number, dir = path.resolve("deployments")): Promise<TokenRegistry> => {
  const file = path.join(dir, `token-registry-${chainId}.json`);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { chainId, tokens: [] };
    throw e;
  }
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (e) { return fail(file, `not JSON: ${e instanceof Error ? e.message : String(e)}`); }
  return readTokenRegistry(doc, chainId);
};

/** The entries a depositor may be offered: enabled, and nothing else. A disabled entry is never returned from here. */
export const enabledTokens = (registry: TokenRegistry): RegistryEntry[] => registry.tokens.filter((t) => t.enabled);

/** The entry for a token when it is enabled; undefined for a disabled or unknown token, so no buy path can find it. */
export const tradableEntry = (registry: TokenRegistry, token: Address): RegistryEntry | undefined => {
  const want = token.toLowerCase();
  return registry.tokens.find((t) => t.token === want && t.enabled);
};

/** The entry for a token whether enabled or not: what a fleet holds must stay movable (FR-038). */
export const anyEntry = (registry: TokenRegistry, token: Address): RegistryEntry | undefined => {
  const want = token.toLowerCase();
  return registry.tokens.find((t) => t.token === want);
};

/** FR-012's live check: the pool's ETH side at the current price is at least fifty times the draw cap. */
export const meetsLiquidity = (poolEthWei: bigint, drawCapWei: bigint): boolean => poolEthWei >= drawCapWei * LIQUIDITY_MULTIPLE;

/** FR-013: the least a depositor receives for a quote under the entry's bound; the number the quote shows beside the percentage. */
export const leastOut = (quotedOut: bigint, slippageBps: number): bigint => (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
