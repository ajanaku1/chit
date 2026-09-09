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

/** The reason a draw cannot be committed, or undefined. */
export const drawIssue = (amount: string, available: string): string | undefined => {
  if (!DECIMAL.test(amount) || BigInt(amount) === 0n) return "Enter how much of your balance this fleet may spend.";
  if (BigInt(amount) > BigInt(DRAW_CAP)) return `A fleet may hold at most ${toEth(DRAW_CAP)} ETH.`;
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
export const launchState = (draw: string, available: string): { disabled: boolean; note: string } => {
  const issue = drawIssue(draw, available);
  if (issue) return { disabled: true, note: issue };
  return { disabled: false, note: `Your balance is ${toEth(available)} ETH.` };
};

/** The only two answers a transaction can give, and the one it gives before it answers. */
export const receiptOutcome = (receipt: { status?: string } | null | undefined): { ok: boolean; message: string } => {
  if (!receipt) return { ok: false, message: "Sent, but not confirmed yet. Waiting on the chain." };
  if (receipt.status === "0x1") return { ok: true, message: "Confirmed." };
  return { ok: false, message: "The chain rejected it: the transaction reverted." };
};

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
const CACHE_PREFIX = "chit-balance:";

/** How long a signed read stands in before the page asks for another signature. */
export const FRESH_MS = 60_000;

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
