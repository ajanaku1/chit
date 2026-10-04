/**
 * The mainnet bot is for $CHIT holders during the beta, as its cards say
 * (2026-10-01). The app gates the Sessions page on the main wallet's $CHIT;
 * the bot checks the same line itself (CHIT_TOKEN_ADDRESS, CHIT_FEE_THRESHOLD,
 * the app's own settings), so an account made on chain around the page, or a
 * wallet that sold its $CHIT after granting, cannot have the bot spend Chit's
 * gas on its buys. Sells are not gated: nobody is trapped in a position.
 */
import { holderAllowlistFromEnv } from "./holders-allowlist.js";
import type { Address } from "./types.js";

/** `unknown`: the balance could not be read; never a pass, never remembered, and never said as "holds less". */
export type HoldersVerdict = { ok: true } | { ok: false; holds: bigint; need: bigint } | { ok: false; unknown: true };
export type HoldersGate = (owner: Address) => Promise<HoldersVerdict>;

const PASS_MS = 5 * 60_000;
const REFUSE_MS = 60_000;

export const createHoldersGate = (p: { balanceOf: (owner: Address) => Promise<bigint>; threshold: bigint; now?: () => number; allowlist?: ReadonlySet<string> }): HoldersGate => {
  const now = p.now ?? Date.now;
  const seen = new Map<string, { at: number; verdict: HoldersVerdict }>();
  return async (owner) => {
    const key = owner.toLowerCase();
    // Let in without the line (CHIT_HOLDER_ALLOWLIST): no read, nothing remembered.
    if (p.allowlist?.has(key)) return { ok: true };
    const hit = seen.get(key);
    if (hit && now() - hit.at < (hit.verdict.ok ? PASS_MS : REFUSE_MS)) return hit.verdict;
    // A read that fails is unknown: the gate never opens on an answer it did not get, nor says the wallet holds less.
    let holds: bigint;
    try { holds = await p.balanceOf(owner); }
    catch (error) {
      console.warn("holders: balance read failed", owner, (error instanceof Error ? error.message : String(error)).split("\n")[0]);
      return { ok: false, unknown: true };
    }
    const verdict: HoldersVerdict = holds >= p.threshold ? { ok: true } : { ok: false, holds, need: p.threshold };
    seen.set(key, { at: now(), verdict });
    return verdict;
  };
};

const whole = (units: bigint): string => (units / 10n ** 18n).toLocaleString("en-US");

/** What a tap is told: the line and the wallet's balance, or, when the balance could not be read, that and nothing more. */
export const holdersAnswer = (owner: Address, v: Exclude<HoldersVerdict, { ok: true }>): string =>
  "unknown" in v ? "could not check your wallet's $CHIT just now. try again in a moment." : holdersRefusal(owner, v.holds, v.need);

export const holdersRefusal = (owner: Address, holds: bigint, need: bigint): string =>
  `the bot is for $CHIT holders during the beta. your wallet <code>${owner.slice(0, 6)}…${owner.slice(-4)}</code> holds <code>${whole(holds)}</code> $CHIT; the line is <code>${whole(need)}</code>. your account and its tokens stay yours: you can still sell here, or withdraw on the Sessions page.`;

/** The line from the app's own settings (CHIT_TOKEN_ADDRESS, CHIT_FEE_THRESHOLD in base units); either unset, as on the testnet host, is no line. */
export const holdersGateFromEnv = (balanceOf: (token: Address, owner: Address) => Promise<bigint>): HoldersGate | undefined => {
  const token = process.env.CHIT_TOKEN_ADDRESS?.trim();
  const threshold = process.env.CHIT_FEE_THRESHOLD?.trim();
  if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token) || !threshold || !/^\d+$/.test(threshold)) return undefined;
  return createHoldersGate({ balanceOf: (owner) => balanceOf(token as Address, owner), threshold: BigInt(threshold), allowlist: holderAllowlistFromEnv() });
};
