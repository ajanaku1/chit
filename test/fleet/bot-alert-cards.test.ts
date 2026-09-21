/**
 * The 🔔 Alerts card in the mainnet bot: the button is on the home card,
 * linked or not, only when a store is wired; the card says the alerts are
 * read from the chain and says nothing about a token's safety beyond the
 * orus line; Turn on writes a subscription at the default line, Turn off
 * keeps the line and switches it off; Set the line opens the reply prompt
 * with the format, a reply that fits is stored and turns alerts on, one
 * that does not is refused with the format and the way back; the verbs are
 * the card's alone and a tap from a group draws nothing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, parseEther } from "viem";
import { MemoryAlertStore } from "../../src/fleet/bot-alerts.js";
import type { BotChain } from "../../src/fleet/bot-chain.js";
import type { Update } from "../../src/fleet/bot-handlers.js";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import { SessionBot } from "../../src/fleet/bot-session.js";
import type { SessionChain } from "../../src/fleet/bot-session-chain.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";

const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address;
const OWNER = "0x0000000000000000000000000000000000000011" as Address;
const clock = new Date("2026-09-20T12:00:00Z");

const reads = {
  chainId: 4663, router: "0x8876789976decbfcbbbe364623c63652db8c0904",
  async ethBalance() { return parseEther("0.4"); },
} as unknown as BotChain;
const session = {
  chainId: 4663, signer: "0x00000000000000000000000000000000000000b0",
  async sessionOf() { return { exists: true, paused: false, revoked: false, expiry: Math.floor(clock.getTime() / 1000) + 86400, maxValuePerCall: parseEther("0.05").toString(), totalValueCap: parseEther("0.5").toString(), spentValue: "0", calls: 0 }; },
} as unknown as SessionChain;

const dm = (text: string, replyTo?: string): Update => ({ message: { message_id: 1, text, chat: { id: 7, type: "private" }, from: { id: 7 }, ...(replyTo ? { reply_to_message: { text: replyTo } } : {}) } });
const tap = (data: string, chatType = "private"): Update => ({ callback_query: { id: "cb", data, from: { id: 7 }, message: { message_id: 9, chat: { id: 7, type: chatType } } } });

const setup = (withAlerts = true) => {
  const links = new MemoryBotLinkStore();
  const alerts = new MemoryAlertStore();
  const telegram = new RecordingTelegram();
  const bot = new SessionBot({ reads, session, links, telegram, botUsername: "usechit_bot", siteUrl: "https://chit.tools", now: () => clock, ...(withAlerts ? { alerts } : {}) });
  const buttons = (): string[] => {
    const last = [...telegram.sent].reverse().find((o) => o.kind !== "answer") as { keyboard?: { callback_data?: string; url?: string }[][] } | undefined;
    return (last?.keyboard ?? []).flat().map((b) => b.callback_data ?? b.url ?? "");
  };
  const labels = (): string[] => {
    const last = [...telegram.sent].reverse().find((o) => o.kind !== "answer") as { keyboard?: { text: string }[][] } | undefined;
    return (last?.keyboard ?? []).flat().map((b) => b.text);
  };
  return { links, alerts, telegram, bot, buttons, labels };
};

test("the button: on the home card linked or not when a store is wired, absent without one; the card's words", async () => {
  const bare = setup(false);
  await bare.bot.handle(dm("/start"));
  assert.ok(!bare.buttons().includes("alerts"), "no store, no button");
  const { bot, telegram, buttons, labels, links } = setup();
  await bot.handle(dm("/start"));
  assert.ok(buttons().includes("alerts"), "unlinked: the alert goes to this chat, no link needed");
  assert.ok(labels().includes("🔔 Alerts"));
  await links.putLink({ tgId: "7", account: ACCOUNT, owner: OWNER, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });
  await bot.handle(dm("/start"));
  assert.ok(buttons().includes("alerts"), "linked too");
  await bot.handle(tap("alerts"));
  const card = telegram.last();
  assert.match(card, /<b>🔔 alerts<\/b>/);
  assert.match(card, /big buys of \$CHIT and the tokens this bot lists, read from the chain \(the pool manager's swap log\), not from us/);
  assert.match(card, /any other pool on the chain is not watched, so nobody can open one and post through it/);
  assert.match(card, /the orus line under each is the only word on the token; unknown is not safe/);
  assert.match(card, /one message per token an hour at most/);
  assert.match(card, /alerts are <b>off<\/b>\. turn it on to be told here\./);
  assert.ok(!/safe\b|audited|anonymous/i.test(card.replace("unknown is not safe", "")), card);
  assert.deepEqual(buttons(), ["al:on", "al:ask", "home"]);
  assert.deepEqual(labels(), ["Turn on", "Set the line", "← Back"]);
});

test("Turn on writes the subscription at the default line and says so; the card then reads on; Turn off keeps the line, switches it off, and says how to come back", async () => {
  const { bot, telegram, alerts, buttons } = setup();
  await bot.handle(tap("al:on"));
  assert.deepEqual(await alerts.get("7"), { tgId: "7", minEthWei: parseEther("0.5"), on: true });
  assert.match(telegram.last(), /alerts on: a buy of <code>0.5 ETH<\/code> or more of \$CHIT or a listed token is told here, one per token an hour at most, read from the chain\. Set the line changes the amount\./);
  assert.deepEqual(buttons(), ["alerts", "home"]);
  await bot.handle(tap("alerts"));
  assert.match(telegram.last(), /alerts are <b>on<\/b>: buys of <code>0.5 ETH<\/code> and up, in this chat\./);
  assert.deepEqual(buttons(), ["al:off", "al:ask", "home"]);
  await bot.handle(tap("al:off"));
  assert.deepEqual(await alerts.get("7"), { tgId: "7", minEthWei: parseEther("0.5"), on: false });
  assert.match(telegram.last(), /alerts off\. nothing more is sent here; Turn on brings them back at your line\./);
  await bot.handle(tap("alerts"));
  assert.match(telegram.last(), /alerts are <b>off<\/b>\. turn it on to be told here \(your line was <code>0.5 ETH<\/code>\)\./);
});

test("Set the line: the prompt names the format and opens the reply field; a reply that fits is stored and turns alerts on; a stray line typed without the prompt is not read as one", async () => {
  const { bot, telegram, alerts, buttons } = setup();
  await bot.handle(tap("al:ask"));
  const prompt = telegram.sent.at(-1) as { text: string; ask?: string };
  assert.match(prompt.text, /^min ETH per buy to alert you, like 0\.5\. reply with a number \(up to 1000\); setting it turns alerts on\.$/);
  assert.equal(prompt.ask, "min ETH per buy, like 0.5");
  await bot.handle(dm("0.25", "min ETH per buy"));
  assert.deepEqual(await alerts.get("7"), { tgId: "7", minEthWei: parseEther("0.25"), on: true });
  assert.match(telegram.last(), /alerts on at <code>0.25 ETH<\/code> a buy, in this chat, read from the chain\. one message per token an hour at most\./);
  assert.deepEqual(buttons(), ["alerts", "home"]);
  // No prompt open: a number typed on its own is the help card, not a line.
  await bot.handle(dm("0.9", "min ETH per buy"));
  assert.equal((await alerts.get("7"))!.minEthWei, parseEther("0.25"), "the prompt is spent");
  assert.match(telegram.last(), /chit bot on mainnet/);
});

test("a refused line says the format and the way back, and offers the prompt again; nothing is stored", async () => {
  const { bot, telegram, alerts, buttons, labels } = setup();
  for (const bad of ["abc", "0", "-1", "1,5", "1001"]) {
    await bot.handle(tap("al:ask"));
    await bot.handle(dm(bad, "min ETH per buy"));
    assert.match(telegram.last(), /the line must be a number of ETH, like 0\.5, above zero and up to 1000\. tap Set the line again to retry\./, bad);
    assert.deepEqual(buttons(), ["al:ask", "alerts"], bad);
    assert.deepEqual(labels(), ["Set the line", "← Back"]);
    assert.equal(await alerts.get("7"), undefined, `nothing stored for ${bad}`);
  }
});

test("a tap from a group is answered and draws nothing; an unknown alerts verb falls back to the card", async () => {
  const { bot, telegram, alerts } = setup();
  await bot.handle(tap("al:on", "supergroup"));
  assert.equal(await alerts.get("7"), undefined);
  assert.deepEqual(telegram.sent.map((o) => o.kind), ["answer"]);
  await bot.handle(tap("al:whatever"));
  assert.match(telegram.last(), /<b>🔔 alerts<\/b>/);
});
