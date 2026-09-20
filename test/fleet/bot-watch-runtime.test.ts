/**
 * The watch route: the cron's bearer or nothing, no secret means no pass;
 * one pass answers with the window and what got through, posts the big
 * buys to the group and to the subscribers, and hands every buy to the copy
 * desk too, built here over the function's own parts, so a wallet leader's
 * venue buy is alerted and mirrored from one pass, each reader once and
 * each caught on its own; BOT_WATCH_OFF stops the clock; the chain must be
 * one of ours and the signer set; the watched tokens are the chain's venue
 * token ($CHIT on 4663) and the allowlist, and the bot's own sender is the
 * signer's address when its key is set.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex, parseEther } from "viem";
import { MemoryAlertStore } from "../../src/fleet/bot-alerts.js";
import type { BotChain, TokenInfo } from "../../src/fleet/bot-chain.js";
import { MemoryCopyStore } from "../../src/fleet/bot-copy.js";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import type { OrusScan, OrusScanner } from "../../src/fleet/bot-orus.js";
import type { SessionChain } from "../../src/fleet/bot-session-chain.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";
import { MemoryWatchStore, type VenueBuy, type WatchPort } from "../../src/fleet/bot-watch.js";
import { CHIT_MAINNET } from "../../src/fleet/bot-bridge.js";
import { handleWatchRequest, ownSendersFromEnv, readInTurn, setWatchDepsForTests, watchTokens } from "../../src/fleet/bot-watch-runtime.js";
import { poolIdOf } from "../../src/fleet/pool-registry.js";
import { venuePoolKey } from "../../src/fleet/v4-swap.js";

const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const WOJAK = "0x00000000000000000000000000000000000000dd" as Address;
const BUYER = "0x0000000000000000000000000000000000000b01" as Address;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const req = (auth?: string) => new Request("https://chit.tools/api/bot/watch", { headers: auth ? { authorization: auth } : {} });
const WHALE = "0x0000000000000000000000000000000000000ea7" as Address;
const FOLLOWER = "0x0000000000000000000000000000000000000f05" as Address;
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
const HASH = ("0x" + "ab".repeat(32)) as Hex;
const info: TokenInfo = { address: PEPE, symbol: "PEPE", decimals: 18, hasPool: true, perEth: 10n ** 18n, poolEth: parseEther("5"), hooked: false, fee: 3000 };
const reads = {
  chainId: 4663, router: ROUTER,
  async tokenInfo(token: Address) { return { ...info, address: token }; },
  async quoteBuy(_token: Address, ethIn: bigint) { return ethIn; },
} as unknown as BotChain;
const safe: OrusScan = { symbol: "PEPE", honeypot: false, buyTaxPct: 0, sellTaxPct: 0, bundlersPct: null, top10Pct: null, holders: 100, liquidityUsd: 50_000, lpBurnedPct: null, marketCapUsd: null, deployerLaunches: 1, checkedAt: "2026-09-20T12:00:00Z" };
const orus: OrusScanner = { scan: async () => safe, link: (t) => `https://www.orusagent.xyz/token/${t}` };
/** The desk's parts the route would build from the environment: a wallet leader claimed, one follower linked and following at 0.01, a session that records what it sends. */
const deskParts = async () => {
  const copyStore = new MemoryCopyStore();
  const links = new MemoryBotLinkStore();
  const sent: { account: Address; value: bigint }[] = [];
  await copyStore.putLeader({ tgId: "9", account: WHALE, handle: "whale", since: "2026-09-19T00:00:00Z", open: true, kind: "wallet", wallet: WHALE });
  await links.putLink({ tgId: "5", account: FOLLOWER, owner: "0x0000000000000000000000000000000000000011", chainId: 4663, nonce: "n", signature: "0x00", linkedAt: "2026-09-19T00:00:00Z" });
  await copyStore.putFollow({ followerTgId: "5", leaderTgId: "9", capWei: parseEther("0.01"), since: "2026-09-19T00:00:00Z" });
  const session: SessionChain = {
    chainId: 4663, signer: "0x00000000000000000000000000000000000000b0",
    async ownerOf() { return "0x0000000000000000000000000000000000000011"; },
    async sessionOf() { throw new Error("not read here"); },
    async canExecute() { return { ok: true, why: "" }; },
    async execute(account, _to, value) { sent.push({ account, value }); return { hash: HASH, landed: true }; },
    async signerBalance() { return parseEther("1"); },
    async sellAllowed() { return false; },
    async canSell() { return { ok: false, why: "sell not allowed" }; },
    async sell() { throw new Error("not sold here"); },
  };
  return { copyStore, links, session, sent };
};

const ENV = ["CRON_SECRET", "BOT_WATCH_OFF", "BOT_WATCH_CHAIN_ID", "BOT_GROUP_CHAT_ID", "BOT_USERNAME", "BOT_ALERT_GROUP_MIN_ETH", "TELEGRAM_BOT_TOKEN", "BOT_HEY_OFF", "ORUS_PARTNER_API_KEY", "BOT_SIGNER_PRIVATE_KEY", "BOT_DAILY_EXECUTES", "BOT_DAILY_GAS_ETH", "DATABASE_URL", "BOT_MEMORY_STORE"] as const;
const withEnv = async (values: Partial<Record<(typeof ENV)[number], string>>, run: () => Promise<void>) => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) { if (values[k] === undefined) delete process.env[k]; else process.env[k] = values[k]; }
  try { await run(); }
  finally {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
    setWatchDepsForTests({});
  }
};

const fakePort = (head: bigint, buys: VenueBuy[]): WatchPort => ({
  async latestBlock() { return head; },
  async buysBetween(from, to) { return buys.filter((b) => b.block >= from && b.block <= to); },
});

test("no CRON_SECRET, no pass; the wrong bearer is 401; the right one runs once, posts the big buy to the group and the subscriber, asks the copy desk about every buy, and reports", async () => {
  const store = new MemoryWatchStore();
  const alertStore = new MemoryAlertStore();
  const telegram = new RecordingTelegram();
  const { copyStore, links, session, sent: mirrors } = await deskParts();
  const asked: Address[] = [];
  const leaderByWallet = copyStore.leaderByWallet.bind(copyStore);
  copyStore.leaderByWallet = async (wallet) => { asked.push(wallet); return leaderByWallet(wallet); };
  const buys: VenueBuy[] = [
    { block: 1_000n, txHash: hash(1), buyer: BUYER, token: PEPE, ethInWei: parseEther("0.7"), tokensOut: 1n, poolId: hash(9) },
    { block: 1_000n, txHash: hash(2), buyer: BUYER, token: WOJAK, ethInWei: parseEther("0.01"), tokensOut: 1n, poolId: hash(10) },
  ];
  await store.setCursor(4663, 999n);
  await alertStore.put({ tgId: "7", minEthWei: parseEther("0.005"), on: true });
  setWatchDepsForTests({ port: fakePort(1_000n, buys), store, alertStore, copyStore, links, session, telegram, reads });
  await withEnv({ BOT_USERNAME: "usechit_bot", BOT_GROUP_CHAT_ID: "-100", BOT_HEY_OFF: "1" }, async () => {
    assert.equal((await handleWatchRequest(req("Bearer anything"))).status, 401, "an unset secret is a refusal, not an open route");
    process.env.CRON_SECRET = "s3cret-s3cret-s3cret";
    assert.equal((await handleWatchRequest(req("Bearer wrong"))).status, 401);
    assert.equal((await handleWatchRequest(req())).status, 401);
    const r = await handleWatchRequest(req("Bearer s3cret-s3cret-s3cret"));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { state: "ran", from: "1000", to: "1000", buys: 2, delivered: 2 });
    assert.deepEqual(asked, [BUYER, BUYER], "every buy reaches the desk, the small one too; a wallet nobody claimed is nothing to it");
    assert.equal(mirrors.length, 0);
    const sent = telegram.sent.filter((o) => o.kind === "send") as { chatId: string; text: string; keyboard?: unknown }[];
    assert.deepEqual(sent.map((s) => s.chatId), ["-100", "7", "7"], "the group once (0.7 over 0.5), the subscriber twice (both over 0.005, two tokens)");
    assert.match(sent[0]!.text, /bought <code>0.7 ETH<\/code> of <b>\$PEPE<\/b>/);
    assert.match(sent[0]!.text, /orus: unknown, no read/);
    assert.deepEqual(sent[0]!.keyboard, [[{ text: "buy this", url: `https://t.me/usechit_bot?start=t-${PEPE}` }]]);
    assert.match(sent[1]!.text, /your line is 0.005 ETH a buy/);
    assert.equal(await store.cursor(4663), 1_000n);
    assert.equal(await store.seen(hash(2)), true);
  });
});

test("a wallet leader's venue buy is one buy for both readers: the alerts post it to the group and the desk mirrors it into the follower's account and posts it with the follow door, each once from one pass, and the pass reports it handed on once", async () => {
  const store = new MemoryWatchStore();
  const telegram = new RecordingTelegram();
  const { copyStore, links, session, sent: mirrors } = await deskParts();
  const buy: VenueBuy = { block: 2_000n, txHash: hash(3), buyer: WHALE, token: PEPE, ethInWei: parseEther("0.7"), tokensOut: 1n, poolId: poolIdOf(venuePoolKey(PEPE)) };
  await store.setCursor(4663, 1_999n);
  setWatchDepsForTests({ port: fakePort(2_000n, [buy]), store, alertStore: new MemoryAlertStore(), copyStore, links, session, telegram, reads, orus });
  await withEnv({ CRON_SECRET: "s3cret-s3cret-s3cret", BOT_USERNAME: "usechit_bot", BOT_GROUP_CHAT_ID: "-100", BOT_HEY_OFF: "1", BOT_SIGNER_PRIVATE_KEY: "0x" + "11".repeat(32) }, async () => {
    const r = await handleWatchRequest(req("Bearer s3cret-s3cret-s3cret"));
    assert.deepEqual(await r.json(), { state: "ran", from: "2000", to: "2000", buys: 1, delivered: 1 });
    assert.deepEqual(mirrors, [{ account: FOLLOWER, value: parseEther("0.01") }], "one mirror, sized to the follower's cap");
    const sent = telegram.sent.filter((o) => o.kind === "send") as { chatId: string; text: string; keyboard?: { text: string; url?: string }[][] }[];
    assert.deepEqual(sent.map((s) => s.chatId), ["-100", "5", "-100", "9"], "the alert to the group, then the desk: the follower's line, the feed's post, the leader's line");
    assert.match(sent[0]!.text, /bought <code>0.7 ETH<\/code> of <b>\$PEPE<\/b>/, "the alert is the chain's facts");
    assert.match(sent[0]!.text, /orus: no honeypot/, "the same orus answer the desk gated on");
    assert.match(sent[2]!.text, /^<b>whale<\/b> bought <code>0.7 ETH<\/code> of <b>PEPE<\/b>/, "the feed's post names the leader");
    assert.match(sent[2]!.text, /mirrored into 1 of 1 follower account, already landed or sent/);
    assert.deepEqual(sent[2]!.keyboard![0]![1], { text: "follow whale", url: `https://t.me/usechit_bot?start=f-${WHALE}` }, "the follow door carries the wallet they proved");
    assert.match(sent[3]!.text, /1 follower/, "the leader hears how many followed");
    // The same window again: the watcher's claim is spent, so neither reader sees the buy a second time.
    setWatchDepsForTests({ port: fakePort(2_000n, [buy]), store, alertStore: new MemoryAlertStore(), copyStore, links, session, telegram, reads, orus });
    await store.setCursor(4663, 1_999n);
    const again = await handleWatchRequest(req("Bearer s3cret-s3cret-s3cret"));
    assert.deepEqual(await again.json(), { state: "ran", from: "2000", to: "2000", buys: 1, delivered: 0 });
    assert.equal(mirrors.length, 1);
    assert.equal(telegram.sent.length, 4);
  });
});

test("the readers are each caught on their own: the desk throwing does not stop the alerts, the alerts throwing does not stop the desk, and each reader is handed the buy once", async () => {
  const buy: VenueBuy = { block: 1n, txHash: hash(4), buyer: WHALE, token: PEPE, ethInWei: parseEther("0.7"), tokensOut: 1n, poolId: hash(9) };
  const calls: string[] = [];
  const quiet = console.error;
  const logged: string[] = [];
  console.error = (line: string) => { logged.push(line); };
  try {
    await readInTurn([
      { name: "alerts", read: async () => { calls.push("alerts"); throw new Error("telegram 429"); } },
      { name: "copy desk", read: async () => { calls.push("copy desk"); } },
    ])(buy);
    assert.deepEqual(calls, ["alerts", "copy desk"], "the second reader runs after the first threw");
    calls.length = 0;
    await readInTurn([
      { name: "alerts", read: async () => { calls.push("alerts"); } },
      { name: "copy desk", read: async () => { calls.push("copy desk"); throw new Error("store is away"); } },
    ])(buy);
    assert.deepEqual(calls, ["alerts", "copy desk"]);
    assert.deepEqual(logged, [`bot watch: alerts for ${hash(4)}: telegram 429`, `bot watch: copy desk for ${hash(4)}: store is away`], "each failure is one line naming the reader and the hash");
  } finally { console.error = quiet; }
  // Through the route: a desk whose store is down still lets the alert out, and the pass counts the buy as handed on.
  const store = new MemoryWatchStore();
  const telegram = new RecordingTelegram();
  const { copyStore, links, session } = await deskParts();
  copyStore.leaderByWallet = async () => { throw new Error("store is away"); };
  await store.setCursor(4663, 0n);
  setWatchDepsForTests({ port: fakePort(1n, [buy]), store, alertStore: new MemoryAlertStore(), copyStore, links, session, telegram, reads });
  await withEnv({ CRON_SECRET: "s3cret-s3cret-s3cret", BOT_USERNAME: "usechit_bot", BOT_GROUP_CHAT_ID: "-100", BOT_HEY_OFF: "1" }, async () => {
    console.error = () => undefined;
    try {
      const r = await handleWatchRequest(req("Bearer s3cret-s3cret-s3cret"));
      assert.deepEqual(await r.json(), { state: "ran", from: "1", to: "1", buys: 1, delivered: 1 });
    } finally { console.error = quiet; }
    const sent = telegram.sent.filter((o) => o.kind === "send") as { chatId: string }[];
    assert.deepEqual(sent.map((s) => s.chatId), ["-100"], "the alert went out; the desk's failure was its own");
  });
});

test("the route builds the desk from the environment like the webhook does, so it refuses without the signer's key that sends the mirrors, and reads the daily limits by the same rule", async () => {
  const store = new MemoryWatchStore();
  const port: WatchPort = { async latestBlock() { return 5n; }, async buysBetween() { return []; } };
  const { copyStore, links } = await deskParts();
  setWatchDepsForTests({ port, store, alertStore: new MemoryAlertStore(), copyStore, links, telegram: new RecordingTelegram(), reads });
  await withEnv({ CRON_SECRET: "s3cret-s3cret-s3cret", BOT_USERNAME: "usechit_bot" }, async () => {
    const noKey = await handleWatchRequest(req("Bearer s3cret-s3cret-s3cret"));
    assert.equal(noKey.status, 503);
    assert.deepEqual(await noKey.json(), { state: "not_configured", reason: "BOT_SIGNER_PRIVATE_KEY must be the bot's 32-byte hex key (the one owners grant sessions to)" });
    process.env.BOT_SIGNER_PRIVATE_KEY = "0x" + "11".repeat(32);
    process.env.BOT_DAILY_EXECUTES = "many";
    setWatchDepsForTests({ port, store, alertStore: new MemoryAlertStore(), copyStore, links, telegram: new RecordingTelegram(), reads });
    assert.deepEqual(await (await handleWatchRequest(req("Bearer s3cret-s3cret-s3cret"))).json(), { state: "not_configured", reason: "BOT_DAILY_EXECUTES must be a whole number" });
    delete process.env.BOT_DAILY_EXECUTES;
    process.env.BOT_GROUP_CHAT_ID = "the group";
    setWatchDepsForTests({ port, store, alertStore: new MemoryAlertStore(), copyStore, links, telegram: new RecordingTelegram(), reads });
    assert.deepEqual(await (await handleWatchRequest(req("Bearer s3cret-s3cret-s3cret"))).json(), { state: "not_configured", reason: "BOT_GROUP_CHAT_ID must be a Telegram chat id (a number, -100… for a supergroup)" });
    delete process.env.BOT_GROUP_CHAT_ID;
    setWatchDepsForTests({ port, store, alertStore: new MemoryAlertStore(), copyStore, links, telegram: new RecordingTelegram(), reads });
    assert.deepEqual(await (await handleWatchRequest(req("Bearer s3cret-s3cret-s3cret"))).json(), { state: "ran", from: "5", to: "5", buys: 0, delivered: 0 }, "with the key the pass runs; the session chain is built over it and asked nothing until a leader buys");
  });
});

test("BOT_WATCH_OFF=1 stops the clock: the route answers off and reads nothing; a chain that is not ours is a configuration fault, told as such", async () => {
  const store = new MemoryWatchStore();
  let asked = 0;
  const port: WatchPort = { async latestBlock() { asked++; return 5n; }, async buysBetween() { return []; } };
  const { copyStore, links, session } = await deskParts();
  const parts = { port, store, copyStore, links, session, reads };
  setWatchDepsForTests({ ...parts, alertStore: new MemoryAlertStore(), telegram: new RecordingTelegram() });
  await withEnv({ CRON_SECRET: "s3cret-s3cret-s3cret", BOT_USERNAME: "usechit_bot", BOT_WATCH_OFF: "1" }, async () => {
    const off = await handleWatchRequest(req("Bearer s3cret-s3cret-s3cret"));
    assert.equal(off.status, 200);
    assert.deepEqual(await off.json(), { state: "off" });
    assert.equal(asked, 0, "off is off: the chain is not read");
    assert.equal((await handleWatchRequest(req("Bearer wrong"))).status, 401, "the bearer is still checked first");
    delete process.env.BOT_WATCH_OFF;
    process.env.BOT_WATCH_CHAIN_ID = "1";
    const bad = await handleWatchRequest(req("Bearer s3cret-s3cret-s3cret"));
    assert.equal(bad.status, 503);
    assert.deepEqual(await bad.json(), { state: "not_configured", reason: "BOT_WATCH_CHAIN_ID must be 4663 (or 46630 to rehearse)" });
    process.env.BOT_WATCH_CHAIN_ID = "46630";
    process.env.BOT_ALERT_GROUP_MIN_ETH = "abc";
    setWatchDepsForTests({ ...parts, alertStore: new MemoryAlertStore(), telegram: new RecordingTelegram() });
    assert.deepEqual(await (await handleWatchRequest(req("Bearer s3cret-s3cret-s3cret"))).json(), { state: "not_configured", reason: "BOT_ALERT_GROUP_MIN_ETH is not an amount in ETH" });
    delete process.env.BOT_ALERT_GROUP_MIN_ETH;
    setWatchDepsForTests({ ...parts, alertStore: new MemoryAlertStore(), telegram: new RecordingTelegram() });
    const ok = await handleWatchRequest(req("Bearer s3cret-s3cret-s3cret"));
    assert.deepEqual(await ok.json(), { state: "ran", from: "5", to: "5", buys: 0, delivered: 0 });
    assert.equal(await store.cursor(46630), 5n, "the cursor is the rehearsal chain's");
  });
});

test("the watched tokens: $CHIT on mainnet and the testnet token on 46630, first, then the allowlist, each once; the bot's own sender is the signer's address when its key is set, and nothing when it is not", async () => {
  const TESTNET_TOKEN = "0x13283ab8e1f2bc4297e9ec6480c80c59674af554" as Address;
  assert.deepEqual(watchTokens(4663, []), [CHIT_MAINNET], "the default chain watches the venue token that is actually on it, never the testnet's");
  assert.deepEqual(watchTokens(4663, [PEPE, CHIT_MAINNET.toUpperCase().replace("0X", "0x") as Address]), [CHIT_MAINNET, PEPE], "the allowlist adds to the venue token; a repeat is one");
  assert.deepEqual(watchTokens(46630, [WOJAK]), [TESTNET_TOKEN, WOJAK]);
  await withEnv({}, async () => {
    assert.deepEqual(ownSendersFromEnv(), [], "no signer key, nothing skipped");
    process.env.BOT_SIGNER_PRIVATE_KEY = "0x" + "11".repeat(32);
    assert.deepEqual(ownSendersFromEnv(), ["0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A"], "the key's address, the key itself never held here");
    process.env.BOT_SIGNER_PRIVATE_KEY = "not a key";
    assert.deepEqual(ownSendersFromEnv(), [], "a malformed key is the session bot's to refuse; the watcher skips nothing rather than guess");
  });
});
