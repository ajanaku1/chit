import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createPublicClient, http } from "viem";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService } from "../../src/fleet/campaign-service.js";
import type { PoolPort } from "../../src/fleet/pool-buy.js";
import { FLEET_BLOCK_TIME_MS, fleetChain } from "../../src/fleet/service-runtime.js";

/**
 * The sweep's clocks. A charge that is queued and not posted inside the pool's
 * POST_WINDOW is lost, and the pool is short by that much, so how often a
 * posting can happen, how long one may run and how fast it hears back are
 * facts worth holding. Each is read from the file that decides it.
 *
 * Two clocks, kept apart on purpose. The one that QUEUES what is owed is a
 * privacy parameter: its cadence is the size of the batch a charge hides in,
 * and it does not move here. The one that POSTS what is due is only about not
 * missing the window, so it may tick as often as it likes.
 */

// Anchored on the working directory, like pool-abi.test.ts.
const root = process.cwd();
const read = (path: string): Promise<string> => readFile(join(root, path), "utf8");

type VercelConfig = {
  functions?: Record<string, { maxDuration?: number }>;
  crons?: { path: string; schedule: string }[];
};
const vercel = async (): Promise<VercelConfig> => JSON.parse(await read("vercel.json")) as VercelConfig;

const QUEUEING_PATH = "/api/fleet/sweep";
const POSTING_PATH = "/api/fleet/sweep-posting";

/** One cron field, for the shapes these files use: `*`, `a`, `a,b`, `a-b`, and any of them with `/n`. */
const expand = (field: string, max: number): number[] => {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range = "*", step = "1"] = part.split("/");
    const [from, to] = range === "*" ? [0, max] : range.includes("-") ? range.split("-").map(Number) : [Number(range), step === "1" ? Number(range) : max];
    for (let v = from ?? 0; v <= (to ?? max); v += Number(step)) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
};

/** Minutes past midnight UTC at which a daily cron fires. Day, month and weekday must be `*`. */
const firings = (schedule: string): number[] => {
  const [minute = "", hour = "", ...rest] = schedule.trim().split(/\s+/);
  assert.deepEqual(rest, ["*", "*", "*"], `${schedule}: only every-day schedules are understood here`);
  return expand(hour, 23).flatMap((h) => expand(minute, 59).map((m) => h * 60 + m)).sort((a, b) => a - b);
};

/** The longest stretch of the day, in minutes, in which none of these fire. */
const largestGap = (minutes: number[]): number => {
  const sorted = [...new Set(minutes)].sort((a, b) => a - b);
  assert.ok(sorted.length > 0, "nothing fires at all");
  return Math.max(...sorted.map((at, i) => (i === 0 ? at + 24 * 60 - (sorted[sorted.length - 1] ?? at) : at - (sorted[i - 1] ?? at))));
};

const postWindowMinutes = async (): Promise<number> => {
  const hours = /uint64 public constant POST_WINDOW = (\d+) hours;/.exec(await read("contracts/fleet/FleetPool.sol"));
  assert.ok(hours, "FleetPool.sol no longer states POST_WINDOW in hours");
  return Number(hours[1]) * 60;
};

describe("how fast a write hears back", () => {
  it("waits for a receipt on the chain's clock, not on a twelve second block viem assumes when told nothing", () => {
    const url = "http://127.0.0.1:1";
    const client = createPublicClient({ chain: fleetChain(url), transport: http(url) });
    assert.ok(FLEET_BLOCK_TIME_MS <= 1_000, "Robinhood Chain seals a block well inside a second");
    assert.equal(client.pollingInterval, 500, "viem's floor; it was 4000 while the chain stated no block time");
  });
});

describe("how long a function may run", () => {
  it("every function under api/fleet says so, because the plan's default is nobody's decision", async () => {
    const files = (await readdir(join(root, "api/fleet"))).filter((name) => name.endsWith(".js")).map((name) => `api/fleet/${name}`).sort();
    const functions = (await vercel()).functions ?? {};
    const silent = files.filter((file) => typeof functions[file]?.maxDuration !== "number");
    assert.deepEqual(silent, []);
  });

  it("a sweep may run long enough for a hundred postings, and whoever calls it on a schedule waits longer than that", async () => {
    const functions = (await vercel()).functions ?? {};
    for (const file of ["api/fleet/sweep.js", "api/fleet/sweep-posting.js"]) {
      const seconds = functions[file]?.maxDuration ?? 0;
      // 28 postings took 39 s on the live pool on 2026-09-16: about a second and a half each.
      assert.ok(seconds >= 150, `${file} may run ${seconds}s`);

      const workflow = join(root, ".github/workflows/sweep.yml");
      if (!existsSync(workflow)) continue; // the public mirror strips .github
      const text = await readFile(workflow, "utf8");
      const patience = Math.min(...[...text.matchAll(/--max-time (\d+)/g)].map((m) => Number(m[1])));
      const job = Number(/timeout-minutes: (\d+)/.exec(text)?.[1] ?? 0) * 60;
      assert.ok(patience > seconds, `curl gives up after ${patience}s, before ${file} may finish`);
      assert.ok(job > patience, "the job gives up before curl does");
    }
  });
});

describe("how often a due charge can be posted", () => {
  it("from Vercel's clock alone, a posting is never further off than a third of POST_WINDOW, so two missed runs still fit", async () => {
    const crons = (await vercel()).crons ?? [];
    const posting = crons.filter((c) => c.path === QUEUEING_PATH || c.path === POSTING_PATH).flatMap((c) => firings(c.schedule));
    const window = await postWindowMinutes();
    assert.ok(largestGap(posting) <= window / 3, `the longest wait is ${largestGap(posting)} minutes against a window of ${window}`);
  });

  it("the clock that queues did not move: its cadence is the size of the batch a charge hides in", async () => {
    const queueing = ((await vercel()).crons ?? []).filter((c) => c.path === QUEUEING_PATH).map((c) => c.schedule).sort();
    assert.deepEqual(queueing, ["0 15 * * *", "0 3 * * *"]);

    const workflow = join(root, ".github/workflows/sweep.yml");
    if (!existsSync(workflow)) return; // the public mirror strips .github
    // Without its comments: the rule is about what runs, not about what is explained.
    const text = (await readFile(workflow, "utf8")).split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    assert.match(text, /cron: '17 \*\/4 \* \* \*'/);
    assert.doesNotMatch(text, /sweep-posting/, "GitHub's clock is the queueing one");
  });
});

describe("a posting-only sweep", () => {
  const router = (seen: { queueOwed?: boolean }[]): CampaignRouter => {
    const pool = {
      sweep: async (_accountsOf: unknown, options: { queueOwed?: boolean } = {}) => {
        seen.push(options);
        return { funded: [], posted: [], queued: 0 };
      },
    } as unknown as PoolPort;
    const service = new CampaignService({ origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 });
    return new CampaignRouter({ service, pool } as RouterDeps);
  };

  it("queues what is owed unless it is told not to, as the scheduled sweep always has", async () => {
    const seen: { queueOwed?: boolean }[] = [];
    const result = await router(seen).handle({ action: "sweep", body: {} });
    assert.equal(result.status, 200);
    assert.deepEqual(seen, [{ queueOwed: true }]);
  });

  it("posts and funds what is due and queues nothing, so it can tick often without shrinking a batch", async () => {
    const seen: { queueOwed?: boolean }[] = [];
    const result = await router(seen).handle({ action: "sweep", body: { queueOwed: false } });
    assert.equal(result.status, 200);
    assert.deepEqual(seen, [{ queueOwed: false }]);
  });

  it("is started only by a caller the scheduled sweep would admit, on either verb", async () => {
    const source = await read("api/fleet/sweep-posting.js");
    const verbs = [...source.matchAll(/export function (GET|POST)\(request\) \{([\s\S]*?)\n\}/g)];
    assert.deepEqual(verbs.map((v) => v[1]).sort(), ["GET", "POST"]);
    for (const [, verb, body = ""] of verbs) {
      assert.match(body, /if \(!sweepTriggerAllowed\(request, process\.env\.CRON_SECRET\)\)/, `${verb} is not gated`);
      assert.match(body, /return postingOnly\(request\);/, `${verb} answers with something other than the posting-only sweep`);
    }
    // The route writes the body itself, so nothing a caller sends can make it queue.
    assert.match(source, /JSON\.stringify\(\{ action: "sweep", body: \{ queueOwed: false \} \}\)/);
    assert.doesNotMatch(source, /request\.(json|text|body|formData)\b/, "the caller's body must never reach the router");
  });
});
