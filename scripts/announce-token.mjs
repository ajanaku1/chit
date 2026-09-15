/**
 * Posts the token's numbers once a day: supply, what was burned, what is
 * locked, what sits in the pool, price and liquidity, and the links. All
 * of it read from Robinhood Chain mainnet and DexScreener at the moment of
 * posting; nothing is stored, estimated or worded up.
 *
 * Runs from .github/workflows/announce-pool.yml as a second step, with the
 * same two secrets; without them it prints and exits 0.
 *
 * Addresses can be moved by env if the token ever changes hands:
 *   CHIT_TOKEN_ADDRESS   the token (default: the live one)
 *   CHIT_LOCK_ADDRESSES  comma separated lockers whose balance counts as locked
 *   CHIT_PAIR_ID         the DexScreener pair id for price and liquidity
 */

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;

const RPC = process.env.ROBINHOOD_MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const CHIT = (process.env.CHIT_TOKEN_ADDRESS ?? "0xd523a627030509021cc39b6d7c8543417d3e50d8").toLowerCase();
const LOCKS = (process.env.CHIT_LOCK_ADDRESSES ?? "0xd0f7d8c6e9f6d80c297bebe4f7fd1b9c8125c32f").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // Uniswap v4 on Robinhood Chain
const PAIR = process.env.CHIT_PAIR_ID ?? "0x84a4f18cfab0b389a63c4d8a56d08f021a6fd5efb0b0b3617cfbbd6706f09f41";
const MINTED = 1_000_000_000n * 10n ** 18n; // one transfer from 0x0 at block 47298093

const LINKS = [
  ["app, testnet", "https://chit.tools"],
  ["chart", `https://dexscreener.com/robinhood/${PAIR}`],
  ["x", "https://x.com/usechit"],
];

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "chit-token-stats/1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`rpc ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${j.error.message}`);
  return j.result;
}
const call = (data) => rpc("eth_call", [{ to: CHIT, data }, "latest"]).then((r) => BigInt(r));
const balanceOf = (a) => call("0x70a08231" + a.slice(2).padStart(64, "0"));
const m = (wei) => (Number(wei) / 1e24).toFixed(2) + "M";
const pct = (part, whole) => (Number((part * 10_000n) / whole) / 100).toFixed(2) + "%";
const usd = (n) => "$" + Math.round(Number(n)).toLocaleString("en-US");

const [supply, dead, poolHeld, ...locked] = await Promise.all([
  call("0x18160ddd"),
  balanceOf("0x000000000000000000000000000000000000dead"),
  balanceOf(POOL_MANAGER),
  ...LOCKS.map(balanceOf),
]);
const burned = MINTED - supply + dead; // burn() shrinks supply; a send to dead does not
const lockedTotal = locked.reduce((a, b) => a + b, 0n);

let market = null;
try {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/robinhood/${PAIR}`, { headers: { "user-agent": "chit-token-stats/1" } });
  const p = ((await r.json()).pairs ?? [])[0];
  if (p) market = { price: p.priceUsd, mcap: p.marketCap, liq: p.liquidity?.usd, vol: p.volume?.h24, chg: p.priceChange?.h24 };
} catch { /* the chain numbers stand on their own */ }

const lines = [
  "🪙 <b>CHIT</b>, the token, today",
  "",
  `supply: ${m(supply)} of ${m(MINTED)} minted`,
  `burned: ${m(burned)} (${pct(burned, MINTED)})`,
  `locked: ${m(lockedTotal)} (${pct(lockedTotal, supply)}) in ${LOCKS.length === 1 ? "the locker" : LOCKS.length + " lockers"}`,
  `in the trading pool: ${m(poolHeld)} (${pct(poolHeld, supply)})`,
  ...(market ? [
    "",
    `price ${"$" + Number(market.price).toPrecision(3)} · mcap ${usd(market.mcap)} · liquidity ${usd(market.liq)}`,
    `24h volume ${usd(market.vol)} · 24h ${Number(market.chg) >= 0 ? "+" : ""}${Number(market.chg).toFixed(1)}%`,
  ] : []),
  "",
  LINKS.map(([label, url]) => `<a href="${url}">${label}</a>`).join(" · "),
  `<i>supply, burn and lock read from the contract on Robinhood Chain; price from DexScreener</i>`,
];
const text = lines.join("\n");

if (!token || !chat) { console.log("would send:\n" + text); process.exit(0); }
const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
});
if (!r.ok) { console.error(`telegram answered ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
console.log("posted token stats");
