/**
 * The alerts: the group is told of a buy at or over its line and not
 * under; each subscriber at or over their own line; twenty group posts a
 * run and no more, a new run starts the count over; one private message
 * per user per token an hour, kept in the store; the words are the chain's
 * facts with the hash, the cashtag, orus's line or unknown (never nothing),
 * HEY's line or unknown, "read from the chain", and a "buy this" door into
 * the bot by the token; one failed message is one, not the run; the Neon
 * store's statements.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex, parseEther } from "viem";
import { Alerts, type AlertSql, DEFAULT_GROUP_MIN_WEI, MemoryAlertStore, NeonAlertStore } from "../../src/fleet/bot-alerts.js";
import type { BotChain } from "../../src/fleet/bot-chain.js";
import type { HeyScanner } from "../../src/fleet/bot-hey.js";
import type { OrusScan, OrusScanner } from "../../src/fleet/bot-orus.js";
import type { Keyboard } from "../../src/fleet/bot-telegram.js";
import type { VenueBuy } from "../../src/fleet/bot-watch.js";

const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const NONAME = "0x00000000000000000000000000000000000000dd" as Address;
const BUYER = "0x0000000000000000000000000000000000000b01" as Address;
const clock = new Date("2026-09-20T12:00:00Z");
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const buy = (n: number, ethIn: string, token: Address = PEPE): VenueBuy => ({ block: 100n + BigInt(n), txHash: hash(n), buyer: BUYER, token, ethInWei: parseEther(ethIn), tokensOut: 1000n, poolId: hash(0xf00) });

const reads = {
  async tokenInfo(token: Address) { return { address: token, symbol: token === PEPE ? "PEPE" : "?", decimals: 18, hasPool: true, perEth: 1n, poolEth: 1n, hooked: false, fee: 3000 }; },
} as unknown as Pick<BotChain, "tokenInfo">;
const safe: OrusScan = { symbol: "PEPE", honeypot: false, buyTaxPct: 0, sellTaxPct: 0, bundlersPct: null, top10Pct: null, holders: 100, liquidityUsd: 50_000, lpBurnedPct: null, marketCapUsd: null, deployerLaunches: 1, checkedAt: clock.toISOString() };

const setup = (opts: { orus?: OrusScan | null | "off"; hey?: boolean; feed?: boolean; groupMinWei?: bigint; maxGroupPerRun?: number; failTell?: (tgId: string) => boolean } = {}) => {
  const store = new MemoryAlertStore();
  const told: { to: string; text: string; keyboard?: Keyboard }[] = [];
  const posted: { text: string; keyboard: Keyboard }[] = [];
  let t = clock;
  const scan = opts.orus;
  const orus: OrusScanner | undefined = scan === "off" ? undefined : { async scan() { return scan === null ? undefined : (scan ?? safe); }, link: (token) => `https://www.orusagent.xyz/token/4663/${token}` };
  const hey: HeyScanner | undefined = opts.hey ? { async scan() { return { statusLabel: "Shipping", verifiedBuilder: true, commits30d: 12, releases30d: 1, ships30d: null, lastShip: null, projectName: "pepe", url: "https://heyresearch.xyz/p/pepe" }; } } : undefined;
  const alerts = new Alerts({
    store, reads, botUsername: "usechit_bot", now: () => t,
    ...(orus ? { orus } : {}),
    ...(hey ? { hey } : {}),
    tell: async (to, text, keyboard) => { if (opts.failTell?.(to)) throw new Error("blocked by user"); told.push({ to, text, ...(keyboard ? { keyboard } : {}) }); },
    ...(opts.feed === false ? {} : { feed: { chatId: "-100", post: async (text, keyboard) => { posted.push({ text, keyboard }); } } }),
    ...(opts.groupMinWei !== undefined ? { groupMinWei: opts.groupMinWei } : {}),
    ...(opts.maxGroupPerRun !== undefined ? { maxGroupPerRun: opts.maxGroupPerRun } : {}),
  });
  return { alerts, store, told, posted, tick: (ms: number) => { t = new Date(t.getTime() + ms); } };
};

test("the group's line: a buy under it posts nothing and reads nothing; at it, one message with the chain's facts, the hash, the cashtag and the buy this door by token; without a group, nothing is posted", async () => {
  const { alerts, posted } = setup();
  assert.deepEqual(await alerts.onBuy(buy(1, "0.4999")), { group: false, told: [] });
  assert.equal(posted.length, 0);
  assert.deepEqual(await alerts.onBuy(buy(2, "0.5")), { group: true, told: [] });
  assert.equal(posted.length, 1);
  const { text, keyboard } = posted[0]!;
  assert.match(text, /^<code>0x0000…0b01<\/code> bought <code>0.5 ETH<\/code> of <b>\$PEPE<\/b> · <a href="https:\/\/robinhoodchain\.blockscout\.com\/tx\/0x0{63}2">0x00000000…<\/a>/);
  assert.match(text, /orus: no honeypot · tax 0\/0 · 100 holders · liq \$50k · deployer 1 launch · <a href="https:\/\/www\.orusagent\.xyz\/token\/4663\/0x[0-9a-f]{40}">checked by orus<\/a>/);
  assert.match(text, /read from the chain \(the pool manager's swap log\), not from us/);
  assert.match(text, new RegExp(`the address is <code>${PEPE}</code>`));
  assert.deepEqual(keyboard, [[{ text: "buy this", url: `https://t.me/usechit_bot?start=t-${PEPE}` }]]);
  assert.equal(DEFAULT_GROUP_MIN_WEI, parseEther("0.5"));
  const quiet = setup({ feed: false });
  assert.deepEqual(await quiet.alerts.onBuy(buy(3, "5")), { group: false, told: [] });
  assert.equal(quiet.posted.length, 0);
  const high = setup({ groupMinWei: parseEther("2") });
  await high.alerts.onBuy(buy(4, "1.9"));
  await high.alerts.onBuy(buy(5, "2"));
  assert.equal(high.posted.length, 1, "the operator's line moves the group's threshold");
});

test("the words: no orus wired or no read is 'unknown', never a missing line; no HEY page is unknown too; a token without a symbol is shown by its address, no cashtag guessed", async () => {
  const none = setup({ orus: "off" });
  await none.alerts.onBuy(buy(1, "1"));
  assert.match(none.posted[0]!.text, /orus: unknown, no read on this token right now\. unknown is not safe\./);
  assert.match(none.posted[0]!.text, /hey research lab: unknown, no page for this token\./);
  const miss = setup({ orus: null, hey: true });
  await miss.alerts.onBuy(buy(2, "1"));
  assert.match(miss.posted[0]!.text, /orus: unknown, no read/);
  assert.match(miss.posted[0]!.text, /hey research lab: shipping · 12 commits · 1 release · verified builder · <a href="https:\/\/heyresearch\.xyz\/p\/pepe">see on HEY<\/a>/);
  await miss.alerts.onBuy(buy(3, "1", NONAME));
  assert.match(miss.posted[1]!.text, /bought <code>1 ETH<\/code> of <b>0x0000…00dd<\/b>/);
  assert.ok(!/\$0x/.test(miss.posted[1]!.text), "no cashtag on an address");
  for (const p of [...none.posted, ...miss.posted]) {
    assert.ok(!/safe|audited|anonymous/i.test(p.text.replace(/unknown is not safe/g, "")), `no word on safety beyond orus's line: ${p.text}`);
  }
});

test("each subscriber's own line: told at or over it, not under, only when on; the message says their line and how to change it; the door is the same", async () => {
  const { alerts, store, told, posted } = setup();
  await store.put({ tgId: "7", minEthWei: parseEther("0.1"), on: true });
  await store.put({ tgId: "8", minEthWei: parseEther("1"), on: true });
  await store.put({ tgId: "9", minEthWei: parseEther("0.01"), on: false });
  const r = await alerts.onBuy(buy(1, "0.3"));
  assert.deepEqual(r, { group: false, told: ["7"] });
  assert.equal(posted.length, 0, "under the group's line, over one user's");
  assert.equal(told.length, 1);
  assert.equal(told[0]!.to, "7");
  assert.match(told[0]!.text, /bought <code>0.3 ETH<\/code> of <b>\$PEPE<\/b>/);
  assert.match(told[0]!.text, /your line is 0.1 ETH a buy; 🔔 Alerts on your card changes it or turns this off\. one message per token an hour at most\./);
  assert.deepEqual(told[0]!.keyboard, [[{ text: "buy this", url: `https://t.me/usechit_bot?start=t-${PEPE}` }]]);
  await alerts.onBuy(buy(2, "1", NONAME));
  assert.deepEqual(told.slice(1).map((m) => m.to), ["7", "8"], "both lines cleared; 9 is off (another token, so 7's hour on PEPE does not hold this back)");
  assert.equal(posted.length, 1, "and the group, at its line");
});

test("rate limits: twenty group posts a run and no more, the count starts over with the run; one private message per user per token an hour, kept in the store, another token or another hour is another message", async () => {
  const { alerts, store, told, posted, tick } = setup({ maxGroupPerRun: 3 });
  await store.put({ tgId: "7", minEthWei: parseEther("0.1"), on: true });
  alerts.beginRun();
  for (let i = 1; i <= 5; i++) await alerts.onBuy(buy(i, "1"));
  assert.equal(posted.length, 3, "the run's allowance");
  assert.equal(told.length, 1, "the same token in the same hour: told once");
  assert.equal((await store.lastTold("7", PEPE))!.toISOString(), clock.toISOString());
  alerts.beginRun();
  await alerts.onBuy(buy(6, "1"));
  assert.equal(posted.length, 4, "a new run, a new allowance");
  assert.equal(told.length, 1);
  await alerts.onBuy(buy(7, "1", NONAME));
  assert.equal(told.length, 2, "another token is another message");
  tick(3_600_000 - 1);
  await alerts.onBuy(buy(8, "1"));
  assert.equal(told.length, 2, "not an hour yet");
  tick(1);
  await alerts.onBuy(buy(9, "1"));
  assert.equal(told.length, 3, "an hour on, told again");
  // A run of many small buys over the group's line but under every user's: the group is told up to its allowance, nobody else.
  const only = setup({ maxGroupPerRun: 20 });
  only.alerts.beginRun();
  for (let i = 1; i <= 25; i++) await only.alerts.onBuy(buy(i, "0.6"));
  assert.equal(only.posted.length, 20);
});

test("one failed message is one: a blocked user or a group that refuses is logged, the others are told, the buy is reported", async () => {
  const { alerts, store, told } = setup({ failTell: (to) => to === "7" });
  await store.put({ tgId: "7", minEthWei: parseEther("0.1"), on: true });
  await store.put({ tgId: "8", minEthWei: parseEther("0.1"), on: true });
  const r = await alerts.onBuy(buy(1, "1"));
  assert.deepEqual(r.told, ["8"]);
  assert.equal(r.group, true);
  assert.deepEqual(told.map((m) => m.to), ["8"]);
  assert.ok(await store.lastTold("7", PEPE), "marked before the send: the failed one is not retried into a loop");
});

const fakeSql = (answer: (query: string, params: unknown[]) => readonly Record<string, unknown>[] | undefined) => {
  const calls: { query: string; params: unknown[] }[] = [];
  const sql: AlertSql & { calls: typeof calls } = {
    calls,
    async query(query, params = []) {
      calls.push({ query, params });
      if (/^\s*CREATE/.test(query)) return [];
      const rows = answer(query, params);
      if (rows === undefined) throw new Error(`unexpected sql: ${query}`);
      return rows;
    },
  };
  return sql;
};

test("neon: a subscription is one upsert per user; active reads the ones that are on; the hourly mark is one upsert per user and token, lowercase", async () => {
  const sql = fakeSql((query, params) => {
    if (query.includes("INSERT INTO bot_alert_subs")) return [];
    if (query.includes("SELECT * FROM bot_alert_subs WHERE tg_id")) return params[0] === "7" ? [{ tg_id: "7", min_eth_wei: "100000000000000000", on: true }] : [];
    if (query.includes(`SELECT * FROM bot_alert_subs WHERE "on"`)) return [{ tg_id: "7", min_eth_wei: "100000000000000000", on: true }];
    if (query.includes("SELECT at FROM bot_alert_told")) return params[0] === "7" ? [{ at: clock.toISOString() }] : [];
    if (query.includes("INSERT INTO bot_alert_told")) return [];
    return undefined;
  });
  const store = new NeonAlertStore(sql);
  await store.put({ tgId: "7", minEthWei: parseEther("0.1"), on: true });
  const put = sql.calls.find((c) => c.query.includes("INSERT INTO bot_alert_subs"))!;
  assert.match(put.query, /ON CONFLICT \(tg_id\) DO UPDATE SET min_eth_wei = EXCLUDED.min_eth_wei, "on" = EXCLUDED."on"/);
  assert.deepEqual(put.params, ["7", parseEther("0.1").toString(), true]);
  assert.deepEqual(await store.get("7"), { tgId: "7", minEthWei: parseEther("0.1"), on: true });
  assert.equal(await store.get("8"), undefined);
  assert.deepEqual(await store.active(), [{ tgId: "7", minEthWei: parseEther("0.1"), on: true }]);
  assert.equal((await store.lastTold("7", PEPE))!.toISOString(), clock.toISOString());
  assert.equal(await store.lastTold("8", PEPE), undefined);
  await store.markTold("7", PEPE.toUpperCase().replace("0X", "0x") as Address, clock);
  const mark = sql.calls.at(-1)!;
  assert.match(mark.query, /INSERT INTO bot_alert_told \(tg_id, token, at\) VALUES \(\$1, \$2, \$3\) ON CONFLICT \(tg_id, token\) DO UPDATE SET at = EXCLUDED.at/);
  assert.deepEqual(mark.params, ["7", PEPE, clock.toISOString()]);
  const schema = sql.calls.filter((c) => /^\s*CREATE/.test(c.query)).map((c) => c.query);
  assert.ok(schema.some((q) => q.includes("bot_alert_subs")) && schema.some((q) => q.includes("bot_alert_told")));
});
