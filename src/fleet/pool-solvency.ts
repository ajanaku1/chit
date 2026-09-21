/**
 * What the pool owes its depositors, and whether it holds it, from public
 * views alone (FR-027, FR-035). The pool cannot list its depositors, so the
 * sum of their unspent deposits is not readable directly; it follows from
 * the counters, because a charge posts only what a deposit still backs
 * (FR-033) and an exit pays exactly the unspent part:
 *
 *   for one depositor, deposited == posted + paidOut once they have left, so
 *   over everyone who has left:  everDeposited - totalDeposited == postedToLeavers + exitsPaid
 *   the current depositors are owed:  totalDeposited - (totalPosted - postedToLeavers)
 *                                  == everDeposited - exitsPaid - totalPosted
 *
 * and the pool holds  everDeposited + donated - totalOutflow - exitsPaid - totalClaimed
 * (the identity the monitor asserts), so it is whole exactly when
 *   totalPosted + donated >= totalOutflow + totalClaimed.
 */

export type PoolCounters = {
  balance: bigint;
  everDeposited: bigint;
  totalDeposited: bigint;
  totalPosted: bigint;
  totalOutflow: bigint;
  totalClaimed: bigint;
  exitsPaid: bigint;
  donated: bigint;
};

/** The identity every wei has to satisfy; false means ETH moved without being counted. */
export const identityHolds = (c: PoolCounters): boolean =>
  c.balance === c.everDeposited + c.donated - c.totalOutflow - c.exitsPaid - c.totalClaimed;

/** What current depositors could take out through the exit, from the counters. */
export const owedToDepositors = (c: PoolCounters): bigint => {
  const owed = c.everDeposited - c.exitsPaid - c.totalPosted;
  return owed > 0n ? owed : 0n;
};

/** How far the pool is from paying everyone it owes; zero when it can. */
export const shortfall = (c: PoolCounters): bigint => {
  const gap = owedToDepositors(c) - c.balance;
  return gap > 0n ? gap : 0n;
};

export const poolIsWhole = (c: PoolCounters): boolean => identityHolds(c) && shortfall(c) === 0n;
