import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Address } from "viem";

import { finding, type PoolSnapshot } from "../../src/fleet/monitor.js";
import { configFrom, digestNow, httpRpc, notifyNow, probeSite, run } from "../../src/fleet/monitor-cli.js";

/**
 * The monitor's runner. It has to start on plain node with nothing installed
 * (that is what keeps an hourly run at a few seconds), say what it found, tell
 * somebody, and fail the run when something is critical. A monitor that cannot
 * read says so, as loudly as any finding.
 */

const ROOT = process.cwd();
const FILES = ["src/fleet/monitor.ts", "src/fleet/monitor-reads.ts", "src/fleet/monitor-cli.ts"];
const RECORD = { chainId: 46630, operator: "0x34b0Ba20669f3ec4F1056853780c381e5e35F724", admin: "0xCb70EfEfC73f241047262d4FACe6D21d052F6946", pool: { address: "0xb29139f3119d490eae473ba29fe8deadfb2c5ca5" } };
const T = 1_790_000_000n;

const snapshot = (over: Partial<PoolSnapshot> = {}): PoolSnapshot => ({
  block: 100n, chainTime: T, pool: RECORD.pool.address as Address, balance: 10n, totalDeposited: 10n, totalOutflow: 0n, totalClaimed: 0n,
  postWindow: 43_200n, paused: false, operator: RECORD.operator as Address, admin: RECORD.admin as Address,
  guardian: `0x${"0".repeat(40)}` as Address, operatorBalance: 10n ** 18n, queue: [], draws: [], ...over,
});

const answer = (status: number, body: unknown): Response => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("the monitor's runner", () => {
  it("starts on plain node from nothing but its own three files and the record", () => {
    const dir = mkdtempSync(join(tmpdir(), "chit-monitor-"));
    try {
      for (const file of [...FILES, "deployments/fleet-46630.json"]) {
        mkdirSync(join(dir, file, ".."), { recursive: true });
        cpSync(join(ROOT, file), join(dir, file));
      }
      const help = spawnSync(process.execPath, ["src/fleet/monitor-cli.ts", "--help"], { cwd: dir, encoding: "utf8" });
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /MONITOR_CHAT_ID/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports no package: node's own modules, types, and its siblings by their own extension", () => {
    for (const file of FILES) {
      const source = readFileSync(join(ROOT, file), "utf8");
      const values = [...source.matchAll(/^import (?!type\b)[^;]*?from "([^"]+)";/gms)].map((m) => m[1] ?? "");
      assert.deepEqual(values.filter((from) => !from.startsWith("node:")), [], `${file} imports a value from outside node`);
      assert.doesNotMatch(source, /\benum\b|\bnamespace\b/, `${file} uses syntax node cannot strip`);
    }
  });

  it("reads what to expect from the deployment record, and its thresholds in ETH", () => {
    const config = configFrom({ MONITOR_OPERATOR_WARN_ETH: "0.3", MONITOR_OPERATOR_CRITICAL_ETH: "0.12", MONITOR_SITE_URL: "https://chit.tools/" }, RECORD);
    assert.deepEqual(config.expected, { pool: RECORD.pool.address, operator: RECORD.operator, admin: RECORD.admin });
    assert.deepEqual(config.thresholds, { operatorWarn: 3n * 10n ** 17n, operatorCritical: 12n * 10n ** 16n });
    assert.equal(config.site, "https://chit.tools");
    assert.equal(config.rpcUrl, "https://rpc.testnet.chain.robinhood.com");
    assert.equal(configFrom({ ROBINHOOD_TESTNET_RPC_URL: "https://private.example" }, RECORD).rpcUrl, "https://private.example");
    assert.equal(configFrom({}, { ...RECORD, chainId: 4663 }).rpcUrl, "https://rpc.mainnet.chain.robinhood.com");
    assert.deepEqual(configFrom({}, { ...RECORD, pool: { ...RECORD.pool, guardian: "0x00000000000000000000000000000000000000aa" } }).expected.guardian, "0x00000000000000000000000000000000000000aa");
    // The float is one variable, read by the service and by the monitor: the warning sits at half of it (FR-032).
    assert.deepEqual(configFrom({ FLEET_OPERATOR_FLOAT_ETH: "0.2" }, RECORD).thresholds, { operatorWarn: 10n ** 17n });
    assert.deepEqual(configFrom({ FLEET_OPERATOR_FLOAT_ETH: "0.2", MONITOR_OPERATOR_WARN_ETH: "0.3" }, RECORD).thresholds, { operatorWarn: 10n ** 17n }, "the float wins: one figure, not two");
    assert.throws(() => configFrom({ FLEET_OPERATOR_FLOAT_ETH: "plenty" }, RECORD), /FLEET_OPERATOR_FLOAT_ETH/);
    assert.throws(() => configFrom({}, { chainId: 46630 }), /no pool/);
    assert.throws(() => configFrom({ MONITOR_OPERATOR_WARN_ETH: "lots" }, RECORD), /MONITOR_OPERATOR_WARN_ETH/);
  });

  it("sends what is critical every run, and what is only a warning every sixth hour", () => {
    const warn = [finding("warn", "paused", "")];
    const critical = [...warn, finding("critical", "accounting", "")];
    assert.equal(notifyNow([], 0), false);
    assert.deepEqual([0, 1, 5, 6, 12, 18, 23].map((hour) => notifyNow(warn, hour)), [true, false, false, true, true, true, false]);
    assert.ok([0, 1, 7, 23].every((hour) => notifyNow(critical, hour)));
  });

  it("asks the hosted service the question the app asks, with nobody's wallet", async () => {
    const asked: { url: string; body: string }[] = [];
    const fetcher = (status: number, body: unknown) => async (url: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(url), body: String(init?.body) });
      return answer(status, body);
    };
    assert.deepEqual(await probeSite(fetcher(200, { quoteId: "q", poolAddress: RECORD.pool.address }), "https://chit.tools"), { ok: true, poolAddress: RECORD.pool.address });
    assert.equal(asked[0]?.url, "https://chit.tools/api/fleet/campaign");
    assert.deepEqual(JSON.parse(asked[0]?.body ?? "{}"), { action: "quote", body: { primaryWallet: `0x${"0".repeat(40)}` } });
    assert.deepEqual(await probeSite(fetcher(200, { quoteId: "q" }), "https://chit.tools"), { ok: true });
    asked.length = 0;
    assert.deepEqual(await probeSite(fetcher(503, { code: "dependency_evidence_invalid" }), "https://chit.tools", 0), { ok: false, reason: "HTTP 503" });
    assert.equal(asked.length, 2, "one retry, so a single blip is not an alert");
    assert.deepEqual(await probeSite(async () => { throw new Error("getaddrinfo ENOTFOUND\n  at …"); }, "https://chit.tools", 0), { ok: false, reason: "getaddrinfo ENOTFOUND" });
  });

  it("retries a transport failure, and hands a JSON-RPC error straight back", async () => {
    let calls = 0;
    const flaky = httpRpc("https://rpc.example", async () => (++calls < 3 ? answer(429, "slow down") : answer(200, { jsonrpc: "2.0", id: 1, result: "0x10" })), 0);
    assert.equal(await flaky("eth_blockNumber", []), "0x10");
    assert.equal(calls, 3);
    const refusing = httpRpc("https://rpc.example", async () => { calls += 1; return answer(200, { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted\nmore" } }); }, 0);
    calls = 0;
    await assert.rejects(refusing("eth_call", []), /execution reverted$/);
    assert.equal(calls, 1);
    await assert.rejects(httpRpc("https://rpc.example", async () => answer(502, "bad gateway"), 0)("eth_call", []), /HTTP 502/);
  });

  it("reports, alerts the monitor's own chat and never the group's, and fails the run on a critical finding", async () => {
    const out: string[] = [];
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const deps = (over: Partial<Parameters<typeof run>[0]> = {}): Parameters<typeof run>[0] => ({
      record: RECORD, env: { TELEGRAM_BOT_TOKEN: "t0ken", MONITOR_CHAT_ID: "-100123", TELEGRAM_CHAT_ID: "-100999" },
      chainId: async () => 46630, read: async () => snapshot(), now: () => new Date(Number(T + 5n) * 1000), log: (text) => out.push(text),
      fetch: async (url, init) => { sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> }); return answer(200, { ok: true }); },
      ...over,
    });

    const posts = (): number => sent.length; // asked through a function: assert narrows what it is handed
    assert.equal(await run(deps()), 0);
    assert.match(out.join("\n"), /nothing to report/);
    assert.equal(posts(), 0);

    assert.equal(await run(deps({ read: async () => snapshot({ balance: 1n }) })), 1);
    assert.equal(posts(), 1);
    assert.match(sent[0]?.url ?? "", /bott0ken\/sendMessage$/);
    assert.equal(sent[0]?.body["chat_id"], "-100123");
    assert.match(String(sent[0]?.body["text"]), /CRITICAL accounting/);
    assert.ok(!out.join("\n").includes("t0ken"), "the token is never printed");

    sent.length = 0;
    assert.equal(await run(deps({ env: { TELEGRAM_BOT_TOKEN: "t0ken", TELEGRAM_CHAT_ID: "-100999" }, read: async () => snapshot({ balance: 1n }) })), 1);
    assert.equal(posts(), 0, "without its own chat the monitor prints and fails the run; it does not post to the group");
  });

  it("sends a digest once a day whether or not anything is wrong, so silence means something", async () => {
    assert.deepEqual([6, 7, 8].map((hour) => digestNow(hour, {})), [false, true, false]);
    assert.ok(digestNow(19, { MONITOR_DIGEST_HOUR_UTC: "19" }) && !digestNow(7, { MONITOR_DIGEST_HOUR_UTC: "19" }));

    const texts: string[] = [];
    const at = (iso: string, over: Partial<PoolSnapshot> = {}): Parameters<typeof run>[0] => ({
      record: RECORD, env: { TELEGRAM_BOT_TOKEN: "t0ken", MONITOR_CHAT_ID: "-100123" }, chainId: async () => 46630,
      read: async () => snapshot({ chainTime: BigInt(Date.parse(iso) / 1000), ...over }), now: () => new Date(iso), log: () => undefined,
      fetch: async (_, init) => { texts.push(String((JSON.parse(String(init?.body)) as { text: string }).text)); return answer(200, { ok: true }); },
    });
    const count = (): number => texts.length;
    assert.equal(await run(at("2026-10-01T07:23:10Z")), 0);
    assert.equal(count(), 1);
    assert.match(texts[0] ?? "", /daily digest[\s\S]*nothing to report/);
    assert.equal(await run(at("2026-10-01T08:23:10Z")), 0);
    assert.equal(count(), 1, "an hour later a healthy pool is silence again");
    assert.equal(await run(at("2026-10-01T07:23:10Z", { balance: 1n })), 1);
    assert.equal(count(), 2, "at the digest hour the findings ride in the digest: one message, not two");
    assert.match(texts[1] ?? "", /daily digest[\s\S]*CRITICAL accounting \(both\)/);
  });

  it("says so when it cannot see: a dead RPC or the wrong chain is a finding, not a quiet pass", async () => {
    const out: string[] = [];
    const base = { record: RECORD, env: {}, now: () => new Date(Number(T) * 1000), log: (text: string) => out.push(text), fetch: async () => answer(200, {}) };
    assert.equal(await run({ ...base, chainId: async () => 46630, read: async () => { throw new Error("fetch failed\n  at node:internal"); } }), 1);
    assert.match(out.join("\n"), /CRITICAL monitor-blind \(operations\): .*fetch failed$/m);
    out.length = 0;
    assert.equal(await run({ ...base, chainId: async () => 4663, read: async () => snapshot() }), 1);
    assert.match(out.join("\n"), /monitor-blind \(operations\): the RPC is chain 4663, the record is chain 46630/);

    // One failed read is a node that lagged or a dropped request; the second try picks a new block.
    let reads = 0;
    out.length = 0;
    assert.equal(await run({ ...base, chainId: async () => 46630, read: async () => { if (++reads === 1) throw new Error("unsupported block number"); return snapshot(); } }), 0);
    assert.equal(reads, 2);
    assert.match(out.join("\n"), /nothing to report/);
  });

  // The public mirror strips .github; this is a rule about the private repository's clock.
  const WORKFLOW = join(ROOT, ".github/workflows/monitor.yml");
  it("is run by a workflow that checks out exactly what it needs, reads only, and cannot reach the group", { skip: existsSync(join(ROOT, ".github/workflows")) ? false : "no .github/workflows here" }, () => {
    const workflow = readFileSync(WORKFLOW, "utf8").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    const sparse = (workflow.match(/sparse-checkout: \|\n((?:\s{12}\S.*\n)+)/)?.[1] ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(sparse.sort(), [...FILES, "deployments"].sort(), "a file the runner loads and the checkout leaves out is a monitor that dies at start");
    assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
    assert.doesNotMatch(workflow, /: write\b|git (push|commit)/);
    assert.match(workflow, /run: node src\/fleet\/monitor-cli\.ts/);
    assert.doesNotMatch(workflow, /npm (ci|install)/, "no install: that is what keeps an hourly run cheap");
    assert.match(workflow, /MONITOR_CHAT_ID: \$\{\{ secrets\.MONITOR_CHAT_ID \}\}/);
    assert.doesNotMatch(workflow, /TELEGRAM_CHAT_ID/, "the group's chat id has no business in this workflow");
    assert.match(workflow, /cron: '\d+ \* \* \* \*'/, "hourly: the ageing warning leaves six hours, the monitor must not use them up");
  });
});
