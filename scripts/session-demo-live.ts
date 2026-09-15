/**
 * The session-keys demo, live on Robinhood Chain testnet, told in the group.
 *
 * A throwaway owner creates a session account, funds it, hands a fresh bot
 * key a session that may only call the Universal Router for at most 0.0005
 * ETH a trade; the bot buys FLEET through the real venue from its own key;
 * the bot is refused, without spending gas, when it asks to move the tokens
 * out or to trade above its limit; the owner revokes the key; the bot is
 * refused for good; the owner takes the tokens and the ETH back. Every step
 * is a transaction hash the group can check against the chain.
 *
 * Nothing here is worded up. If a step fails the message says which, with
 * the error's first line, and the run fails.
 *
 * Reads, never invents:
 *   DEMO_PRIVATE_KEY            a throwaway key funded with test ETH; NOT the
 *                               operator's. The owner of the demo account.
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   the group; without them the story
 *                               is printed and the run passes
 *   ROBINHOOD_TESTNET_RPC_URL   optional
 *   DRY_RUN                     print the story, do not post
 *
 * The bot's key is derived from the demo key and the run's moment, so every
 * run is a new key: a revoked key can never be granted again, by design.
 * The factory is read from deployments/fleet-46630.json (sessionKeys);
 * absent, it is deployed by the demo key and recorded, since the factory
 * has no owner and it does not matter who deployed it.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, isHex, keccak256, parseAbi, parseEther, stringToHex, toFunctionSelector, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ROBINHOOD_TESTNET_ROUTER } from "../src/fleet/deploy.js";
import { DEFAULT_SALT, SESSION_ACCOUNT_ABI, SESSION_FACTORY_ABI, decodeSessionView, encodeSessionExecute, sessionState } from "../src/fleet/session-keys.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, encodeV4EthBuy } from "../src/fleet/v4-swap.js";

const RPC_URL = process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const RECORD = path.resolve("deployments/fleet-46630.json");
const TARGET = path.resolve("app/session-target.json");
const DRY = process.env.DRY_RUN === "1";
const TOKEN_ABI = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"]);

const TRADE = parseEther("0.0003");
const PER_CALL = parseEther("0.0005");
const CAP = parseEther("0.001");
const ACCOUNT_FLOAT = parseEther("0.002");
const BOT_GAS = parseEther("0.002");

const chain = defineChain({ id: 46630, name: "Robinhood Chain Testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });

const keyFromEnv = (): Hex => {
  const value = process.env.DEMO_PRIVATE_KEY;
  if (!value || !isHex(value) || value.length !== 66) throw new Error("Set DEMO_PRIVATE_KEY to a throwaway 32-byte hex key with a little test ETH (never the operator's)");
  return value;
};

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const eth = (wei: bigint): string => formatEther(wei);

const post = async (text: string): Promise<void> => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (DRY || !token || !chat) {
    console.log(`\n--- would post ---\n${text}\n--- end ---`);
    return;
  }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const body = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!body.ok) throw new Error(`telegram: ${body.description ?? r.status}`);
};

const main = async (): Promise<void> => {
  const owner = privateKeyToAccount(keyFromEnv());
  const runId = `${Date.now()}`;
  const bot = privateKeyToAccount(keccak256(stringToHex(`${keyFromEnv()}:bot:${runId}`)));
  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ chain, transport });
  const ownerWallet = createWalletClient({ account: owner, chain, transport });
  const botWallet = createWalletClient({ account: bot, chain, transport });
  if ((await publicClient.getChainId()) !== 46630) throw new Error("the RPC is not chain 46630");

  const record = JSON.parse(await readFile(RECORD, "utf8")) as Record<string, unknown> & { venue?: { token?: Address }; sessionKeys?: { factory?: Address; [k: string]: unknown } };
  const token = record.venue?.token;
  if (!token) throw new Error("no venue token in the record");
  const balance = await publicClient.getBalance({ address: owner.address });
  console.log(`demo owner ${owner.address} holds ${eth(balance)} ETH; bot key for this run ${bot.address}`);
  if (balance < parseEther("0.008")) throw new Error(`fund the demo key ${owner.address} with at least 0.008 test ETH`);

  const steps: string[] = [];
  const wait = async (hash: Hex, label: string): Promise<Hex> => {
    const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    console.log(`${label}: ${hash}`);
    return hash;
  };

  // --- the factory, once ---
  let factory = record.sessionKeys?.factory;
  if (!factory) {
    const { abi, bytecode } = JSON.parse(await readFile(path.resolve("artifacts/contracts/fleet/SessionAccountFactory.sol/SessionAccountFactory.json"), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };
    const hash = await ownerWallet.deployContract({ abi: abi as never, bytecode, args: [] as never });
    const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`factory deploy failed: ${hash}`);
    factory = r.contractAddress as Address;
    record.sessionKeys = { factory, deployTx: hash, deployer: owner.address, deployedAt: new Date().toISOString() };
    await writeFile(RECORD, `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(TARGET, `${JSON.stringify({ chainId: 46630, sessionFactory: factory }, null, 2)}\n`);
    console.log(`SessionAccountFactory deployed at ${factory} and recorded`);
    steps.push(`0. the factory did not exist yet; deployed it: <code>${factory}</code> (<code>${short(hash)}</code>)`);
  }

  // --- the owner's account ---
  const account = await publicClient.readContract({ address: factory, abi: SESSION_FACTORY_ABI, functionName: "accountOf", args: [owner.address, DEFAULT_SALT] });
  const code = await publicClient.getCode({ address: account });
  if (!code || code === "0x") {
    const hash = await wait(await ownerWallet.writeContract({ address: factory, abi: SESSION_FACTORY_ABI, functionName: "createAccount", args: [owner.address, DEFAULT_SALT] }), "createAccount");
    steps.push(`1. the owner created a session account, <code>${account}</code> (<code>${short(hash)}</code>). the owner's wallet stays in the owner's pocket.`);
  } else {
    steps.push(`1. the owner's session account, <code>${account}</code>, from a previous run.`);
  }
  const held = await publicClient.getBalance({ address: account });
  if (held < ACCOUNT_FLOAT) {
    const hash = await wait(await ownerWallet.sendTransaction({ to: account, value: ACCOUNT_FLOAT - held }), "fund account");
    steps.push(`2. funded it with ${eth(ACCOUNT_FLOAT - held)} test ETH (<code>${short(hash)}</code>). this is all the bot can ever reach.`);
  } else {
    steps.push(`2. it already held ${eth(held)} test ETH.`);
  }
  if ((await publicClient.getBalance({ address: bot.address })) < BOT_GAS) {
    await wait(await ownerWallet.sendTransaction({ to: bot.address, value: BOT_GAS }), "bot gas");
  }

  // --- the session ---
  const block = await publicClient.getBlock();
  const expiry = Number(block.timestamp) + 3600;
  const grantHash = await wait(await ownerWallet.writeContract({
    address: account, abi: SESSION_ACCOUNT_ABI, functionName: "grant",
    args: [bot.address, [{ target: ROBINHOOD_TESTNET_ROUTER, selector: UNIVERSAL_ROUTER_EXECUTE_SELECTOR }], PER_CALL, CAP, expiry],
  }), "grant");
  steps.push(`3. granted the bot's key <code>${short(bot.address)}</code> a session: only the Uniswap router, only <code>execute</code>, at most ${eth(PER_CALL)} ETH a trade, ${eth(CAP)} in all, for one hour (<code>${short(grantHash)}</code>).`);

  // --- the bot trades ---
  const before = await publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [account] });
  const buyHash = await wait(await botWallet.sendTransaction({
    to: account, gas: 700_000n,
    data: encodeSessionExecute(ROBINHOOD_TESTNET_ROUTER, TRADE, encodeV4EthBuy({ token, amountIn: TRADE, deadline: block.timestamp + 3600n })),
  }), "bot buy");
  const bought = (await publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [account] })) - before;
  const botTokens = await publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [bot.address] });
  steps.push(`4. the bot bought ${eth(bought)} FLEET for ${eth(TRADE)} ETH through the live router, signing with its own key (<code>${short(buyHash)}</code>). the tokens sit in the account; the bot holds ${eth(botTokens)}.`);

  // --- the bot is refused, without gas ---
  const transferSelector = toFunctionSelector("transfer(address,uint256)");
  const [canMove, whyMove] = await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "canExecute", args: [bot.address, token, transferSelector, 0n] });
  const [canBig, whyBig] = await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "canExecute", args: [bot.address, ROBINHOOD_TESTNET_ROUTER, UNIVERSAL_ROUTER_EXECUTE_SELECTOR, parseEther("0.002")] });
  if (canMove || canBig) throw new Error("the session admitted a call it should not have");
  steps.push(`5. the bot asked to move the tokens out: refused, "${esc(whyMove)}". asked to trade 0.002 ETH: refused, "${esc(whyBig)}". the contract answers before any gas is spent.`);

  // --- the kill switch ---
  const revokeHash = await wait(await ownerWallet.writeContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "revoke", args: [bot.address] }), "revoke");
  const view = decodeSessionView((await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "sessionOf", args: [bot.address] })) as never);
  const [canAfter, whyAfter] = await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "canExecute", args: [bot.address, ROBINHOOD_TESTNET_ROUTER, UNIVERSAL_ROUTER_EXECUTE_SELECTOR, TRADE] });
  if (canAfter || sessionState(view, Number(block.timestamp)) !== "revoked") throw new Error("the revoke did not take");
  steps.push(`6. the owner pulled the key, one transaction (<code>${short(revokeHash)}</code>). the bot asks again: "${esc(whyAfter)}". for good; that key never trades again.`);

  // --- the owner takes it all back ---
  const tokens = await publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [account] });
  const t1 = await wait(await ownerWallet.writeContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "withdrawToken", args: [token, owner.address, tokens] }), "withdrawToken");
  const left = await publicClient.getBalance({ address: account });
  const t2 = await wait(await ownerWallet.writeContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "withdraw", args: [owner.address, left] }), "withdraw");
  steps.push(`7. the owner took the ${eth(tokens)} FLEET and the ${eth(left)} ETH back (<code>${short(t1)}</code>, <code>${short(t2)}</code>). the account is empty; the bot never held a thing.`);

  const text = [
    "🔑 <b>session keys, live demo</b>",
    "a bot that can only do what it was told, with a kill switch. every line below is a transaction on Robinhood Chain testnet 46630, run by a script, not by a person.",
    "",
    ...steps,
    "",
    `account <code>${account}</code> · owner <code>${short(owner.address)}</code> · bot key <code>${short(bot.address)}</code> · factory <code>${short(factory)}</code>`,
    "<i>testnet, test tokens, a throwaway key on both sides. the Sessions page ships with the next deploy; the contract and its tests are in the repo.</i>",
  ].join("\n");
  await post(text);
  console.log("demo complete");
};

main().catch((error: unknown) => {
  const line = error instanceof Error ? error.message.split("\n")[0] : String(error);
  console.error(process.env["DEBUG"] ? error : line);
  void post(`🔑 <b>session keys, live demo</b>: a step failed: ${esc(line ?? "unknown")}. nothing worded up; the run will be fixed and rerun.`).finally(() => process.exit(1));
});
