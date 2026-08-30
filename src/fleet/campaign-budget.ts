/**
 * Per-campaign ETH sponsorship budget (FR-009, FR-016, SC-004).
 *
 * The budget reserves before a request is submitted, commits only the cost of a
 * permitted result, and rolls a failed reservation back. Every operation is keyed
 * and idempotent, so a retry after a lost response cannot double-charge. All
 * arithmetic is bigint wei; the wire format stays a decimal string.
 */

import type { Budget, Uint } from "./types.js";

type ReservationState = "reserved" | "committed" | "rolledBack";

type Reservation = { amount: bigint; state: ReservationState; committed: bigint };

export class BudgetError extends Error {
  readonly code: "budget_exceeded" | "budget_invalid" | "idempotency_conflict" | "state_invalid";
  readonly reason: string;

  constructor(code: BudgetError["code"], reason: string) {
    super(`${code}: ${reason}`);
    this.name = "BudgetError";
    this.code = code;
    this.reason = reason;
  }
}

const parse = (value: Uint, reason: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new BudgetError("budget_invalid", reason);
  return BigInt(value);
};

export class CampaignBudget {
  readonly #funded: bigint;
  readonly #reservations = new Map<string, Reservation>();
  #reserved = 0n;
  #spent = 0n;
  #closed = false;

  constructor(funded: Uint) {
    this.#funded = parse(funded, "funded_invalid");
  }

  get #unused(): bigint {
    return this.#funded - this.#spent - this.#reserved;
  }

  snapshot(): Budget {
    return {
      funded: this.#funded.toString(),
      reserved: this.#reserved.toString(),
      spent: this.#spent.toString(),
      unused: this.#closed ? "0" : this.#unused.toString(),
    };
  }

  /** Reserves `amount` under `key`. Repeating the same key and amount reserves once. */
  reserve(key: string, amount: Uint): Budget {
    if (this.#closed) throw new BudgetError("state_invalid", "budget_closed");
    const requested = parse(amount, "reservation_invalid");
    if (requested <= 0n) throw new BudgetError("budget_invalid", "reservation_not_positive");

    const existing = this.#reservations.get(key);
    if (existing) {
      if (existing.amount !== requested) throw new BudgetError("idempotency_conflict", "reservation_amount_changed");
      return this.snapshot();
    }

    if (requested > this.#unused) throw new BudgetError("budget_exceeded", "reservation_exceeds_unused");
    this.#reservations.set(key, { amount: requested, state: "reserved", committed: 0n });
    this.#reserved += requested;
    return this.snapshot();
  }

  #reservation(key: string): Reservation {
    const reservation = this.#reservations.get(key);
    if (!reservation) throw new BudgetError("state_invalid", "reservation_unknown");
    return reservation;
  }

  /** Debits the actual sponsored cost, never more than was reserved, and releases the rest. */
  commit(key: string, actual: Uint): Budget {
    const reservation = this.#reservation(key);
    const charged = parse(actual, "commit_invalid");

    if (reservation.state === "rolledBack") throw new BudgetError("state_invalid", "reservation_rolled_back");
    if (reservation.state === "committed") {
      if (reservation.committed !== charged) throw new BudgetError("idempotency_conflict", "commit_amount_changed");
      return this.snapshot();
    }
    if (charged > reservation.amount) throw new BudgetError("budget_exceeded", "commit_exceeds_reservation");

    this.#reserved -= reservation.amount;
    this.#spent += charged;
    this.#reservations.set(key, { ...reservation, state: "committed", committed: charged });
    return this.snapshot();
  }

  /** Releases a failed or expired reservation. Repeating it changes nothing. */
  rollback(key: string): Budget {
    const reservation = this.#reservation(key);
    if (reservation.state === "committed") throw new BudgetError("state_invalid", "reservation_committed");
    if (reservation.state === "rolledBack") return this.snapshot();

    this.#reserved -= reservation.amount;
    this.#reservations.set(key, { ...reservation, state: "rolledBack" });
    return this.snapshot();
  }

  /** Releases every open reservation and returns the unused ETH owed to the owner (FR-016). */
  close(): Uint {
    if (this.#closed) return "0";
    for (const [key, reservation] of this.#reservations) {
      if (reservation.state === "reserved") this.rollback(key);
    }
    const returned = this.#unused;
    this.#closed = true;
    return returned.toString();
  }
}
