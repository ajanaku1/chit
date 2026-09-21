/**
 * Runs the outside monitor once: read, assess, say, tell, and fail the run if
 * anything is critical.
 *
 *   node src/fleet/monitor-cli.ts [--record deployments/fleet-46630.json]
 *
 * Plain node, nothing installed: node strips the types itself (22.18 or newer),
 * so a scheduled run is a sparse checkout and a few seconds, not an install.
 * That is why these three files import no package, and why the siblings are
 * loaded by whichever extension this file itself was started with.
 * .github/workflows/monitor.yml is its clock; any machine with node can be another.
 */
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Address, Hex } from "viem";
import type { Expected, Finding, PoolSnapshot, SiteAnswer, Thresholds } from "./monitor.js";
import type { Rpc } from "./monitor-reads.js";

const sibling = <T>(name: string): Promise<T> =>
  import(new URL(`./${name}${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url).href) as Promise<T>;
const { assess, alertText, digestText, finding } = await sibling<typeof import("./monitor.js")>("monitor");

const HELP = `Reads the pool's public state at one block and reports what is wrong with it (docs/fleet-monitor.md).

  node src/fleet/monitor-cli.ts [--record <deployment record>]   default: deployments/fleet-46630.json

Exit code 1 when a finding is critical, or when the monitor could not read. Environment:
  MONITOR_RPC_URL, MONITOR_SITE_URL, FLEET_OPERATOR_FLOAT_ETH, MONITOR_OPERATOR_CRITICAL_ETH,
  MONITOR_DIGEST_HOUR_UTC, TELEGRAM_BOT_TOKEN with MONITOR_CHAT_ID (never TELEGRAM_CHAT_ID: that is the group).`;

const PUBLIC_RPC: Record<number, [env: string, url: string]> = {
  46630: ["ROBINHOOD_TESTNET_RPC_URL", "https://rpc.testnet.chain.robinhood.com"],
  4663: ["ROBINHOOD_MAINNET_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"],
};
const NOBODY = `0x${"0".repeat(40)}`;

type Env = Record<string, string | undefined>;
type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Record_ = { chainId?: number; operator?: string; admin?: string; pool?: { address?: string; guardian?: string } };
export type Config = { chainId: number; rpcUrl: string; expected: Expected; thresholds: Partial<Thresholds>; site?: string };

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0]?.trim() ?? "";
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const wei = (env: Env, name: string): bigint | undefined => {
  const text = env[name];
  if (text === undefined || text === "") return undefined;
  const match = text.match(/^(\d+)(?:\.(\d{1,18}))?$/);
  if (!match) throw new Error(`${name} is not an amount in ETH: ${text}`);
  return BigInt(match[1] ?? "0") * 10n ** 18n + BigInt((match[2] ?? "").padEnd(18, "0"));
};

export const configFrom = (env: Env, record: Record_): Config => {
  const pool = record.pool?.address;
  if (!pool) throw new Error("the deployment record has no pool.address");
  const chainId = Number(record.chainId);
  const [name, url] = PUBLIC_RPC[chainId] ?? [];
  const rpcUrl = env["MONITOR_RPC_URL"] || (name ? env[name] : undefined) || url;
  if (!rpcUrl) throw new Error(`no RPC for chain ${chainId}: set MONITOR_RPC_URL`);
  // The float is one variable, read by the service and by the monitor, and the warning sits at half of it.
  const float = wei(env, "FLEET_OPERATOR_FLOAT_ETH");
  const [operatorWarn, operatorCritical] = [float === undefined ? wei(env, "MONITOR_OPERATOR_WARN_ETH") : float / 2n, wei(env, "MONITOR_OPERATOR_CRITICAL_ETH")];
  const site = env["MONITOR_SITE_URL"]?.replace(/\/+$/, "");
  return {
    chainId,
    rpcUrl,
    expected: {
      pool: pool as Address,
      ...(record.operator ? { operator: record.operator as Address } : {}),
      ...(record.admin ? { admin: record.admin as Address } : {}),
      ...(record.pool?.guardian ? { guardian: record.pool.guardian as Address } : {}),
    },
    thresholds: { ...(operatorWarn === undefined ? {} : { operatorWarn }), ...(operatorCritical === undefined ? {} : { operatorCritical }) },
    ...(site ? { site } : {}),
  };
};

/** Critical findings go out every run. Warnings alone go out every sixth hour, so a paused pool does not page anyone hourly. */
export const notifyNow = (findings: readonly Finding[], hourUtc: number): boolean =>
  findings.some((f) => f.severity === "critical") || (findings.length > 0 && hourUtc % 6 === 0);

/** The daily digest goes out in the run of this hour (UTC), findings or not: it is how anyone can tell the monitor is alive. */
export const digestNow = (hourUtc: number, env: Env): boolean => hourUtc === Number(env["MONITOR_DIGEST_HOUR_UTC"] || 7);

/** The app's own first question, which needs no login and changes nothing; the answer names the pool the service is configured with. */
export const probeSite = async (fetcher: Fetch, site: string, retryDelayMs = 3_000): Promise<SiteAnswer> => {
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await wait(retryDelayMs);
    try {
      const response = await fetcher(`${site}/api/fleet/campaign`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "chit-pool-monitor/1" },
        body: JSON.stringify({ action: "quote", body: { primaryWallet: NOBODY } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        const { poolAddress } = (await response.json()) as { poolAddress?: unknown };
        return typeof poolAddress === "string" ? { ok: true, poolAddress } : { ok: true };
      }
      reason = `HTTP ${response.status}`;
    } catch (error) {
      reason = firstLine(error);
    }
  }
  return { ok: false, reason };
};

/** Three tries for what a busy public RPC does (drops, 429, 5xx). What the node itself refuses is not retried. */
export const httpRpc = (url: string, fetcher: Fetch = fetch, backoffMs = 500): Rpc => async (method, params) => {
  let reason = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await wait(backoffMs * 3 ** (attempt - 1));
    let answer: { result?: unknown; error?: { message?: string } };
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "chit-pool-monitor/1" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) { reason = `HTTP ${response.status}`; continue; }
      answer = (await response.json()) as typeof answer;
    } catch (error) {
      reason = firstLine(error);
      continue;
    }
    if (answer.error) throw new Error(`${method}: ${firstLine(answer.error.message ?? "refused")}`);
    return answer.result;
  }
  throw new Error(`${method}: ${reason}`);
};

export type RunDeps = {
  record: Record_; env: Env; chainId: () => Promise<number>; read: () => Promise<PoolSnapshot>;
  now: () => Date; log: (text: string) => void; fetch: Fetch; acknowledged?: readonly Hex[];
};

export const run = async (deps: RunDeps): Promise<number> => {
  const { env, log } = deps;
  let findings: Finding[];
  let seen: PoolSnapshot | undefined;
  let where = { chainId: Number(deps.record.chainId), block: 0n };
  let read = "";
  try {
    const config = configFrom(env, deps.record);
    const chain = await deps.chainId();
    if (chain !== config.chainId) throw new Error(`the RPC is chain ${chain}, the record is chain ${config.chainId}`);
    // One failed read is a node that lagged or a request that was dropped; the second try pins a new block.
    const [snapshot, site] = await Promise.all([deps.read().catch(() => deps.read()), config.site ? probeSite(deps.fetch, config.site) : undefined]);
    seen = snapshot;
    where = { chainId: chain, block: snapshot.block };
    read = ` (${snapshot.queue.length} charges and ${snapshot.draws.length} draws read${site ? ", the hosted service asked" : ""})`;
    findings = assess(snapshot, config.expected, {
      wallClock: BigInt(Math.floor(deps.now().getTime() / 1000)), thresholds: config.thresholds,
      ...(deps.acknowledged ? { acknowledged: deps.acknowledged } : {}), ...(site ? { site } : {}),
    });
  } catch (error) {
    const reason = firstLine(error);
    findings = [finding("critical", "monitor-blind", reason.startsWith("the RPC is") ? reason : `could not read the pool: ${reason}`)];
  }

  if (findings.length === 0) log(`chain ${where.chainId} · block ${where.block} · nothing to report${read}`);
  const text = alertText(findings, where);
  const lines = text.split("\n");
  findings.forEach((finding, i) => { lines[i + 1] = [lines[i + 1], ...(finding.detail ?? []).map((d) => `    ${d}`)].join("\n"); });
  if (text) log(lines.join("\n"));

  let failed = findings.some((f) => f.severity === "critical");
  const [token, chat] = [env["TELEGRAM_BOT_TOKEN"], env["MONITOR_CHAT_ID"]];
  const hour = deps.now().getUTCHours();
  // At the digest hour the findings ride in the digest: one message, not two.
  const message = seen && digestNow(hour, env) ? digestText(seen, findings, where) : notifyNow(findings, hour) ? text : "";
  if (message) {
    if (!token || !chat) log("not sent: TELEGRAM_BOT_TOKEN and MONITOR_CHAT_ID are not both set");
    else {
      const response = await deps.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: message, disable_web_page_preview: true }),
      }).catch((error: unknown) => firstLine(error));
      const ok = typeof response !== "string" && response.ok;
      log(ok ? "sent to the monitor's chat" : `not sent: telegram answered ${typeof response === "string" ? response : response.status}`);
      failed ||= !ok; // an alert that went nowhere leaves the red run as the alert
    }
  }
  return failed ? 1 : 0;
};

const main = async (argv: readonly string[]): Promise<number> => {
  if (argv.includes("--help")) { console.log(HELP); return 0; }
  const at = argv.indexOf("--record");
  const record = JSON.parse(await readFile(argv[at + 1] && at >= 0 ? String(argv[at + 1]) : "deployments/fleet-46630.json", "utf8")) as Record_;
  const noted = await readFile(`deployments/monitor-${record.chainId}.json`, "utf8").then((text) => JSON.parse(text) as { acknowledged?: { id: Hex }[] }, () => undefined);
  const { readSnapshot } = await sibling<typeof import("./monitor-reads.js")>("monitor-reads");
  let rpc: Rpc | undefined;
  const lazy = (): Rpc => (rpc ??= httpRpc(configFrom(process.env, record).rpcUrl));
  return run({
    record, env: process.env, now: () => new Date(), log: (text) => console.log(text), fetch,
    chainId: async () => Number(BigInt((await lazy()("eth_chainId", [])) as string)),
    read: () => readSnapshot(lazy(), String(record.pool?.address) as Address),
    ...(noted?.acknowledged ? { acknowledged: noted.acknowledged.map((entry) => entry.id) } : {}),
  });
};

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
