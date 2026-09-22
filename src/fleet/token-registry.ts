/**
 * The token registry (FR-011, FR-012, FR-013; specs/003-mainnet-beta/
 * contracts/token-registry.md): the only tokens the beta trades, each pinned
 * to the exact pool it trades in, reviewed like code and never a runtime
 * list. A `poolId` that does not equal the id of its `poolKey` is a hard
 * failure at load, not a warning: a wrong pool is a wrong price and a wrong
 * hook, and the CHIT pool's hook alone takes 2%. An entry with
 * `enabled: false` is present so that listing it is a flag flip, and no
 * path offers or trades it while it stays so.
 */

import { readFile } from "node:fs/promises";
import { getAddress, isAddress } from "viem";

import { poolIdOf } from "./pool-registry.js";
import type { Address, Hex, Uint } from "./types.js";
import { NATIVE_ETH, type PoolKey } from "./v4-swap.js";

export type RegistryChecks = {
  ordinaryTransfer: boolean;
  holderRestrictions: boolean;
  /** The ETH side of the pool at the current price, in wei, when checked. */
  liquidityEth: Uint;
  liquidityMultipleOfDrawCap: number;
  forkTest: string;
  checkedAt: string;
};

export type RegistryEntry = {
  token: Address;
  symbol: string;
  decimals: number;
  poolKey: PoolKey;
  poolId: Hex;
  /** The bound in force for this token: the buy is refused when it would land further from the quote than this. */
  slippageBps: number;
  enabled: boolean;
  checks: RegistryChecks;
};

export type TokenRegistry = {
  chainId: number;
  poolManager: Address;
  router: Address;
  entries: readonly RegistryEntry[];
  /** The tokens offered: enabled entries, in the file's order. */
  enabled(): RegistryEntry[];
  /** The entry for a token, enabled or not; undefined when it is not listed at all. */
  entry(token: string): RegistryEntry | undefined;
};

/** The default bound (rule 3): 1%, unless the entry records its own. */
export const DEFAULT_SLIPPAGE_BPS = 100;

export class RegistryError extends Error {
  constructor(message: string) {
    super(`token registry: ${message}`);
    this.name = "RegistryError";
  }
}

const address = (value: unknown, what: string): Address => {
  if (typeof value !== "string" || !isAddress(value)) throw new RegistryError(`${what} is not an address: ${String(value)}`);
  return getAddress(value).toLowerCase() as Address;
};

const parseEntry = (raw: unknown, index: number): RegistryEntry => {
  if (typeof raw !== "object" || raw === null) throw new RegistryError(`entry ${index} is not an object`);
  const e = raw as Record<string, unknown>;
  const token = address(e["token"], `entry ${index}.token`);
  if (typeof e["symbol"] !== "string" || e["symbol"].length === 0) throw new RegistryError(`${token} has no symbol`);
  if (typeof e["decimals"] !== "number" || !Number.isInteger(e["decimals"]) || e["decimals"] < 0 || e["decimals"] > 36) throw new RegistryError(`${token} has no whole decimals`);
  const k = e["poolKey"];
  if (typeof k !== "object" || k === null) throw new RegistryError(`${token} has no poolKey`);
  const key = k as Record<string, unknown>;
  const poolKey: PoolKey = {
    currency0: address(key["currency0"], `${token}.poolKey.currency0`),
    currency1: address(key["currency1"], `${token}.poolKey.currency1`),
    fee: Number(key["fee"]),
    tickSpacing: Number(key["tickSpacing"]),
    hooks: address(key["hooks"], `${token}.poolKey.hooks`),
  };
  if (poolKey.currency0 !== NATIVE_ETH || poolKey.currency1 !== token) throw new RegistryError(`${token}'s poolKey is not ETH against the token`);
  if (!Number.isInteger(poolKey.fee) || poolKey.fee < 0 || !Number.isInteger(poolKey.tickSpacing) || poolKey.tickSpacing <= 0) throw new RegistryError(`${token}'s poolKey has no whole fee and tick spacing`);
  // The hooks address keeps its checksum: the id is derived from the address bytes, so case does not matter, but the file is read by people too.
  const derived = poolIdOf({ ...poolKey, hooks: getAddress(poolKey.hooks) });
  if (typeof e["poolId"] !== "string" || e["poolId"].toLowerCase() !== derived.toLowerCase()) {
    throw new RegistryError(`${token}'s poolId ${String(e["poolId"])} is not the id of its poolKey (${derived}); rule 1, a hard failure`);
  }
  const slippageBps = e["slippageBps"] === undefined ? DEFAULT_SLIPPAGE_BPS : Number(e["slippageBps"]);
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 5_000) throw new RegistryError(`${token}'s slippageBps is not a whole number of basis points between 1 and 5000`);
  if (typeof e["enabled"] !== "boolean") throw new RegistryError(`${token} says neither enabled: true nor enabled: false`);
  const c = (typeof e["checks"] === "object" && e["checks"] !== null ? e["checks"] : {}) as Record<string, unknown>;
  const checks: RegistryChecks = {
    ordinaryTransfer: c["ordinaryTransfer"] === true,
    holderRestrictions: c["holderRestrictions"] === true,
    liquidityEth: typeof c["liquidityEth"] === "string" && /^\d+$/.test(c["liquidityEth"]) ? c["liquidityEth"] : "0",
    liquidityMultipleOfDrawCap: typeof c["liquidityMultipleOfDrawCap"] === "number" ? c["liquidityMultipleOfDrawCap"] : 0,
    forkTest: typeof c["forkTest"] === "string" ? c["forkTest"] : "",
    checkedAt: typeof c["checkedAt"] === "string" ? c["checkedAt"] : "",
  };
  // An enabled entry has passed its four checks, each recorded (FR-012); one that has not is not offered, whatever the flag says.
  if (e["enabled"] === true && (!checks.ordinaryTransfer || checks.holderRestrictions || checks.liquidityMultipleOfDrawCap < 50 || !checks.checkedAt)) {
    throw new RegistryError(`${token} is enabled but its checks do not pass: a plain transfer, no holder restrictions, fifty times the draw cap in liquidity, and a date`);
  }
  return { token, symbol: e["symbol"], decimals: e["decimals"], poolKey: { ...poolKey, hooks: getAddress(poolKey.hooks) }, poolId: derived, slippageBps, enabled: e["enabled"], checks };
};

export const parseTokenRegistry = (raw: unknown, expectedChainId?: number): TokenRegistry => {
  if (typeof raw !== "object" || raw === null) throw new RegistryError("not an object");
  const r = raw as Record<string, unknown>;
  const chainId = Number(r["chainId"]);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new RegistryError("no chainId");
  if (expectedChainId !== undefined && chainId !== expectedChainId) throw new RegistryError(`the file is for chain ${chainId}, the service runs on ${expectedChainId}`);
  const poolManager = address(r["poolManager"], "poolManager");
  const router = address(r["router"], "router");
  if (!Array.isArray(r["tokens"])) throw new RegistryError("no tokens list");
  const entries = r["tokens"].map(parseEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.token)) throw new RegistryError(`${entry.token} is listed twice`);
    seen.add(entry.token);
  }
  return {
    chainId, poolManager, router, entries,
    enabled: () => entries.filter((e) => e.enabled),
    entry: (token) => entries.find((e) => e.token === token.toLowerCase()),
  };
};

export const loadTokenRegistry = async (path: string, expectedChainId?: number): Promise<TokenRegistry> =>
  parseTokenRegistry(JSON.parse(await readFile(path, "utf8")), expectedChainId);
