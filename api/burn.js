// The burn page's numbers, read from the ChitBuyback contract on Robinhood
// Chain and served as one JSON so a visitor's browser never talks to the
// chain's public RPC (it rate-limits bursts and has no CORS). Cached at the
// edge for two minutes; the last good reading is kept in this instance so a
// throttled RPC returns stale-but-true numbers with their age, never a blank
// page. Nothing here is typed in: every figure is a contract read or a log,
// and the market cap is DexScreener's, named as such.
//
// Plain JS on purpose: see api/fleet/campaign.js.

const RPC = process.env.ROBINHOOD_MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const BUYBACK = (process.env.BUYBACK_ADDRESS ?? "0xe5a7dbd4fd12edfb5b2c1e584b5d1ea9131f8b64").toLowerCase();
const CHIT = (process.env.CHIT_TOKEN_ADDRESS ?? "0xd523a627030509021cc39b6d7c8543417d3e50d8").toLowerCase();
/** deployments/buyback-4663.json: the block the contract was deployed in, and when; nothing of it exists before. */
const FROM_BLOCK = Number(process.env.BUYBACK_FROM_BLOCK ?? 64413263);
const DEPLOYED_AT = Date.parse(process.env.BUYBACK_DEPLOYED_AT ?? "2026-09-16T09:48:35Z") / 1000;
/** The team's rule for what it sends in: ten percent of the fleet fees plus one point per 100k of market cap, counting the 100k the coin is in (under $100k is 11%, $200k+ is 13%). A promise, not a contract reading. */
const SHARE_BASE = Number(process.env.SHARE_BASE ?? 10);
const SHARE_STEP_USD = Number(process.env.SHARE_STEP_USD ?? 100_000);
const MINTED = 1_000_000_000n * 10n ** 18n;
const EXPLORER = process.env.ROBINHOOD_EXPLORER ?? "https://robinhoodchain.blockscout.com";
/** How many of the latest buys get an exact block timestamp; older ones are placed by the chain's steady cadence and say so. */
const EXACT_TIMES = 8;

const SEL = { totalReceived: "0xa3c2c462", totalSpent: "0xfb346eab", totalBurned: "0xd89135cd", buys: "0xbccb4687", nextSpend: "0x1490e393", dueAt: "0x85f1b090", totalSupply: "0x18160ddd" };
const TOPIC = {
  funded: "0xcd909ec339185c4598a4096e174308fbdf136d117f230960f873a2f2e81f63af",
  burned: "0xc70d0935d3f7a32b837a0281c2344f8c8cd5f254c9fd80e26e291e197c9ede0f",
};

/** One JSON-RPC call; a 429 waits and tries again, a hung request is cut. */
async function rpc(method, params, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json", "user-agent": "chit-burn-page/1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
    if (r.status === 429 && attempt < 4) { await new Promise((ok) => setTimeout(ok, 1200 * 2 ** attempt)); return rpc(method, params, attempt + 1); }
    if (!r.ok) throw new Error(`rpc ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`rpc ${j.error.message}`);
    return j.result;
  } finally {
    clearTimeout(timer);
  }
}
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]).then((r) => BigInt(r));
const words = (data) => data.slice(2).match(/.{64}/g).map((w) => BigInt("0x" + w));
const hex = (n) => "0x" + n.toString(16);

/** Block timestamps never change: remembered for the life of this instance. */
const blockTimes = new Map();

async function read() {
  // One call at a time: each answers in a fraction of a second, and the public RPC throttles a burst.
  const totalReceived = await call(BUYBACK, SEL.totalReceived), totalSpent = await call(BUYBACK, SEL.totalSpent), totalBurned = await call(BUYBACK, SEL.totalBurned);
  const buys = await call(BUYBACK, SEL.buys), nextSpend = await call(BUYBACK, SEL.nextSpend), dueAt = await call(BUYBACK, SEL.dueAt), supply = await call(CHIT, SEL.totalSupply);
  const balanceHex = await rpc("eth_getBalance", [BUYBACK, "latest"]), latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const head = parseInt(latest.number, 16), now = Number(latest.timestamp);
  const logs = await rpc("eth_getLogs", [{ address: BUYBACK, fromBlock: hex(FROM_BLOCK), toBlock: "latest", topics: [[TOPIC.funded, TOPIC.burned]] }]);
  // The chain's cadence since the deploy places every event to within seconds; the latest few get the block's own stamp.
  const perBlock = head > FROM_BLOCK ? (now - DEPLOYED_AT) / (head - FROM_BLOCK) : 0;
  const placed = (blockHex) => Math.round(DEPLOYED_AT + (parseInt(blockHex, 16) - FROM_BLOCK) * perBlock);
  const exact = async (blockHex) => {
    if (!blockTimes.has(blockHex)) blockTimes.set(blockHex, Number((await rpc("eth_getBlockByNumber", [blockHex, false])).timestamp));
    return blockTimes.get(blockHex);
  };
  const events = [];
  for (const [i, log] of logs.entries()) {
    const w = words(log.data);
    const wantExact = i >= logs.length - EXACT_TIMES;
    let at = placed(log.blockNumber), stamped = false;
    if (wantExact) { try { at = await exact(log.blockNumber); stamped = true; } catch { /* placed by cadence, and says so */ } }
    const base = { block: parseInt(log.blockNumber, 16), at, stamped, tx: log.transactionHash };
    if (log.topics[0] === TOPIC.funded) events.push({ ...base, kind: "funded", from: "0x" + log.topics[1].slice(26), amount: w[0].toString() });
    else events.push({ ...base, kind: "burned", caller: "0x" + log.topics[1].slice(26), ethIn: w[0].toString(), bought: w[1].toString(), burned: w[2].toString(), totalSpent: w[3].toString(), totalBurned: w[4].toString() });
  }
  return {
    chainId: 4663, contract: BUYBACK, token: CHIT, explorer: EXPLORER,
    readAt: now, head,
    totals: { received: totalReceived.toString(), spent: totalSpent.toString(), burned: totalBurned.toString(), buys: Number(buys) },
    burnedOfMinted: Number((totalBurned * 1_000_000n) / MINTED) / 10_000,
    supply: supply.toString(), balance: BigInt(balanceHex).toString(),
    next: { spend: nextSpend.toString(), dueAt: Number(dueAt) },
    params: { spendBps: 100, minSpendWei: "2000000000000000", maxSpendWei: "100000000000000000", intervalSeconds: 3600, maxSlipBps: 500 },
    events,
  };
}

/** DexScreener's market cap for the token; absent when it does not answer, never guessed. */
async function marketCap() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${CHIT}`, { signal: controller.signal, headers: { accept: "application/json" } });
    clearTimeout(timer);
    if (!r.ok) return undefined;
    const pairs = (await r.json()).pairs ?? [];
    const pair = pairs.find((p) => p.chainId === "robinhood") ?? pairs[0];
    const cap = Number(pair?.marketCap ?? pair?.fdv);
    return Number.isFinite(cap) ? { usd: cap, priceUsd: Number(pair?.priceUsd), source: "dexscreener" } : undefined;
  } catch {
    return undefined;
  }
}

let lastGood;

export async function GET() {
  const cap = await marketCap();
  const chain = await read().catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  if (chain.error) {
    if (!lastGood) return new Response(JSON.stringify({ error: "the chain's rpc did not answer; try again in a minute" }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    return new Response(JSON.stringify({ ...lastGood, stale: true, staleReason: chain.error }), { status: 200, headers: { "content-type": "application/json", "cache-control": "public, s-maxage=30" } });
  }
  const share = { base: SHARE_BASE, stepUsd: SHARE_STEP_USD, ...(cap ? { mcapUsd: cap.usd, pct: SHARE_BASE + Math.floor(cap.usd / SHARE_STEP_USD) + 1, priceUsd: cap.priceUsd, source: cap.source } : {}) };
  lastGood = { ...chain, share, servedAt: Math.floor(Date.now() / 1000) };
  return new Response(JSON.stringify(lastGood), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, s-maxage=120, stale-while-revalidate=600" },
  });
}
