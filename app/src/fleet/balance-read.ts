/**
 * One balance read, shared by every page.
 *
 * A balance read is a signed request, so it costs the trader a wallet prompt.
 * Three pages each signing on every load is indistinguishable from being asked
 * to connect over and over. A recent read therefore stands in for all of them,
 * and only an explicit refresh, or an action that must see the chain, signs.
 */

import type { Hex } from "viem";

import { clearCachedBalance, isFresh, loadCachedBalance, saveCachedBalance, type BalanceState, type CachedBalance } from "./balance.js";
import { signedFleetApi } from "./signed-request.js";

export type ReadOptions = { force?: boolean; now?: Date };

/** The trader's balance, from the last minute's read unless forced. */
export const readBalance = async (wallet: Hex, options: ReadOptions = {}): Promise<CachedBalance> => {
  const now = options.now ?? new Date();
  if (!options.force) {
    const cached = loadCachedBalance(sessionStorage, wallet);
    if (cached && isFresh(cached.savedAt, now)) return cached;
  }
  const body = (await signedFleetApi(wallet, "balance", {})) as unknown as BalanceState;
  saveCachedBalance(sessionStorage, wallet, body, now);
  window.dispatchEvent(new CustomEvent("chit-balance-read", { detail: { wallet } }));
  return { ...body, savedAt: now.getTime() };
};

/** Call after anything that moves the balance, so the next read is live. */
export const invalidateBalance = (wallet: Hex): void => clearCachedBalance(sessionStorage, wallet);
