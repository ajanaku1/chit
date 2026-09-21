/**
 * The resume gate (FR-035, T051): a paused pool is not unpaused until the
 * cause is recorded as fixed, a test covers it, the pool is whole, and an
 * account of it has been published. Unpausing is the admin's cold key on
 * chain (setPaused(false)), which no service can gate, so the gate is a
 * check the runbook puts before that transaction: scripts/fleet-resume-check.ts
 * reads the incident record and the pool and refuses in words. Pure here, so
 * every refusal is a test.
 */

import { poolIsWhole, shortfall, identityHolds, type PoolCounters } from "./pool-solvency.js";

/** incidents/<id>.md, its fields; see incidents/README.md for the form. */
export type IncidentRecord = {
  id: string;
  trigger: string;
  cause: string;
  /** The commit that fixed the cause. */
  fixedIn: string;
  /** The test that covers it, by name, in the repository. */
  test: string;
  /** Where the account was published to depositors (FR-026). */
  publishedAt: string;
  /** How the pool was made whole, when it was short (FR-036). */
  madeWholeBy?: string;
};

export type GateVerdict = { ok: boolean; reasons: string[] };

export const resumeGate = (
  incident: IncidentRecord | undefined,
  testExists: (name: string) => boolean,
  counters: PoolCounters,
): GateVerdict => {
  const reasons: string[] = [];
  if (!incident) reasons.push("no incident record: write incidents/<id>.md first (incidents/README.md)");
  else {
    for (const field of ["trigger", "cause", "fixedIn", "test", "publishedAt"] as const) {
      if (!incident[field] || incident[field].trim() === "") reasons.push(`the incident record has no ${field}`);
    }
    if (incident.fixedIn && !/^[0-9a-f]{7,40}$/i.test(incident.fixedIn.trim())) reasons.push(`fixedIn is not a commit: ${incident.fixedIn}`);
    if (incident.test && !testExists(incident.test)) reasons.push(`no test named ${incident.test} exists in the repository`);
  }
  if (!identityHolds(counters)) reasons.push("the pool's balance does not match its counters: ETH moved without being counted");
  const gap = shortfall(counters);
  if (gap > 0n) reasons.push(`the pool is short by ${gap} wei of what it owes its depositors: donate() it whole first`);
  if (gap === 0n && incident && !poolIsWhole(counters)) reasons.push("the pool is not whole");
  return { ok: reasons.length === 0, reasons };
};
