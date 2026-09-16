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
 */

import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.ROBINHOOD_MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const address = process.env.BUYBACK_ADDRESS;
const key = process.env.BUYBACK_KEEPER_KEY;

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
