/**
 * Signed reads a recent answer can stand in for.
 *
 * A signed read is a wallet prompt, so a page that signs every time it loads
 * prompts on every tab switch. Answers are kept per wallet for this tab, as long
 * as a cached balance is; anything that changes a fleet forgets them instead.
 */

import type { Hex } from "viem";

import { isFresh } from "./balance.js";
import { payloadHash, signedFleetApi } from "./signed-request.js";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Body = Record<string, unknown>;
type Entry = { savedAt: number; body: Body };

export type SignedReadOptions = {
  force?: boolean;
  now?: Date;
  /** For answers that go stale faster than a balance, such as a price quote. */
  maxAgeMs?: number;
  storage?: Store;
  sign?: typeof signedFleetApi;
};

const PREFIX = "chit-reads:";
const keyOf = (wallet: Hex): string => `${PREFIX}${wallet.toLowerCase()}`;

const load = (storage: Store, wallet: Hex): Record<string, Entry> => {
  try {
    const parsed = JSON.parse(storage.getItem(keyOf(wallet)) ?? "{}") as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, Entry>) : {};
  } catch {
    return {};
  }
};

// A page that asks twice while the first prompt is still open gets one prompt.
const inFlight = new Map<string, Promise<Body>>();

/** A recent answer to this read, or undefined: never signs, so it is safe while a page loads. */
export const recentSigned = (
  wallet: Hex,
  action: string,
  body: Body,
  { now = new Date(), maxAgeMs, storage = sessionStorage }: Pick<SignedReadOptions, "now" | "maxAgeMs" | "storage"> = {},
): Body | undefined => {
  const cached = load(storage, wallet)[`${action}:${payloadHash(body)}`];
  return cached && isFresh(cached.savedAt, now, maxAgeMs) ? cached.body : undefined;
};

export const readSigned = async (
  wallet: Hex,
  action: string,
  body: Body,
  { force = false, now = new Date(), maxAgeMs, storage = sessionStorage, sign = signedFleetApi }: SignedReadOptions = {},
): Promise<Body> => {
  const slot = `${action}:${payloadHash(body)}`;
  const cached = force ? undefined : recentSigned(wallet, action, body, { now, storage, ...(maxAgeMs !== undefined ? { maxAgeMs } : {}) });
  if (cached) return cached;

  const flight = `${keyOf(wallet)}:${slot}`;
  const pending = inFlight.get(flight);
  if (pending) return pending;
  const read = sign(wallet, action, body)
    .then((result) => {
      try {
        storage.setItem(keyOf(wallet), JSON.stringify({ ...load(storage, wallet), [slot]: { savedAt: now.getTime(), body: result } }));
      } catch {
        // Storage may be unavailable; the next load signs again.
      }
      return result;
    })
    .finally(() => inFlight.delete(flight));
  inFlight.set(flight, read);
  return read;
};

/** Call after anything that changes a fleet, so the next read is live. */
export const forgetSignedReads = (wallet: Hex, storage: Store = sessionStorage): void => {
  try {
    storage.removeItem(keyOf(wallet));
  } catch {
    // Nothing to forget if storage is unavailable.
  }
};
