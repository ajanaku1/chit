/**
 * The watch route: the cron's bearer or nothing, no secret means no pass;
 * one pass answers with the window and what got through, posts the big
 * buys to the group and to the subscribers, and hands every buy to the
 * handlers other features registered, each caught on its own;
 * BOT_WATCH_OFF stops the clock; the chain must be one of ours; the
 * watched tokens are the chain's venue token ($CHIT on 4663) and the
 * allowlist, and the bot's own sender is the signer's address when its key
 * is set.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex, parseEther } from "viem";
import { MemoryAlertStore } from "../../src/fleet/bot-alerts.js";
import type { BotChain } from "../../src/fleet/bot-chain.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";
import { MemoryWatchStore, type VenueBuy, type WatchPort } from "../../src/fleet/bot-watch.js";
import { CHIT_MAINNET } from "../../src/fleet/bot-bridge.js";
import { handleWatchRequest, ownSendersFromEnv, setWatchDepsForTests, watchHandlers, watchTokens } from "../../src/fleet/bot-watch-runtime.js";

const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const WOJAK = "0x00000000000000000000000000000000000000dd" as Address;
const BUYER = "0x0000000000000000000000000000000000000b01" as Address;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const req = (auth?: string) => new Request("https://chit.tools/api/bot/watch", { headers: auth ? { authorization: auth } : {} });
const reads = { async tokenInfo() { return { symbol: "PEPE", decimals: 18, hasPool: true }; } } as unknown as BotChain;

const ENV = ["CRON_SECRET", "BOT_WATCH_OFF", "BOT_WATCH_CHAIN_ID", "BOT_GROUP_CHAT_ID", "BOT_USERNAME", "BOT_ALERT_GROUP_MIN_ETH", "TELEGRAM_BOT_TOKEN", "BOT_HEY_OFF", "ORUS_PARTNER_API_KEY", "BOT_SIGNER_PRIVATE_KEY"] as const;
const withEnv = async (values: Partial<Record<(typeof ENV)[number], string>>, run: () => Promise<void>) => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) { if (values[k] === undefined) delete process.env[k]; else process.env[k] = values[k]; }
  try { await run(); }
  finally {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
    setWatchDepsForTests({});
    watchHandlers.length = 0;
  }
};

const fakePort = (head: bigint, buys: VenueBuy[]): WatchPort => ({
  async latestBlock() { return head; },
  async buysBetween(from, to) { return buys.filter((b) => b.block >= from && b.block <= to); },
});

test("no CRON_SECRET, no pass; the wrong bearer is 401; the right one runs once, posts the big buy to the group and the subscriber, hands every buy to the registered handlers, and reports", async () => {
  const store = new MemoryWatchStore();
  const alertStore = new MemoryAlertStore();
  const telegram = new RecordingTelegram();
  const seen: Hex[] = [];
  watchHandlers.push(async (b) => { seen.push(b.txHash); if (b.txHash === hash(2)) throw new Error("mirror broke"); });
  const buys: VenueBuy[] = [
    { block: 1_000n, txHash: hash(1), buyer: BUYER, token: PEPE, ethInWei: parseEther("0.7"), tokensOut: 1n, poolId: hash(9) },
    { block: 1_000n, txHash: hash(2), buyer: BUYER, token: WOJAK, ethInWei: parseEther("0.01"), tokensOut: 1n, poolId: hash(10) },
  ];
  await store.setCursor(4663, 999n);
  await alertStore.put({ tgId: "7", minEthWei: parseEther("0.005"), on: true });
  setWatchDepsForTests({ port: fakePort(1_000n, buys), store, alertStore, telegram, reads });
  await withEnv({ BOT_USERNAME: "usechit_bot", BOT_GROUP_CHAT_ID: "-100", BOT_HEY_OFF: "1" }, async () => {
    assert.equal((await handleWatchRequest(req("Bearer anything"))).status, 401, "an unset secret is a refusal, not an open route");
    process.env.CRON_SECRET = "s3cret-s3cret-s3cret";
    assert.equal((await handleWatchRequest(req("Bearer wrong"))).status, 401);
    assert.equal((await handleWatchRequest(req())).status, 401);
    const r = await handleWatchRequest(req("Bearer s3cret-s3cret-s3cret"));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { state: "ran", from: "1000", to: "1000", buys: 2, delivered: 2 }, "a handler that broke is caught inside the composed onBuy: the buy still counts as handed on");
    assert.deepEqual(seen, [hash(1), hash(2)], "every buy reaches the handlers, the small one too");
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

test("BOT_WATCH_OFF=1 stops the clock: the route answers off and reads nothing; a chain that is not ours is a configuration fault, told as such", async () => {
  const store = new MemoryWatchStore();
  let asked = 0;
  const port: WatchPort = { async latestBlock() { asked++; return 5n; }, async buysBetween() { return []; } };
  setWatchDepsForTests({ port, store, alertStore: new MemoryAlertStore(), telegram: new RecordingTelegram(), reads });
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
    setWatchDepsForTests({ port, store, alertStore: new MemoryAlertStore(), telegram: new RecordingTelegram(), reads });
    assert.deepEqual(await (await handleWatchRequest(req("Bearer s3cret-s3cret-s3cret"))).json(), { state: "not_configured", reason: "BOT_ALERT_GROUP_MIN_ETH is not an amount in ETH" });
    delete process.env.BOT_ALERT_GROUP_MIN_ETH;
    setWatchDepsForTests({ port, store, alertStore: new MemoryAlertStore(), telegram: new RecordingTelegram(), reads });
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
