/**
 * T088's predicate, so the soak is passed or failed rather than judged.
 *
 * FR-039 asks for forty-eight hours on testnet from the same code, alerting
 * on, with no charge left unrecorded for more than four hours (SC-004). That
 * is a claim about a period, not about a moment, so it cannot be answered by
 * one read of the chain: a charge queued and posted late is invisible
 * afterwards, because the queue entry only says `posted`. The soak is
 * therefore sampled — each sample is a line in a file — and this module holds
 * the two pure halves: what one sample says, and whether a run of them passes.
 *
 * Every figure in a sample comes from the pool's own public views, so the
 * record an outside reader could have kept is the record we keep (SC-009).
 */

/** The four-hour bound of FR-023 and SC-004, in seconds: two missed posting runs. */
export const UNRECORDED_LIMIT_SECONDS = 4 * 3600;

/** FR-039's duration, in milliseconds. */
export const SOAK_MS = 48 * 3600 * 1000;

export type Sample = {
  /** Wall clock of the sampler, ISO. The gap between samples is measured on this. */
  at: string;
  /** The chain's own clock at the sampled block, seconds. Ages are measured on this. */
  chainTime: number;
  blockNumber: number;
  /** Queued charges not yet posted. */
  unposted: number;
  /** The oldest unposted charge's age in seconds, 0 when there is none. */
  oldestUnpostedSeconds: number;
  paused: boolean;
  /** `poolIsWhole`: the pool holds at least what it owes. */
  whole: boolean;
  /** The operator's balance in wei, as a string; the float alert is FR-023's, not this. */
  operatorWei: string;
};

export type SoakVerdict = {
  pass: boolean;
  /** Why it failed, one line each; empty when it passed. */
  faults: string[];
  samples: number;
  /** Wall-clock span of the run, milliseconds. */
  spanMs: number;
  /** The worst unposted age seen, seconds. */
  worstUnpostedSeconds: number;
  /** The longest silence between two samples, milliseconds. */
  worstGapMs: number;
};

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Whether a run of samples passes T088. Four things have to hold, and each
 * failure names itself:
 *
 *   - the run covers at least `minMs` (FR-039's forty-eight hours);
 *   - no sample saw a charge unposted longer than four hours (SC-004);
 *   - the pool was whole in every sample (SC-009) and never paused — a pause
 *     during the soak is a trigger that fired, which FR-035 says must be
 *     accounted for and resumed before the beta opens, so the soak restarts;
 *   - no silence longer than `maxGapMs`. A sampler that stopped for an hour
 *     cannot say what happened in that hour, and an unwatched hour is not a
 *     soaked hour. This is the check that makes the other three mean
 *     something.
 */
export const soakVerdict = (
  samples: readonly Sample[],
  options: { minMs?: number; maxGapMs?: number; limitSeconds?: number } = {},
): SoakVerdict => {
  const minMs = options.minMs ?? SOAK_MS;
  const maxGapMs = options.maxGapMs ?? 30 * 60_000;
  const limit = options.limitSeconds ?? UNRECORDED_LIMIT_SECONDS;
  const faults: string[] = [];

  if (samples.length === 0) {
    return { pass: false, faults: ["no samples: the soak never ran"], samples: 0, spanMs: 0, worstUnpostedSeconds: 0, worstGapMs: 0 };
  }

  const times = samples.map((s) => Date.parse(s.at));
  if (times.some(Number.isNaN)) faults.push("a sample has no readable timestamp");
  const spanMs = Math.max(...times) - Math.min(...times);
  if (spanMs < minMs) faults.push(`the run covers ${(spanMs / 3_600_000).toFixed(1)} h, short of the ${(minMs / 3_600_000).toFixed(0)} h FR-039 asks for`);

  const ordered = [...times].sort((a, b) => a - b);
  let worstGapMs = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    const gap = ordered[i]! - ordered[i - 1]!;
    if (gap > worstGapMs) worstGapMs = gap;
  }
  if (worstGapMs > maxGapMs) {
    faults.push(`${(worstGapMs / 60_000).toFixed(0)} min of silence between samples: an unwatched hour is not a soaked hour`);
  }

  const worstUnpostedSeconds = samples.reduce((worst, s) => Math.max(worst, s.oldestUnpostedSeconds), 0);
  const late = samples.filter((s) => s.oldestUnpostedSeconds > limit);
  if (late.length > 0) {
    faults.push(`a charge went unrecorded for ${(worstUnpostedSeconds / 3600).toFixed(1)} h, past the ${(limit / 3600).toFixed(0)} h bound, first seen at ${late[0]!.at}`);
  }

  const pausedAt = samples.find((s) => s.paused);
  if (pausedAt) faults.push(`the pool was paused at ${pausedAt.at}: account for the trigger, resume, and soak again`);

  const shortAt = samples.find((s) => !s.whole);
  if (shortAt) faults.push(`the pool held less than it owed at ${shortAt.at}`);

  return { pass: faults.length === 0, faults, samples: samples.length, spanMs, worstUnpostedSeconds, worstGapMs };
};

/** One line for a person reading the run: what it covered and the worst it saw. */
export const soakSummary = (v: SoakVerdict, samples: readonly Sample[]): string => {
  if (samples.length === 0) return "no samples";
  const times = samples.map((s) => Date.parse(s.at));
  return [
    `${v.samples} samples over ${(v.spanMs / 3_600_000).toFixed(1)} h (${iso(Math.min(...times))} → ${iso(Math.max(...times))})`,
    `worst unrecorded charge ${(v.worstUnpostedSeconds / 60).toFixed(0)} min of ${(UNRECORDED_LIMIT_SECONDS / 60).toFixed(0)} allowed`,
    `longest silence ${(v.worstGapMs / 60_000).toFixed(0)} min`,
  ].join("\n");
};
