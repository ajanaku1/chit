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
// Plain JS on purpose: see api/fleet/campaign.js.

import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { sweepTriggerAllowed } from "../../dist/src/fleet/sweep-trigger.js";

export const config = { maxDuration: 30 };

const RPC = process.env.ROBINHOOD_MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const BUYBACK = process.env.BUYBACK_ADDRESS ?? "0xe5a7dbd4fd12edfb5b2c1e584b5d1ea9131f8b64";
const KEY = process.env.BUYBACK_KEEPER_KEY;
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
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 8_000 });
      status = receipt.status === "success" ? "burned" : "reverted";
    } catch {
      status = "pending";
    }
    return { state: "sent", status, hash, keeper: account.address, spend: formatEther(nextSpend), quotedChit: formatEther(quoted), ...base };
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
