/**
 * ETH's price in dollars for Positions' $ view (2026-10-01): the price of the
 * ETH pool of a dollar stablecoin on the chain (BOT_USD_TOKEN, USDG on 4663),
 * found by the bot's own scan like any token's, never recorded. The pool's
 * price, not a quote: a hooked pool with a dynamic fee quotes nonsense here.
 * Read at most every five minutes, since the scan is slow; a price outside
 * $100 to $100 000 an ETH is treated as no price, so an odd pool cannot put
 * wild figures on screen, and the card then offers ETH only.
 */
import type { BotChain } from "./bot-chain.js";
import type { Address } from "./types.js";

const TTL_MS = 5 * 60_000;
const SANE = { min: 100, max: 100_000 };

export type UsdPriceParts = { reads: Pick<BotChain, "tokenInfo">; token: Address; now?: () => number };

export const createUsdPrice = (p: UsdPriceParts): (() => Promise<number | undefined>) => {
  const now = p.now ?? Date.now;
  let cached: { at: number; price: number | undefined } | undefined;
  // One read at a time: taps that arrive while it runs wait on the same one.
  let inFlight: Promise<number | undefined> | undefined;
  const read = async (): Promise<number | undefined> => {
    let price: number | undefined;
    try {
      const info = await p.reads.tokenInfo(p.token);
      const perEth = info.hasPool && info.perEth !== undefined ? Number(info.perEth) / 10 ** info.decimals : undefined;
      price = perEth !== undefined && perEth >= SANE.min && perEth <= SANE.max ? perEth : undefined;
    } catch {
      price = undefined;
    }
    cached = { at: now(), price };
    return price;
  };
  return async () => {
    if (cached && now() - cached.at < TTL_MS) return cached.price;
    inFlight ??= read().finally(() => { inFlight = undefined; });
    return inFlight;
  };
};
