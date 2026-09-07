import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

/**
 * The whole privacy claim is one sentence: no single transaction names both a
 * depositor and a campaign (FR-009). That is a property of the interface, so it
 * is checked against the compiled ABI rather than trusted to review.
 */

// Anchored on the working directory: this file is run from `dist-fleet/` and
// `dist/`, so its own depth is not a reliable way back to the repo root.
const artifact = join(process.cwd(), "artifacts/contracts/fleet/FleetPool.sol/FleetPool.json");

type AbiParam = { name: string; type: string; components?: AbiParam[] };
type AbiEntry = { type: string; name?: string; inputs?: AbiParam[]; outputs?: AbiParam[] };

const DEPOSITOR_NAMES = new Set(["depositor", "owner", "trader", "primarywallet"]);
const CAMPAIGN_NAMES = new Set(["campaign", "campaignkey", "fleet"]);

const names = (params: readonly AbiParam[] = []): string[] =>
  params.flatMap((p) => [p.name.toLowerCase(), ...names(p.components ?? [])]);

const loadAbi = async (): Promise<AbiEntry[]> =>
  (JSON.parse(await readFile(artifact, "utf8")) as { abi: AbiEntry[] }).abi;

test("no FleetPool function or event names both a depositor and a campaign", async () => {
  const abi = await loadAbi();
  const offenders: string[] = [];
  for (const entry of abi) {
    if (entry.type !== "function" && entry.type !== "event") continue;
    const all = [...names(entry.inputs), ...names(entry.outputs)];
    const hasDepositor = all.some((n) => DEPOSITOR_NAMES.has(n));
    const hasCampaign = all.some((n) => CAMPAIGN_NAMES.has(n));
    if (hasDepositor && hasCampaign) offenders.push(`${entry.type} ${entry.name}`);
  }
  assert.deepEqual(offenders, [], "one such signature would publish the link the pool exists to hide");
});

test("the depositor-side and campaign-side surfaces both exist and stay separate", async () => {
  const abi = await loadAbi();
  const fn = (name: string) => abi.find((e) => e.type === "function" && e.name === name);
  const ev = (name: string) => abi.find((e) => e.type === "event" && e.name === name);

  for (const name of ["deposit", "requestExit", "executeExit", "postQueued", "claimOperator"]) {
    assert.ok(fn(name), `missing depositor-side function ${name}`);
  }
  for (const name of ["openDraw", "fund", "fundPrincipal", "commit", "rollback", "closeDraw"]) {
    assert.ok(fn(name), `missing campaign-side function ${name}`);
  }
  assert.ok(ev("Deposited") && ev("SpendPosted") && ev("ExitPaid"), "depositor-side events");
  assert.ok(ev("DrawOpened") && ev("DrawFunded") && ev("PrincipalSent"), "campaign-side events");

  // queueSpend carries the encrypted reference, never a readable address.
  const queue = fn("queueSpend");
  assert.ok(queue, "missing queueSpend");
  assert.deepEqual(
    queue!.inputs?.map((i) => i.type),
    ["bytes", "uint256", "uint64"],
    "the depositor reaches a queued spend only as ciphertext",
  );
});
