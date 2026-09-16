/**
 * Posts the buyback's day once a day: what came in, what was bought and
 * burned in the last 24 hours, and the running totals, all read from the
 * ChitBuyback contract's events and views on Robinhood Chain mainnet at the
 * moment of posting. Nothing is stored or estimated; the totals are the
 * contract's own counters, the percentage is against the minted supply.
 *
 * Runs from .github/workflows/announce-pool.yml as a third step with the
 * same two secrets plus BUYBACK_ADDRESS (a repository variable); without
 * the address it says so and exits 0, without the secrets it prints.
 *
 *   BUYBACK_ADDRESS   the contract
 *   BUYBACK_SHARE     what the team sends in, as text for the post ("10% of
 *                     fees, plus one point every 100k of mcap"); the contract
 *                     cannot know it, the team does, and it is posted as a
 *                     promise, not a reading
 *   BUYBACK_BANNER    the picture on top: a local file (default
 *                     landing/public/bot/buyback.png, checked out by the
 *                     workflow) or an https URL; missing means a text post
 *
 * Plain node, no install. Selectors and topics were computed once with
 * viem's toFunctionSelector / toEventSelector from the ABI in
 * contracts/chit/ChitBuyback.sol.
 */

import { readFile } from "node:fs/promises";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
const BANNER = process.env.BUYBACK_BANNER ?? "landing/public/bot/buyback.png";
const RPC = process.env.ROBINHOOD_MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const BUYBACK = (process.env.BUYBACK_ADDRESS ?? "").toLowerCase();
const SHARE = process.env.BUYBACK_SHARE ?? "";
const CHIT = (process.env.CHIT_TOKEN_ADDRESS ?? "0xd523a627030509021cc39b6d7c8543417d3e50d8").toLowerCase();
const MINTED = 1_000_000_000n * 10n ** 18n;
// The mainnet explorer: explorer.mainnet.chain.robinhood.com only redirects here, dropping the path.
const EXPLORER = process.env.ROBINHOOD_EXPLORER ?? "https://robinhoodchain.blockscout.com";

if (!BUYBACK) { console.log("BUYBACK_ADDRESS is not set: no buyback to report"); process.exit(0); }

const SEL = { totalReceived: "0xa3c2c462", totalSpent: "0xfb346eab", totalBurned: "0xd89135cd", buys: "0xbccb4687", nextSpend: "0x1490e393", dueAt: "0x85f1b090", totalSupply: "0x18160ddd" };
const TOPIC = {
  funded: "0xcd909ec339185c4598a4096e174308fbdf136d117f230960f873a2f2e81f63af",
  burned: "0xc70d0935d3f7a32b837a0281c2344f8c8cd5f254c9fd80e26e291e197c9ede0f",
};

/** One JSON-RPC call; the public RPC rate-limits bursts, so a 429 waits and tries again. */
async function rpc(method, params, attempt = 0) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json", "user-agent": "chit-buyback-stats/1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (r.status === 429 && attempt < 4) { await new Promise((ok) => setTimeout(ok, 1500 * 2 ** attempt)); return rpc(method, params, attempt + 1); }
  if (!r.ok) throw new Error(`rpc ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${j.error.message}`);
  return j.result;
}
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]).then((r) => BigInt(r));
const eth = (wei, places = 4) => (Number(wei) / 1e18).toFixed(places);
const pct = (part, whole) => (Number((part * 100_000n) / whole) / 1000).toFixed(3) + "%";
const chit = (wei) => {
  const n = Number(wei) / 1e18;
  return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : n.toFixed(0);
};
const words = (data) => data.slice(2).match(/.{64}/g).map((w) => BigInt("0x" + w));

const [totalReceived, totalSpent, totalBurned, buys, nextSpend, dueAt, supply, balanceHex, latest] = await Promise.all([
  call(BUYBACK, SEL.totalReceived), call(BUYBACK, SEL.totalSpent), call(BUYBACK, SEL.totalBurned), call(BUYBACK, SEL.buys),
  call(BUYBACK, SEL.nextSpend), call(BUYBACK, SEL.dueAt), call(CHIT, SEL.totalSupply),
  rpc("eth_getBalance", [BUYBACK, "latest"]), rpc("eth_getBlockByNumber", ["latest", false]),
]);
const balance = BigInt(balanceHex);
const now = Number(latest.timestamp);
const head = Number(latest.number);

// The last 24 hours of events. Blocks land about every quarter second on 4663, so a day is under 400k blocks; the block timestamps decide.
const DAY_BLOCKS = 400_000;
const from = "0x" + Math.max(0, head - DAY_BLOCKS).toString(16);
const logs = await rpc("eth_getLogs", [{ address: BUYBACK, fromBlock: from, toBlock: "latest", topics: [[TOPIC.funded, TOPIC.burned]] }]);
const blockTimes = new Map();
const timeOf = async (blockHex) => {
  if (!blockTimes.has(blockHex)) blockTimes.set(blockHex, Number((await rpc("eth_getBlockByNumber", [blockHex, false])).timestamp));
  return blockTimes.get(blockHex);
};
let dayIn = 0n, dayBuys = 0, daySpent = 0n, dayBurned = 0n;
for (const log of logs) {
  const t = await timeOf(log.blockNumber);
  if (t < now - 86_400) continue;
  const w = words(log.data);
  if (log.topics[0] === TOPIC.funded) dayIn += w[0];
  else { dayBuys += 1; daySpent += w[0]; dayBurned += w[2]; }
}

const lines = [
  "🔥 <b>CHIT buyback and burn</b>, today",
  "",
  `last 24h: <b>${eth(dayIn)} ETH</b> in · <b>${dayBuys}</b> buy${dayBuys === 1 ? "" : "s"} · <b>${eth(daySpent)} ETH</b> spent · <b>${chit(dayBurned)} CHIT</b> burned`,
  `all time: <b>${eth(totalSpent)} ETH</b> spent over ${buys} buys · <b>${chit(totalBurned)} CHIT</b> burned, ${pct(totalBurned, MINTED)} of the minted billion`,
  `in the contract now: ${eth(balance)} ETH · next buy ${eth(nextSpend)} ETH${nextSpend > 0n ? (now >= Number(dueAt) ? ", due now" : `, due in ${Math.ceil((Number(dueAt) - now) / 60)} min`) : ""}`,
  `supply after burns: ${chit(supply)}`,
  "",
  `how it works: ETH goes in, a contract with no owner and no withdraw buys CHIT on the pool and burns it. anyone can call it, once an hour, 1% of what it holds a time (floor 0.002, cap 0.1), and it refuses a fill more than 5% under the pool's own quote.${SHARE ? ` the team sends in ${SHARE}.` : ""}`,
  `<a href="${EXPLORER}/address/${BUYBACK}">the contract</a> · <i>every figure read from the chain just now; the totals are the contract's own counters</i>`,
];
const text = lines.join("\n");

if (!token || !chat) { console.log("would send:\n" + text); process.exit(0); }

/** The banner on top when there is one and the text fits a caption (1024 characters); a plain message otherwise. */
const banner = text.length <= 1024 ? await (async () => {
  if (/^https?:\/\//.test(BANNER)) return { url: BANNER };
  try { return { bytes: await readFile(BANNER) }; } catch { return undefined; }
})() : undefined;
let r;
if (banner && "url" in banner) {
  r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, photo: banner.url, caption: text, parse_mode: "HTML" }) });
} else if (banner) {
  const form = new FormData();
  form.set("chat_id", chat); form.set("caption", text); form.set("parse_mode", "HTML");
  form.set("photo", new Blob([banner.bytes], { type: "image/png" }), "buyback.png");
  r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
} else {
  r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }) });
}
if (!r.ok) { console.error(`telegram answered ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
console.log(`posted buyback stats${banner ? " with the banner" : ""}`);
