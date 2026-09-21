/**
 * The outside monitor: what one snapshot of public chain state says about the
 * pool, held against what the deployment record expects.
 *
 * It exists because the costly failures here are silent. A charge that is not
 * posted inside POST_WINDOW can never be posted, and nothing on the service's
 * side has to notice; a service pointed at the wrong pool answers 503 to
 * everything and looks, from inside, like no traffic. So this runs outside the
 * service (monitor-cli.ts, on its own clock), reads only what anyone can read,
 * and holds no key: it could not open a sealed depositor if it wanted to.
 *
 * Pure. A snapshot goes in, findings come out; reading is monitor-reads.ts.
 * A finding's summary is aggregate (counts, totals, ages) and is what gets
 * sent; ids and keys, public as they are, stay in `detail`, for the run's log.
 */
import type { Address, Hex } from "viem";

export type QueuedCharge = { id: Hex; amount: bigint; dueAt: bigint; queuedAt: bigint; posted: boolean };
export type DrawSeen = { campaign: Hex; state: number; dueAt: bigint; reserved: bigint };

export type PoolSnapshot = {
  /** The block every figure was read at, and that block's own time. */
  block: bigint;
  chainTime: bigint;
  pool: Address;
  balance: bigint;
  totalDeposited: bigint;
  totalOutflow: bigint;
  totalClaimed: bigint;
  /** Only on a pool that counts them; the pool of 16 September does not. */
  counters?: { everDeposited: bigint; exitsPaid: bigint; donated: bigint };
  postWindow: bigint;
  paused: boolean;
  operator: Address;
  admin: Address;
  guardian: Address;
  operatorBalance: bigint;
  queue: readonly QueuedCharge[];
  draws: readonly DrawSeen[];
};

/** From the deployment record. A role the record does not name is not compared. */
export type Expected = { pool: Address; operator?: Address; admin?: Address; guardian?: Address };
export type Thresholds = { operatorWarn: bigint; operatorCritical: bigint; chargeAgeingSeconds: bigint; drawOverdueSeconds: bigint; staleSeconds: bigint };
export type SiteAnswer = { ok: true; poolAddress?: string } | { ok: false; reason: string };
export type Severity = "critical" | "warn";
/** Who is expected to act. Roles, not names: the names are in the readiness evidence, which the mirror does not carry. */
export type Acts = "operations" | "money-path" | "both";
export type Finding = { check: string; severity: Severity; acts: Acts; summary: string; detail?: readonly string[] };

/**
 * One chat for everything, split by who acts (settled 21 September 2026).
 * Operations: the sweep, the RPC, the functions. The money path: the operator's
 * balance, a charge left unposted, a buy left open. Both, at once: whatever may
 * end in a pause, and the pause itself. Two of the spec's three pause triggers
 * (FR-026) can be seen from outside: a pool that holds less than it should is
 * `accounting`, a charge past its deadline unrecorded is `charge-expired`. The
 * third, an exit transaction that failed, leaves nothing in the pool's views.
 */
export const ACTS: Record<string, Acts> = {
  "accounting": "both", "charge-expired": "both", "charge-at-risk": "both", "roles": "both", "site-pool": "both", "paused": "both",
  "charge-ageing": "money-path", "operator-balance": "money-path", "reservation-open": "money-path",
  "site-down": "operations", "draw-overdue": "operations", "chain-stale": "operations", "monitor-blind": "operations",
};

export const finding = (severity: Severity, check: string, summary: string, detail?: readonly string[]): Finding =>
  ({ check, severity, acts: ACTS[check] ?? "both", summary, ...(detail && detail.length > 0 ? { detail } : {}) });

/**
 * The operator figures here only say "can it still pay gas". What it must hold
 * to front withdrawals is the float, FLEET_OPERATOR_FLOAT_ETH, one variable for
 * the service and the monitor: the warning sits at half of it (monitor-cli.ts).
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  operatorWarn: 5n * 10n ** 16n,
  operatorCritical: 10n ** 16n,
  // Four hours is two posting runs missed: the posting clock is every two hours, whatever the window is.
  chargeAgeingSeconds: 4n * 3_600n,
  drawOverdueSeconds: 3_600n,
  staleSeconds: 900n,
};

const PENDING = 1;

export const formatEth = (wei: bigint): string => {
  const sign = wei < 0n ? "-" : "";
  const digits = (wei < 0n ? -wei : wei).toString().padStart(19, "0");
  const fraction = digits.slice(-18).replace(/0+$/, "");
  return `${sign}${digits.slice(0, -18)}${fraction ? `.${fraction}` : ""} ETH`;
};

const span = (seconds: bigint): string => {
  const s = seconds < 0n ? 0n : seconds;
  const [days, hours, minutes] = [s / 86_400n, (s % 86_400n) / 3_600n, (s % 3_600n) / 60n];
  return days > 0n ? `${days} d ${hours} h` : hours > 0n ? `${hours} h ${minutes} min` : `${minutes} min`;
};

/** For a digest someone reads on a phone: four decimals, cut and not rounded. Findings keep the exact figure. */
const shortEth = (wei: bigint): string => formatEth(wei - (wei % 10n ** 14n));
const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const sum = (charges: readonly QueuedCharge[]): bigint => charges.reduce((total, c) => total + c.amount, 0n);
const line = (c: QueuedCharge): string => `${c.id} · ${formatEth(c.amount)} · queued ${new Date(Number(c.queuedAt) * 1000).toISOString()}`;

export const assess = (
  snapshot: PoolSnapshot,
  expected: Expected,
  options: { wallClock: bigint; thresholds?: Partial<Thresholds>; acknowledged?: readonly Hex[]; site?: SiteAnswer },
): Finding[] => {
  const limits = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const found: Finding[] = [];
  const say = (severity: Severity, check: string, summary: string, detail?: readonly string[]): void => {
    found.push(finding(severity, check, summary, detail));
  };
  const { chainTime, postWindow: window } = snapshot;

  // ETH in is deposits and donations; ETH out is exits, outflow and claims. From
  // the views alone only a bound follows, because an exit takes the whole deposit
  // out of totalDeposited and pays back less; the counters make it exact.
  const spent = snapshot.totalOutflow + snapshot.totalClaimed;
  if (snapshot.counters) {
    const { everDeposited, exitsPaid, donated } = snapshot.counters;
    const gap = snapshot.balance - (everDeposited + donated - exitsPaid - spent);
    if (gap < 0n) say("critical", "accounting", `the pool holds ${formatEth(-gap)} less than its counters account for`);
    if (gap > 0n) say("warn", "accounting", `the pool holds ${formatEth(gap)} more than its counters account for`);
  } else if (snapshot.balance < snapshot.totalDeposited - spent) {
    say("critical", "accounting", `the pool holds ${formatEth(snapshot.totalDeposited - spent - snapshot.balance)} less than its deposits, outflow and claims allow`);
  }

  const settled = new Set((options.acknowledged ?? []).map((id) => id.toLowerCase()));
  const open = snapshot.queue.filter((c) => !c.posted);
  const age = (c: QueuedCharge): bigint => chainTime - c.queuedAt;
  const left = (c: QueuedCharge): bigint => c.queuedAt + window - chainTime;
  const expired = open.filter((c) => age(c) > window && !settled.has(c.id.toLowerCase()));
  const atRisk = open.filter((c) => age(c) <= window && age(c) * 6n >= window * 5n);
  const ageing = open.filter((c) => age(c) * 6n < window * 5n && age(c) >= limits.chargeAgeingSeconds);
  const soonest = (charges: readonly QueuedCharge[]): bigint => charges.reduce((least, c) => (left(c) < least ? left(c) : least), window);
  if (expired.length > 0) {
    say("critical", "charge-expired", `${count(expired.length, "charge")} never posted and past the posting window: ${formatEth(sum(expired))} nobody can be charged for`, expired.map(line));
  }
  if (atRisk.length > 0) {
    say("critical", "charge-at-risk", `${count(atRisk.length, "charge")} unposted with under a sixth of the window left (${formatEth(sum(atRisk))}); the closest has ${span(soonest(atRisk))}`, atRisk.map(line));
  }
  if (ageing.length > 0) {
    say("warn", "charge-ageing", `${count(ageing.length, "charge")} unposted for over ${span(limits.chargeAgeingSeconds)} (${formatEth(sum(ageing))}); the closest has ${span(soonest(ageing))} left`, ageing.map(line));
  }

  if (snapshot.operatorBalance < limits.operatorCritical) {
    say("critical", "operator-balance", `the operator holds ${formatEth(snapshot.operatorBalance)}, under ${formatEth(limits.operatorCritical)}`);
  } else if (snapshot.operatorBalance < limits.operatorWarn) {
    say("warn", "operator-balance", `the operator holds ${formatEth(snapshot.operatorBalance)}, under ${formatEth(limits.operatorWarn)}`);
  }

  const roles = ([["operator", snapshot.operator, expected.operator], ["admin", snapshot.admin, expected.admin], ["guardian", snapshot.guardian, expected.guardian]] as const)
    .filter(([, onChain, recorded]) => recorded !== undefined && !same(onChain, recorded));
  if (roles.length > 0) {
    say("critical", "roles", `the ${roles.map(([name]) => name).join(" and the ")} on chain ${roles.length === 1 ? "is" : "are"} not the one the deployment record names`,
      roles.map(([name, onChain, recorded]) => `${name}: ${onChain} on chain, ${String(recorded)} recorded`));
  }

  if (options.site && !options.site.ok) say("critical", "site-down", `the hosted service did not answer: ${options.site.reason}`);
  if (options.site?.ok && !(options.site.poolAddress && same(options.site.poolAddress, expected.pool))) {
    say("critical", "site-pool", options.site.poolAddress
      ? "the hosted service is configured with a pool that is not the recorded one"
      : "the hosted service names no pool: it has none configured",
    [`answered ${options.site.poolAddress ?? "nothing"}, recorded ${expected.pool}`]);
  }

  const overdue = snapshot.draws.filter((d) => d.state === PENDING && chainTime - d.dueAt >= limits.drawOverdueSeconds);
  if (overdue.length > 0) {
    const longest = overdue.reduce((most, d) => (chainTime - d.dueAt > most ? chainTime - d.dueAt : most), 0n);
    say("warn", "draw-overdue", `${count(overdue.length, "fleet")} not funded, the longest ${span(longest)} past its due time`, overdue.map((d) => d.campaign));
  }
  const reserved = snapshot.draws.filter((d) => d.reserved !== 0n);
  if (reserved.length > 0) {
    say("warn", "reservation-open", `${count(reserved.length, "draw")} with a reservation left open (${formatEth(reserved.reduce((t, d) => t + d.reserved, 0n))}): a buy that was funded and neither committed nor rolled back`, reserved.map((d) => d.campaign));
  }
  if (snapshot.paused) say("warn", "paused", "the pool is paused: deposits, draws, funding and claims are stopped; exits still work");
  if (options.wallClock - chainTime > limits.staleSeconds) {
    say("warn", "chain-stale", `the newest block is ${span(options.wallClock - chainTime)} old: the chain or the RPC is not moving, and every figure here is that old`);
  }

  return [...found.filter((f) => f.severity === "critical"), ...found.filter((f) => f.severity === "warn")];
};

const lines = (findings: readonly Finding[]): string[] =>
  findings.map((f) => `${f.severity === "critical" ? "CRITICAL" : "warn"} ${f.check} (${f.acts}): ${f.summary}`);

/** What is sent. Summaries only, each with who is expected to act: the detail stays in the run's log. */
export const alertText = (findings: readonly Finding[], where: { chainId: number; block: bigint }): string =>
  findings.length === 0 ? "" : [`Chit pool monitor · chain ${where.chainId} · block ${where.block}`, ...lines(findings)].join("\n");

/** Once a day, findings or not: a monitor that only speaks when something is wrong cannot be told from one that died. */
export const digestText = (snapshot: PoolSnapshot, findings: readonly Finding[], where: { chainId: number; block: bigint }): string => {
  const open = snapshot.queue.filter((c) => !c.posted);
  const oldest = open.reduce((most, c) => (snapshot.chainTime - c.queuedAt > most ? snapshot.chainTime - c.queuedAt : most), 0n);
  const waiting = snapshot.draws.filter((d) => d.state === PENDING).length;
  return [
    `Chit pool monitor · daily digest · chain ${where.chainId} · block ${where.block}`,
    `pool ${shortEth(snapshot.balance)} · deposited ${shortEth(snapshot.totalDeposited)} · outflow ${shortEth(snapshot.totalOutflow)} · claimed ${shortEth(snapshot.totalClaimed)}`,
    `${count(snapshot.queue.length, "charge")}, ${open.length === 0 ? "all posted" : `${open.length} unposted, the oldest ${span(oldest)} old`} · ${count(snapshot.draws.length, "draw")}, ${waiting} waiting for funding`,
    `operator ${shortEth(snapshot.operatorBalance)} · ${snapshot.paused ? "PAUSED" : "not paused"}`,
    ...(findings.length === 0 ? ["nothing to report"] : lines(findings)),
  ].join("\n");
};
