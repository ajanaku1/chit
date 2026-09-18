/**
 * What every partner line on the token card shares: one ask per card draw
 * with a short patience, the answer (or the miss) kept a while per token so a
 * refresh spam stays inside the partner's quota, a chain guard for partners
 * that index one chain, and silence on any failure. The card never waits on
 * a partner alone and never falls over because of one.
 */

import type { Address } from "./types.js";

export type PartnerConfig<T> = {
  name: string;
  chainId: number;
  /** Chains the partner indexes; elsewhere the scanner never asks. */
  supportedChains: number[];
  /** Asks the partner; undefined is "no line". A thrown error is logged and read the same. */
  ask: (token: Address, signal: AbortSignal) => Promise<T | undefined>;
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
};

export type PartnerScanner<T> = { scan(token: Address): Promise<T | undefined> };

export const createPartnerScanner = <T>(config: PartnerConfig<T>): PartnerScanner<T> => {
  const timeoutMs = config.timeoutMs ?? 1_500;
  const cacheMs = config.cacheMs ?? 60_000;
  const now = config.now ?? (() => Date.now());
  const supported = new Set(config.supportedChains);
  const kept = new Map<string, { until: number; value: T | undefined }>();

  return {
    async scan(token) {
      if (!supported.has(config.chainId)) return undefined;
      const key = token.toLowerCase();
      const hit = kept.get(key);
      if (hit && hit.until > now()) return hit.value;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let value: T | undefined;
      try {
        value = await config.ask(token, controller.signal);
      } catch (error) {
        console.warn(`${config.name} scan: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        value = undefined;
      } finally {
        clearTimeout(timer);
      }
      kept.set(key, { until: now() + cacheMs, value });
      // A map that only grows is a leak on a long-lived process; forget what is stale when it gets big.
      if (kept.size > 500) for (const [k, v] of kept) if (v.until <= now()) kept.delete(k);
      return value;
    },
  };
};
