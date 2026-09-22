/**
 * Balance page logic.
 *
 * Every refusal here mirrors one the pool contract enforces. The page must not
 * offer a deposit or a withdrawal the chain would reject: a trader who learns a
 * limit from a reverted transaction has paid gas for the lesson.
 */

export type Headroom = { sizes: string[]; perTraderRemaining: string; poolRemaining: string };

export type BalanceState = {
  available: string;
  deposited: string;
  spent: string;
  openDraws: string;
  headroom: Headroom;
  /** The deployed pool's caps, when the service reports them; the published testnet numbers otherwise. */
  caps?: { depositor: string; draw: string; pool: string };
  exit: { requestedAt?: string; amount?: string; availableAt?: string };
  pool: { paused: boolean };
  /** Where the trader's own deposit and exit transactions go; set by the service. */
  poolAddress?: string;
};

export type DepositOption = { size: string; label: string; disabled: boolean; reason?: string };

/** Published sizes, ascending, matching the contract's constants. */
export const SIZES = ["10000000000000000", "50000000000000000", "100000000000000000"] as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[0-9]+$/;

/** Renders wei as ETH without trailing zeros: 10000000000000000 -> "0.01". */
export const toEth = (wei: string): string => {
  const padded = wei.padStart(19, "0");
  const whole = padded.slice(0, -18).replace(/^0+(?=\d)/, "");
  // Six decimals: a tile is a figure, not a ledger. Logic keeps the exact string.
  const frac = padded.slice(-18).slice(0, 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};

export const depositOptions = (state: BalanceState): DepositOption[] =>
  SIZES.map((size) => {
    const label = `${toEth(size)} ETH`;
    if (state.pool.paused) {
      return { size, label, disabled: true, reason: "Deposits are paused right now." };
    }
    if (BigInt(size) > BigInt(state.headroom.perTraderRemaining)) {
      return { size, label, disabled: true, reason: `Over your limit of ${toEth(state.headroom.perTraderRemaining)} ETH left.` };
    }
    if (BigInt(size) > BigInt(state.headroom.poolRemaining)) {
      return { size, label, disabled: true, reason: `The pool has only ${toEth(state.headroom.poolRemaining)} ETH of room left.` };
    }
    return { size, label, disabled: false };
  });

/**
 * The reason a withdrawal cannot proceed, or undefined. A destination equal to
 * the depositing wallet returns a reason that is advice, not a block; pass
 * `blocking` to ask only for reasons that must stop the form.
 */
export const withdrawIssue = (
  state: BalanceState,
  amount: string,
  destination: string,
  primaryWallet?: string,
  options: { blocking?: boolean } = {},
): string | undefined => {
  if (!DECIMAL.test(amount) || BigInt(amount) === 0n) return "Enter an amount to withdraw.";
  if (!ADDRESS.test(destination)) return "Enter the address that should receive the ETH.";
  if (BigInt(amount) > BigInt(state.available)) {
    return `That is more than your balance of ${toEth(state.available)} ETH.`;
  }
  if (state.pool.paused) return "Withdrawals are paused right now.";
  if (!options.blocking && primaryWallet && destination.toLowerCase() === primaryWallet.toLowerCase()) {
    return "Paying out to the same wallet you deposited from links them again. A fresh address keeps them apart.";
  }
  return undefined;
};

export type ExitStatus = "none" | "waiting" | "available";

export const exitView = (
  state: BalanceState,
  now: Date,
): { status: ExitStatus; availableAt?: string; amount?: string } => {
  const { requestedAt, availableAt, amount } = state.exit;
  if (!requestedAt || !availableAt) return { status: "none" };
  const ready = Date.parse(availableAt) <= now.getTime();
  return { status: ready ? "available" : "waiting", availableAt, ...(amount ? { amount } : {}) };
};

/** Mirrors the pool's per-draw cap, so the wizard refuses what the chain would. */
export const DRAW_CAP = "200000000000000000";

/** The per-draw cap the page should refuse against: the chain's, or the published testnet number. */
export const drawCapOf = (view: Pick<BalanceState, "caps"> | undefined): string => view?.caps?.draw ?? DRAW_CAP;

/** The reason a draw cannot be committed, or undefined. `cap` is the deployed pool's (drawCapOf). */
export const drawIssue = (amount: string, available: string, cap: string = DRAW_CAP): string | undefined => {
  if (!DECIMAL.test(amount) || BigInt(amount) === 0n) return "Enter how much of your balance this fleet may spend.";
  if (BigInt(amount) > BigInt(cap)) return `A fleet may hold at most ${toEth(cap)} ETH.`;
  if (BigInt(amount) > BigInt(available)) {
    return BigInt(available) === 0n
      ? "You have 0 ETH at Chit. Add some on the Balance page first."
      : `That is more than your balance of ${toEth(available)} ETH. Add more on the Balance page.`;
  }
  return undefined;
};

/**
 * The wait between activating and the fleet being funded. It is deliberate, and
 * saying so is the difference between a privacy feature and a broken page.
 */
export const fundingWait = (dueAt: string, now: Date): { ready: boolean; message: string } => {
  const remaining = Date.parse(dueAt) - now.getTime();
  if (Number.isNaN(remaining) || remaining <= 0) {
    return { ready: true, message: "Funding your fleet now." };
  }
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  return {
    ready: false,
    message:
      `Funding your fleet in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}. ` +
      "The wait is deliberate: it keeps your deposit and your fleet from lining up in time.",
  };
};

/** What a trader is shown for each internal campaign state. */
export const stateLabel = (state: string): string =>
  ({
    "Awaiting recovery confirmation": "Awaiting backup confirmation",
    "Awaiting funding": "Ready to activate",
    Activating: "Funding your fleet",
  })[state] ?? state;

/**
 * How long to wait before asking the service again, or undefined when there is
 * nothing left to wait for. Polling is not cosmetic here: each request sweeps,
 * so an open page is what funds a fleet whose wait has run out.
 */
export const pollDelayMs = (state: string, dueAt: string | undefined, now: Date): number | undefined => {
  if (state !== "Activating") return undefined;
  const remaining = dueAt === undefined ? NaN : Date.parse(dueAt) - now.getTime();
  if (Number.isNaN(remaining) || remaining <= 0) return 10_000;
  // Close to the deadline, check often; far from it, do not hammer the service.
  return Math.min(30_000, Math.max(5_000, remaining));
};

/**
 * Whether the launch button may be pressed, and what to say beneath it. The
 * same answer drives the button and the note, so a disabled button always has
 * a reason next to it.
 */
export const launchState = (draw: string, available: string, cap: string = DRAW_CAP): { disabled: boolean; note: string } => {
  const issue = drawIssue(draw, available, cap);
  if (issue) return { disabled: true, note: issue };
  return { disabled: false, note: `Your balance is ${toEth(available)} ETH.` };
};

/** The only two answers a transaction can give, and the one it gives before it answers. */
export const receiptOutcome = (receipt: { status?: string } | null | undefined): { ok: boolean; message: string } => {
  if (!receipt) return { ok: false, message: "Sent, but not confirmed yet. Waiting on the chain." };
  if (receipt.status === "0x1") return { ok: true, message: "Confirmed." };
  return { ok: false, message: "The chain rejected it: the transaction reverted." };
};

type Storage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};
const CACHE_PREFIX = "chit-balance:";

/**
 * How long a signed read stands in before the page asks for another signature.
 * Long, on purpose: a read costs a wallet prompt, so a short window means a
 * prompt every minute of ordinary use. Anything that moves the balance clears
 * the cache instead, which is what keeps it correct.
 */
export const FRESH_MS = 10 * 60_000;

export type CachedBalance = BalanceState & { savedAt?: number };

/** Keeps the last figures per wallet, so a page never blanks while it re-reads. */
export const saveCachedBalance = (storage: Storage, wallet: string, state: BalanceState, now = new Date()): void => {
  try {
    const entry: CachedBalance = { ...state, savedAt: now.getTime() };
    storage.setItem(`${CACHE_PREFIX}${wallet.toLowerCase()}`, JSON.stringify(entry));
  } catch {
    // Storage may be unavailable; the live read still works.
  }
};

export const loadCachedBalance = (storage: Storage, wallet: string): CachedBalance | undefined => {
  try {
    const raw = storage.getItem(`${CACHE_PREFIX}${wallet.toLowerCase()}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as CachedBalance;
    return typeof parsed.available === "string" && parsed.headroom ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Whether a cached read is recent enough to show without signing again. */
export const isFresh = (savedAt: number | undefined, now: Date, maxAgeMs = FRESH_MS): boolean =>
  savedAt !== undefined && now.getTime() - savedAt <= maxAgeMs;

/**
 * The one rule for putting a Chit balance on screen without signing: a kept
 * read still inside the fresh window, or nothing at all.
 *
 * Every surface that can show the figure asks this and only this. A page that
 * reached for the cache directly would show a balance its neighbour was still
 * gating, and a trader who sees the same number revealed in one place and
 * withheld in another learns that the gate is theatre.
 */
export const showableBalance = (storage: Storage, wallet: string, now = new Date()): CachedBalance | undefined => {
  const cached = loadCachedBalance(storage, wallet);
  return cached && isFresh(cached.savedAt, now) ? cached : undefined;
};

/** Whether the chosen deposit size may actually be added right now. */
export const canAddFunds = (state: BalanceState, selected: string | undefined): boolean => {
  if (!selected) return false;
  const option = depositOptions(state).find((entry) => entry.size === selected);
  return option !== undefined && !option.disabled;
};

/** Forgets a cached balance, so the next read is live. */
export const clearCachedBalance = (storage: Storage, wallet: string): void => {
  try {
    storage.removeItem?.(`${CACHE_PREFIX}${wallet.toLowerCase()}`);
  } catch {
    // Nothing to forget if storage is unavailable.
  }
};

/** The testnet pool's per-depositor cap, 0.5 ETH: the fallback when a read predates `caps`. */
export const TRADER_CAP = "500000000000000000";
/**
 * The withdrawal-refused state (design-mainnet-beta.md, T077, T078): what
 * happened, that nothing was recorded and nothing is owed, and that the exit
 * beside it needs nobody. `paused` is the same state for a paused pool. Any
 * other refusal is not this state and gets undefined.
 */
export const withdrawRefusal = (cause: { code: string; reason?: string } | { paused: true }): string | undefined => {
  if ("paused" in cause) {
    return "The pool is paused, so nothing moves through Chit right now. Nothing was recorded and nothing is owed. Your unspent deposit is still yours to take out of the pool yourself: that path doesn't need us.";
  }
  if (cause.code === "withdrawal_unavailable") {
    return "We can't pay this right now. Try again in a few minutes, or take it out of the pool yourself: that path doesn't need us. Nothing was recorded and nothing is owed.";
  }
  if (cause.code === "state_invalid" && cause.reason === "pool_paused") return withdrawRefusal({ paused: true });
  return undefined;
};

/** The per-depositor cap the page should show: the chain's, or the published testnet number. */
export const traderCapOf = (view: Pick<BalanceState, "caps"> | undefined): string => view?.caps?.depositor ?? TRADER_CAP;

/** How much of `cap` is taken, in wei, from what the contract says remains; never below zero. */
export const capUsed = (remaining: string, cap: string): string => {
  const total = BigInt(cap);
  const left = BigInt(remaining);
  return (total > left ? total - left : 0n).toString();
};

/** How much of `cap` is taken, 0..1, from what the contract says remains. */
export const capShare = (remaining: string, cap: string): number => {
  const total = BigInt(cap);
  if (total <= 0n) return 0;
  return Number((BigInt(capUsed(remaining, cap)) * 10_000n) / total) / 10_000;
};

/** The change since the figure this page last showed, for the arrow beside the balance. */
export const balanceDelta = (previous: string | undefined, next: string): { up: boolean; eth: string } | undefined => {
  if (previous === undefined || previous === next) return undefined;
  const before = BigInt(previous);
  const after = BigInt(next);
  return after > before ? { up: true, eth: toEth((after - before).toString()) } : { up: false, eth: toEth((before - after).toString()) };
};

/** How much of the per-fleet draw cap an amount uses, 0..1; `cap` is the deployed pool's (drawCapOf). */
export const drawShare = (amount: string, capWei: string = DRAW_CAP): number => {
  const cap = BigInt(capWei);
  const value = BigInt(amount);
  return value >= cap ? 1 : Number((value * 10_000n) / cap) / 10_000;
};

/** How far through the funding wait we are, 0..1, measured against its 15-minute ceiling. */
export const fundingProgress = (dueAt: string, now: Date, windowMs = 15 * 60_000): number => {
  const remaining = Date.parse(dueAt) - now.getTime();
  if (Number.isNaN(remaining)) return 0;
  return Math.min(1, Math.max(0, 1 - remaining / windowMs));
};

/** What the header's status pill says: only what the last balance read showed, never a guess. */
/** "testnet 46630" or "Robinhood Chain 4663": whatever chain-target.json says, never a string of the page's own. */
let chainLabelText = "testnet 46630";
export const setChainLabel = (label: string): void => { chainLabelText = label; };
export const chainLabel = (): string => chainLabelText;

export const poolStatus = (state: Pick<BalanceState, "pool"> | undefined): { text: string; live: boolean } | undefined =>
  state === undefined
    ? undefined
    : state.pool.paused
      ? { text: "Pool paused by the operator", live: false }
      : { text: `Pool live · ${chainLabel()}`, live: true };

/** The status pill speaks only from a read young enough to trust, so it never says "live" on stale news. */
export const freshPoolStatus = (
  cached: Pick<CachedBalance, "pool" | "savedAt"> | undefined,
  now: Date,
): ReturnType<typeof poolStatus> => (cached !== undefined && isFresh(cached.savedAt, now) ? poolStatus(cached) : undefined);

/**
 * One frame of a count-up. Mid-count frames keep the final figure's width,
 * and the last frame is the exact figure, never a rounding of it.
 */
export const countFrame = (value: number, to: number, exact: string): string =>
  value === to ? exact : value.toFixed(exact.split(".")[1]?.length ?? 0);
