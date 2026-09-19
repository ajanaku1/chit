/**
 * Gas sponsorship: what the service has to remember between instances.
 *
 * This is the first state the fleet service keeps off the chain and out of
 * one instance's memory, and the reason is in the spec (FR-005): a per-user
 * daily cap that lives in one instance's memory is not a cap, since two
 * requests a second apart can land on two instances. So sponsors, their
 * policies, and every operation signed for them live in a store that every
 * instance shares. The budget itself stays on chain in the escrow; the store
 * never holds a wei.
 *
 * Two implementations: memory, for tests and for a single local instance;
 * Neon, for the hosted service, in sponsor-store-neon.ts. Both behave the
 * same, and the unit tests run against the memory one.
 *
 * A user is never stored by address. `userHash` is keccak256(sender, sponsor),
 * so a sponsor's dashboard can group by user without naming one, and the
 * same user under two sponsors is two different hashes.
 */

import type { SponsorPolicy } from "./sponsor-policy.js";
import type { Address, Hex, Uint } from "./types.js";

export type SponsorRecord = {
  /** bytes32; the escrow campaign id. Never shown on a user-facing surface (FR-001). */
  id: Hex;
  /** The wallet that registered, funds the budget, and receives it back on close. */
  owner: Address;
  policy: SponsorPolicy;
  paused: boolean;
  closed: boolean;
  createdAt: string;
  registerTx: Hex;
};

export type SponsoredOpRecord = {
  /** The escrow reservation key: keccak256(sponsor, sender, nonce). Unique per op. */
  key: Hex;
  sponsor: Hex;
  userHash: Hex;
  sender: Address;
  target: Address;
  selector: Hex | null;
  /** The most the budget could be charged: prefund plus fee, in wei. */
  maxCharged: Uint;
  signedAt: string;
  /** Unix seconds; the sponsorship signature is worthless after it. */
  validUntil: number;
  /** Set when the op lands. */
  userOpHash?: Hex;
  txHash?: Hex;
  success?: boolean;
  /** What the budget was actually charged, in wei, once known. */
  charged?: Uint;
  landedAt?: string;
};

export type DaySpend = { day: string; ops: number; charged: Uint };
export type TargetSpend = { target: Address; ops: number; charged: Uint };
export type UserSpend = { userHash: Hex; ops: number; charged: Uint };

export interface SponsorStore {
  getSponsor(id: Hex): Promise<SponsorRecord | undefined>;
  putSponsor(record: SponsorRecord): Promise<void>;
  listSponsors(owner: Address): Promise<SponsorRecord[]>;
  /**
   * What the day has already been charged, at each op's ceiling until it
   * lands and at its real charge after. With a userHash, for that user; without,
   * for the whole sponsor.
   */
  spentOn(sponsor: Hex, day: string, userHash?: Hex): Promise<bigint>;
  addOp(op: SponsoredOpRecord): Promise<void>;
  getOp(key: Hex): Promise<SponsoredOpRecord | undefined>;
  updateOp(key: Hex, patch: Partial<SponsoredOpRecord>): Promise<void>;
  /** Newest first. */
  listOps(sponsor: Hex, limit: number): Promise<SponsoredOpRecord[]>;
  /** Signed but never landed and past their window: the keys a close should roll back. */
  staleKeys(sponsor: Hex, nowSeconds: number): Promise<Hex[]>;
}

/** The dashboard's three groupings, folded from a list of ops (FR-008). */
export const foldSpend = (ops: readonly SponsoredOpRecord[]) => {
  const byDay = new Map<string, DaySpend>();
  const byTarget = new Map<Address, TargetSpend>();
  const byUser = new Map<Hex, UserSpend>();
  const add = <K, V extends { ops: number; charged: Uint }>(map: Map<K, V>, key: K, make: () => V, amount: bigint) => {
    const row = map.get(key) ?? make();
    row.ops += 1;
    row.charged = (BigInt(row.charged) + amount).toString();
    map.set(key, row);
  };
  for (const op of ops) {
    const amount = BigInt(op.charged ?? op.maxCharged);
    const day = (op.landedAt ?? op.signedAt).slice(0, 10);
    add(byDay, day, () => ({ day, ops: 0, charged: "0" }), amount);
    add(byTarget, op.target, () => ({ target: op.target, ops: 0, charged: "0" }), amount);
    add(byUser, op.userHash, () => ({ userHash: op.userHash, ops: 0, charged: "0" }), amount);
  }
  const desc = (a: { charged: Uint }, b: { charged: Uint }) => (BigInt(b.charged) > BigInt(a.charged) ? 1 : -1);
  return {
    byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
    byTarget: [...byTarget.values()].sort(desc),
    byUser: [...byUser.values()].sort(desc),
  };
};

export class MemorySponsorStore implements SponsorStore {
  readonly #sponsors = new Map<Hex, SponsorRecord>();
  readonly #ops = new Map<Hex, SponsoredOpRecord>();

  async getSponsor(id: Hex): Promise<SponsorRecord | undefined> {
    const r = this.#sponsors.get(id);
    return r ? structuredClone(r) : undefined;
  }
  async putSponsor(record: SponsorRecord): Promise<void> {
    this.#sponsors.set(record.id, structuredClone(record));
  }
  async listSponsors(owner: Address): Promise<SponsorRecord[]> {
    return [...this.#sponsors.values()].filter((s) => s.owner === owner).map((s) => structuredClone(s));
  }
  async spentOn(sponsor: Hex, day: string, userHash?: Hex): Promise<bigint> {
    let total = 0n;
    for (const op of this.#ops.values()) {
      if (op.sponsor !== sponsor) continue;
      if (userHash && op.userHash !== userHash) continue;
      if ((op.landedAt ?? op.signedAt).slice(0, 10) !== day) continue;
      if (op.success === false) continue;
      total += BigInt(op.charged ?? op.maxCharged);
    }
    return total;
  }
  async addOp(op: SponsoredOpRecord): Promise<void> {
    if (this.#ops.has(op.key)) throw new Error("duplicate op key");
    this.#ops.set(op.key, structuredClone(op));
  }
  async getOp(key: Hex): Promise<SponsoredOpRecord | undefined> {
    const op = this.#ops.get(key);
    return op ? structuredClone(op) : undefined;
  }
  async updateOp(key: Hex, patch: Partial<SponsoredOpRecord>): Promise<void> {
    const op = this.#ops.get(key);
    if (!op) throw new Error("unknown op key");
    this.#ops.set(key, { ...op, ...structuredClone(patch) });
  }
  async listOps(sponsor: Hex, limit: number): Promise<SponsoredOpRecord[]> {
    return [...this.#ops.values()]
      .filter((op) => op.sponsor === sponsor)
      .sort((a, b) => (a.signedAt < b.signedAt ? 1 : -1))
      .slice(0, limit)
      .map((op) => structuredClone(op));
  }
  async staleKeys(sponsor: Hex, nowSeconds: number): Promise<Hex[]> {
    return [...this.#ops.values()]
      .filter((op) => op.sponsor === sponsor && !op.landedAt && op.validUntil < nowSeconds)
      .map((op) => op.key);
  }
}
