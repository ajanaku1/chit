/**
 * Posts one line of pool numbers a day to the Telegram group, read from the
 * chain, so the community can see the pool being used without anyone
 * writing an update.
 *
 * Everything here is a view call or an event count on the deployed FleetPool
 * over the last 24 hours. Nothing is estimated, nothing is worded up. If the
 * chain says zero, the message says zero.
 *
 * Runs from .github/workflows/announce-pool.yml. Same two secrets as the push
 * announcer; without them it prints and exits 0.
 */

import { readFile } from "node:fs/promises";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
const RPC = process.env.ROBINHOOD_TESTNET_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com";
const HOURS = Number(process.env.POOL_STATS_HOURS ?? 24);
const DEPLOYMENTS = new URL("../deployments/fleet-46630.json", import.meta.url);

/** FleetPool event topics, keccak256 of the signature beside each. Hardcoded
    so this runs on plain node with no install; keep in step with
    contracts/fleet/FleetPool.sol. */
const EVENTS = {
  Deposited: "0x2da466a7b24304f47e87fa2e1e5a81b9831ce54fec19055ce277ca2f39ba42c4", // Deposited(address,uint256)
  ExitPaid: "0x4bfebdbf8c30fcf03b3d3c70580f14997a355be4d4505df3139cc6a8bb4009a3", // ExitPaid(address,uint256)
  DrawFunded: "0x150b677aea86f32885a3d5504c3934386cd005483e4b0e2961168079624ef760", // DrawFunded(bytes32,uint256)
  Committed: "0xcc4c1525c958b2fb4f1467dc8ccd3c4d1837a460574a7980d2b9daa8dcc1507c", // Committed(bytes32,uint256)
  DrawClosed: "0xc28ffb1938d7c07ba504c71da2e9daafe8b979ae1fff1b1ea24e1685818780a9", // DrawClosed(bytes32,uint256)
};

const SELECTORS = {
  campaignCount: "0x7274e30d", // campaignCount()
  paused: "0x5c975abb", // paused()
};

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "chit-pool-stats/1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`rpc ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${j.error.message}`);
  return j.result;
}

const eth = (wei) => (Number(wei) / 1e18).toFixed(4).replace(/\.?0+$/, "");
const hex = (n) => "0x" + n.toString(16);

const deployments = JSON.parse(await readFile(DEPLOYMENTS, "utf8"));
const POOL = deployments.pool?.address;
if (!POOL) throw new Error("deployments/fleet-46630.json has no pool.address");

const tip = parseInt(await rpc("eth_blockNumber", []), 16);
// Testnet blocks land about every 0.16s; measure rather than assume.
const tipBlock = await rpc("eth_getBlockByNumber", [hex(tip), false]);
const probe = await rpc("eth_getBlockByNumber", [hex(tip - 100_000), false]);
const secPerBlock = (parseInt(tipBlock.timestamp, 16) - parseInt(probe.timestamp, 16)) / 100_000;
const from = tip - Math.round((HOURS * 3600) / secPerBlock);

/** Logs in slices, because the public RPC caps a single query. */
async function logs(topic0) {
  const out = [];
  const span = 100_000;
  for (let lo = from; lo <= tip; lo += span) {
    const hi = Math.min(lo + span - 1, tip);
    out.push(...(await rpc("eth_getLogs", [{ address: POOL, fromBlock: hex(lo), toBlock: hex(hi), topics: [topic0] }])));
  }
  return out;
}

const counts = {};
const sums = {};
for (const [name, topic0] of Object.entries(EVENTS)) {
  const ls = await logs(topic0);
  counts[name] = ls.length;
  sums[name] = ls.reduce((a, l) => a + BigInt("0x" + l.data.slice(2, 66)), 0n);
}
const uniqueDepositors = new Set((await logs(EVENTS.Deposited)).map((l) => l.topics[1])).size;

const [campaigns, balance, paused] = await Promise.all([
  rpc("eth_call", [{ to: POOL, data: SELECTORS.campaignCount }, "latest"]).then((r) => Number(BigInt(r))),
  rpc("eth_getBalance", [POOL, "latest"]).then((r) => BigInt(r)),
  rpc("eth_call", [{ to: POOL, data: SELECTORS.paused }, "latest"]).then((r) => BigInt(r) === 1n),
]);

const period = HOURS === 24 ? "last 24h" : `last ${HOURS}h`;
const lines = [
  `📊 <b>chit pool</b>, robinhood testnet, ${period}`,
  "",
  `deposits: ${counts.Deposited} (${eth(sums.Deposited)} ETH${uniqueDepositors ? `, ${uniqueDepositors} wallet${uniqueDepositors === 1 ? "" : "s"}` : ""})`,
  `fleets funded: ${counts.DrawFunded}`,
  `sponsored buys: ${counts.Committed} (${eth(sums.Committed)} ETH settled)`,
  `campaigns closed: ${counts.DrawClosed}`,
  `exits paid: ${counts.ExitPaid} (${eth(sums.ExitPaid)} ETH)`,
  "",
  `pool holds ${eth(balance)} ETH · ${campaigns} campaign${campaigns === 1 ? "" : "s"} all time${paused ? " · paused" : ""}`,
  `<i>read from the contract at ${POOL.slice(0, 10)}…, nothing estimated</i>`,
];
const text = lines.join("\n");

if (!token || !chat) {
  console.log("would send:\n" + text);
  process.exit(0);
}
const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
});
if (!r.ok) {
  console.error(`telegram answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  process.exit(1);
}
console.log("posted pool stats");
