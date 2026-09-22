/**
 * A fleet buy as an order: one token, a total, every wallet a slice.
 *
 * The plan is derived from the order's seed, so the browser that holds the
 * order and any service instance that receives it compute the same slices.
 * Sizes vary around the average and due times spread across a window the
 * trader does not choose, so no trader-specific rhythm is fingerprintable.
 */
import { keccak256, stringToHex, type Address, type Hex } from "viem";

import type { Uint } from "./types.js";

export type Order = {
  id: Hex;
  campaign: string;
  token: Address;
  totalWei: Uint;
  wallets: Address[];
  seed: Hex;
  windowMs: number;
  createdAt: string;
  owner: Address;
  /** The fill quoted for the whole total when the order was placed; each slice is refused before it is sent if the pool no longer gives its share inside the bound (FR-013). Not in the id. */
  acceptedOut?: Uint;
};

export type Slice = { index: number; wallet: Address; amountWei: Uint; dueAt: string };

export class PlanError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "PlanError";
    this.code = code;
  }
}

const MIN_WINDOW_MS = 5 * 60_000;
export const MAX_WINDOW_MS = 30 * 60_000;
/** Each slice may sit this far from the average, as a share in basis points. */
const SPREAD_BPS = 3500n;

export const windowFor = (wallets: number): number => {
  const clamped = Math.min(50, Math.max(5, wallets));
  return Math.round(MIN_WINDOW_MS + ((clamped - 5) / 45) * (MAX_WINDOW_MS - MIN_WINDOW_MS));
};

export const orderId = (order: Omit<Order, "id">): Hex =>
  keccak256(
    stringToHex(
      JSON.stringify([
        order.campaign,
        order.token.toLowerCase(),
        order.totalWei,
        order.wallets.map((w) => w.toLowerCase()),
        order.seed,
        order.windowMs,
        order.createdAt,
        order.owner.toLowerCase(),
      ]),
    ),
  );

/** A stream of 32-byte words from the seed: word n is keccak(seed ‖ n). */
const draw = (seed: Hex, n: number): bigint => BigInt(keccak256(`${seed}${n.toString(16).padStart(8, "0")}` as Hex));

export const planSlices = (order: Omit<Order, "id">, capWei: Uint): Slice[] => {
  const total = BigInt(order.totalWei);
  const cap = BigInt(capWei);
  const count = order.wallets.length;
  if (count === 0) throw new PlanError("no_wallets");
  if (total <= 0n) throw new PlanError("zero_total");
  if (total > cap * BigInt(count)) throw new PlanError("over_cap");

  // Weights in [10000 - spread, 10000 + spread]; sizes follow the weights and
  // are then corrected so they sum to the total exactly.
  const weights = order.wallets.map((_, i) => 10_000n - SPREAD_BPS + (draw(order.seed, i) % (2n * SPREAD_BPS + 1n)));
  const weightSum = weights.reduce((a, b) => a + b, 0n);
  const sizes = weights.map((w) => (total * w) / weightSum);
  let remainder = total - sizes.reduce((a, b) => a + b, 0n);
  for (let i = 0; remainder > 0n; i = (i + 1) % count) {
    sizes[i] = sizes[i]! + 1n;
    remainder -= 1n;
  }
  // A weighted split can put one slice over the cap even when the total fits;
  // that order is refused rather than quietly reshaped.
  for (const size of sizes) {
    if (size > cap) throw new PlanError("over_cap");
  }

  const start = Date.parse(order.createdAt);
  const dues = order.wallets
    .map((_, i) => start + Number(draw(order.seed, 1000 + i) % BigInt(order.windowMs + 1)))
    .sort((a, b) => a - b);

  return order.wallets.map((wallet, index) => ({
    index,
    wallet,
    amountWei: sizes[index]!.toString(),
    dueAt: new Date(dues[index]!).toISOString(),
  }));
};
