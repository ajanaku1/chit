/**
 * Calls ChitBuyback.buyAndBurn when it is due and there is something to
 * spend. Anyone may call it; this is the one that makes sure somebody does.
 *
 *   BUYBACK_ADDRESS=0x… BUYBACK_KEEPER_KEY=0x… node scripts/buyback-keeper.mjs
 *
 * The keeper key is a throwaway with a little ETH for gas (a call is about
 * 250k gas at 0.01 gwei); it holds nothing else and can do nothing else.
 * Without the two variables the script reads the contract, prints, and
 * exits 0. Plain node plus viem (installed by the workflow).
 *
 * With TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID a landed buy is told to the
 * group as one line, the figures read from the BoughtAndBurned event in the
 * receipt; the host's keeper route (api/buyback/keeper.js) posts the same
 * line, so whichever clock lands the buy, the group hears it once.
 */

import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.ROBINHOOD_MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const address = process.env.BUYBACK_ADDRESS;
const key = process.env.BUYBACK_KEEPER_KEY;
const EXPLORER = process.env.ROBINHOOD_EXPLORER ?? "https://robinhoodchain.blockscout.com";
const tgToken = process.env.TELEGRAM_BOT_TOKEN;
const tgChat = process.env.BUYBACK_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
/** BoughtAndBurned(address indexed caller, uint256 ethIn, uint256 tokensBought, uint256 tokensBurned, uint256 totalSpent, uint256 totalBurned) */
const BURNED_TOPIC = "0xc70d0935d3f7a32b837a0281c2344f8c8cd5f254c9fd80e26e291e197c9ede0f";

const ABI = parseAbi([
  "function dueAt() view returns (uint256)",
  "function nextSpend() view returns (uint256)",
  "function quote(uint256 ethIn) view returns (uint256)",
  "function buys() view returns (uint256)",
  "function totalSpent() view returns (uint256)",
  "function totalBurned() view returns (uint256)",
  "function buyAndBurn()",
]);

const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 30_000, retryCount: 3 }) });

if (!address) { console.log("BUYBACK_ADDRESS is not set: nothing to keep"); process.exit(0); }

const read = (functionName, args = []) => publicClient.readContract({ address, abi: ABI, functionName, args });
const [dueAt, nextSpend, buys, totalSpent, totalBurned, balance, block] = await Promise.all([
  read("dueAt"), read("nextSpend"), read("buys"), read("totalSpent"), read("totalBurned"), publicClient.getBalance({ address }), publicClient.getBlock(),
]);
const now = Number(block.timestamp);
console.log(`buyback ${address}: balance ${formatEther(balance)} ETH, next spend ${formatEther(nextSpend)} ETH, due at ${new Date(Number(dueAt) * 1000).toISOString()}, ${buys} buys so far, ${formatEther(totalSpent)} ETH spent, ${formatEther(totalBurned)} CHIT burned`);

if (nextSpend === 0n) { console.log("nothing to spend"); process.exit(0); }
if (now < Number(dueAt)) { console.log(`not due for ${Number(dueAt) - now}s`); process.exit(0); }
if (!key) { console.log("due, but BUYBACK_KEEPER_KEY is not set: somebody else will have to call it"); process.exit(0); }

const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain, transport: http(RPC, { timeout: 30_000 }) });
const gas = await publicClient.getBalance({ address: account.address });
if (gas < 10n ** 14n) { console.error(`keeper ${account.address} holds ${formatEther(gas)} ETH; top it up`); process.exit(1); }
const quoted = await read("quote", [nextSpend]);
console.log(`calling buyAndBurn from ${account.address}: ${formatEther(nextSpend)} ETH, quote ${formatEther(quoted)} CHIT`);
const hash = await wallet.writeContract({ address, abi: ABI, functionName: "buyAndBurn", gas: 600_000n });
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== "success") { console.error(`buyAndBurn reverted: ${hash}`); process.exit(1); }
console.log(`bought and burned: ${hash}; now ${await read("buys")} buys, ${formatEther(await read("totalBurned"))} CHIT burned in all`);

// The group hears every buy: one line, figures from the event, links to the tx and the burn page.
const log = receipt.logs.find((l) => l.address.toLowerCase() === address.toLowerCase() && l.topics[0] === BURNED_TOPIC);
if (log && tgToken && tgChat) {
  const [ethIn, , burned, totalSpent, totalBurned] = log.data.slice(2).match(/.{64}/g).map((w) => BigInt("0x" + w));
  const chit = (wei) => Math.round(Number(wei) / 1e18).toLocaleString("en-US");
  const ethShort = (wei) => (Number(wei) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 });
  const text = [
    `🔥 buy #${Number(buys) + 1} · <b>${ethShort(ethIn)} ETH</b> bought and burned <b>${chit(burned)} $CHIT</b>`,
    `total: <b>${chit(totalBurned)} $CHIT</b> burned, ${ethShort(totalSpent)} ETH spent · next buy in an hour`,
    `<a href="${EXPLORER}/tx/${hash}">tx</a> · <a href="https://chit.tools/burn">chit.tools/burn</a>`,
  ].join(String.fromCharCode(10));
  const send = async (body) => {
    const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: tgChat, text: body, parse_mode: "HTML", disable_web_page_preview: true }) });
    console.log(r.ok ? "told the group" : `telegram answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  };
  await send(text);
  // A buy that carries the total across a round number gets a second, bigger line: the same milestones the host's route knows.
  const milestone = [1, 5, 10, 25, 50, 100, 250, 500].map((m) => BigInt(m) * 10n ** 24n).find((m) => totalBurned - burned < m && totalBurned >= m);
  if (milestone) {
    const millions = Number(milestone / 10n ** 24n);
    const pct = (Number(totalBurned / 10n ** 18n) / 1e9 * 100).toFixed(2);
    await send([
      `🔥🔥🔥 <b>${millions}M $CHIT burned.</b>`,
      `${chit(totalBurned)} $CHIT bought on the pool and sent to the dead address, ${ethShort(totalSpent)} ETH spent, ${pct}% of the minted billion gone for good.`,
      `nobody pressed a button: a contract with no owner and no withdraw did it, once an hour. next stop ${millions < 10 ? 10 : millions * 2}M. <a href="https://chit.tools/burn">chit.tools/burn</a>`,
    ].join(String.fromCharCode(10)));
  }
} else if (log) {
  console.log("no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID: the group is not told; the daily post still is");
}
