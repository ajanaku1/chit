// The buyback keeper as a route, so a plain pinger can be the clock. GitHub's
// hourly cron (buyback-keeper.yml) skips slots when its scheduler is busy,
// and the chain showed it: three buys in nine hours where the rule says one
// an hour. A pinger hitting this every five minutes cannot miss an hour by
// more than five minutes, and the contract's own dueAt is the only trigger:
// a call that is not due reads, reports, and spends nothing.
//
// Same Bearer gate as the sweep (CRON_SECRET). Needs BUYBACK_KEEPER_KEY, the
// throwaway with dust ETH the workflow already uses; without it the route is
// read-only and says so. Anyone else can still call buyAndBurn themselves.
//
// Every buy it lands is told to the group as one line (TELEGRAM_BOT_TOKEN and
// BUYBACK_CHAT_ID, or the daily post's TELEGRAM_CHAT_ID): the figures come from
// the BoughtAndBurned event in the receipt, never from what was asked. No
// variables, no post; a failed post is logged and never fails the buy.
//
// Plain JS on purpose: see api/fleet/campaign.js.

import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { sweepTriggerAllowed } from "../../dist/src/fleet/sweep-trigger.js";

export const config = { maxDuration: 30 };

const RPC = process.env.ROBINHOOD_MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const BUYBACK = process.env.BUYBACK_ADDRESS ?? "0xe5a7dbd4fd12edfb5b2c1e584b5d1ea9131f8b64";
const KEY = process.env.BUYBACK_KEEPER_KEY;
const EXPLORER = process.env.ROBINHOOD_EXPLORER ?? "https://robinhoodchain.blockscout.com";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.BUYBACK_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
/** BoughtAndBurned(address indexed caller, uint256 ethIn, uint256 tokensBought, uint256 tokensBurned, uint256 totalSpent, uint256 totalBurned) */
const BURNED_TOPIC = "0xc70d0935d3f7a32b837a0281c2344f8c8cd5f254c9fd80e26e291e197c9ede0f";
/** Below this the keeper cannot pay for a call (about 250k gas at 0.01 gwei is 0.0000025 ETH; this leaves room for a fee spike). */
const GAS_FLOOR = 10n ** 14n;

const ABI = parseAbi([
  "function dueAt() view returns (uint256)",
  "function nextSpend() view returns (uint256)",
  "function quote(uint256 ethIn) view returns (uint256)",
  "function buys() view returns (uint256)",
  "function buyAndBurn()",
]);

const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 10_000, retryCount: 2 }) });
const read = (functionName, args = []) => publicClient.readContract({ address: BUYBACK, abi: ABI, functionName, args });

const chit = (wei) => Math.round(Number(wei) / 1e18).toLocaleString("en-US");
const ethShort = (wei) => (Number(wei) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 });

/** The buy as the group reads it: what went in, what burned, the running total, the links. Lowercase, one line per fact. */
export const burnLine = (buyNo, ev, hash) =>
  [
    `🔥 buy #${buyNo} · <b>${ethShort(ev.ethIn)} ETH</b> bought and burned <b>${chit(ev.burned)} $CHIT</b>`,
    `total: <b>${chit(ev.totalBurned)} $CHIT</b> burned, ${ethShort(ev.totalSpent)} ETH spent · next buy in an hour`,
    `<a href="${EXPLORER}/tx/${hash}">tx</a> · <a href="https://chit.tools/burn">chit.tools/burn</a>`,
  ].join("\n");

/** Reads the BoughtAndBurned event out of the receipt; undefined when the receipt carries none. */
export const burnedEvent = (receipt) => {
  const log = receipt.logs.find((l) => l.address.toLowerCase() === BUYBACK.toLowerCase() && l.topics[0] === BURNED_TOPIC);
  if (!log) return undefined;
  const words = log.data.slice(2).match(/.{64}/g).map((w) => BigInt("0x" + w));
  return { ethIn: words[0], bought: words[1], burned: words[2], totalSpent: words[3], totalBurned: words[4] };
};

/** Tells the group; true when Telegram took it. Never throws: the buy is done whatever happens here. */
const tellGroup = async (text) => {
  if (!TG_TOKEN || !TG_CHAT) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!r.ok) console.error(`buyback post: telegram answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.ok;
  } catch (error) {
    console.error(`buyback post: ${error?.message ?? error}`);
    return false;
  }
};

/** One send at a time in this instance: two pingers landing together must not both pay for the same buy. */
let inFlight;

async function keep() {
  const [dueAt, nextSpend, buys, block] = await Promise.all([read("dueAt"), read("nextSpend"), read("buys"), publicClient.getBlock()]);
  const now = Number(block.timestamp);
  const base = { contract: BUYBACK, buys: Number(buys), nextSpend: formatEther(nextSpend), dueAt: Number(dueAt), now };
  if (nextSpend === 0n) return { state: "idle", reason: "nothing_to_spend", ...base };
  if (now < Number(dueAt)) return { state: "idle", reason: "not_due", dueIn: Number(dueAt) - now, ...base };
  if (!KEY) return { state: "due", reason: "no_keeper_key", ...base };
  if (inFlight) return { state: "in_flight", ...base };

  inFlight = (async () => {
    const account = privateKeyToAccount(KEY);
    const gas = await publicClient.getBalance({ address: account.address });
    if (gas < GAS_FLOOR) return { state: "due", reason: "keeper_out_of_gas", keeper: account.address, keeperEth: formatEther(gas), ...base };
    const quoted = await read("quote", [nextSpend]);
    const wallet = createWalletClient({ account, chain, transport: http(RPC, { timeout: 10_000 }) });
    const hash = await wallet.writeContract({ address: BUYBACK, abi: ABI, functionName: "buyAndBurn", gas: 600_000n });
    // The chain is quick; give the receipt a few seconds so the answer can say "burned", but never hold the pinger for it.
    let status = "pending";
    let posted = false;
    let event;
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 8_000 });
      status = receipt.status === "success" ? "burned" : "reverted";
      event = status === "burned" ? burnedEvent(receipt) : undefined;
      if (event) posted = await tellGroup(burnLine(Number(buys) + 1, event, hash));
    } catch {
      status = "pending";
    }
    return {
      state: "sent", status, hash, keeper: account.address, spend: formatEther(nextSpend), quotedChit: formatEther(quoted),
      ...(event ? { burned: formatEther(event.burned), totalBurned: formatEther(event.totalBurned) } : {}),
      posted, ...base,
    };
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = undefined;
  }
}

async function handle(request) {
  if (!sweepTriggerAllowed(request, process.env.CRON_SECRET)) {
    return Response.json({ code: "unauthorized", retryable: false, reason: "cron_secret" }, { status: 401 });
  }
  try {
    const result = await keep();
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ state: "error", reason: String(error?.shortMessage ?? error?.message ?? error) }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}

export function GET(request) {
  return handle(request);
}

export function POST(request) {
  return handle(request);
}
