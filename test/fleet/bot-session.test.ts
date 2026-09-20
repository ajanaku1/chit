/**
 * The mainnet bot: no link, no trade; a link is a nonce and a signed
 * message; a buy asks the account first and is refused in its words; a buy
 * that passes is one execute from the bot's key with the bot's floor; the
 * daily limits stop a loop; sells and withdrawals are never offered.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex, parseEther } from "viem";
import type { BotChain } from "../../src/fleet/bot-chain.js";
import type { Update } from "../../src/fleet/bot-handlers.js";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import type { SessionChain } from "../../src/fleet/bot-session-chain.js";
import { SessionBot } from "../../src/fleet/bot-session.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, minOutFor } from "../../src/fleet/v4-swap.js";

const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address;
const OWNER = "0x0000000000000000000000000000000000000011" as Address;
const SIGNER = "0x00000000000000000000000000000000000000b0" as Address;
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
const clock = new Date("2026-09-20T12:00:00Z");

const reads = {
  chainId: 4663, router: ROUTER,
  async tokenInfo(token: Address) { return { address: token, symbol: token === PEPE ? "PEPE" : "NOPE", decimals: 6, hasPool: token === PEPE, perEth: 1_000_000_000_000n, poolEth: parseEther("5"), hooked: false, fee: 3000 }; },
  async tokenBalance() { return 42_000_000n; },
  async ethBalance() { return parseEther("0.4"); },
  async quoteBuy(token: Address, ethIn: bigint) { return token === PEPE ? (ethIn * 1_000_000_000_000n) / 10n ** 18n : null; },
} as unknown as BotChain;

const fakeSession = () => {
  const calls: { account: Address; target: Address; value: bigint; data: Hex }[] = [];
  let state = { exists: true, paused: false, revoked: false, expiry: Math.floor(clock.getTime() / 1000) + 86400, maxValuePerCall: parseEther("0.05").toString(), totalValueCap: parseEther("0.5").toString(), spentValue: "0", calls: 0 };
  let refuse: string | null = null;
  const s: SessionChain = {
    chainId: 4663, signer: SIGNER,
    async ownerOf(a) { return a.toLowerCase() === ACCOUNT ? OWNER : undefined; },
    async sessionOf() { return state; },
    async canExecute(_a, _t, _sel, value) { if (refuse) return { ok: false, why: refuse }; if (value > BigInt(state.maxValuePerCall)) return { ok: false, why: "over your per-trade cap" }; return { ok: true, why: "" }; },
    async execute(account, target, value, data) { calls.push({ account, target, value, data }); return { hash: ("0x" + "ab".repeat(32)) as Hex, landed: true }; },
    async signerBalance() { return parseEther("1"); },
  };
  return { s, calls, set: (p: Partial<typeof state>) => { state = { ...state, ...p }; }, refuseWith: (why: string | null) => { refuse = why; } };
};

const dm = (text: string, replyTo?: string): Update => ({ message: { message_id: 1, text, chat: { id: 7, type: "private" }, from: { id: 7 }, ...(replyTo ? { reply_to_message: { text: replyTo } } : {}) } });
const tap = (data: string, photo = false): Update => ({ callback_query: { id: "cb", data, from: { id: 7 }, message: { message_id: 9, chat: { id: 7, type: "private" }, ...(photo ? { photo: [{}] } : {}) } } });

type Deps = ConstructorParameters<typeof SessionBot>[0];
const setup = (opts: Partial<Deps> = {}) => {
  const links = new MemoryBotLinkStore();
  const session = fakeSession();
  const telegram = new RecordingTelegram();
  const bot = new SessionBot({ reads, session: session.s, links, telegram, botUsername: "usechit_bot", siteUrl: "https://chit.tools", now: () => clock, ...opts });
  const buttons = (): string[] => {
    const last = [...telegram.sent].reverse().find((o) => o.kind !== "answer") as { keyboard?: { callback_data?: string; url?: string }[][] } | undefined;
    return (last?.keyboard ?? []).flat().map((b) => b.callback_data ?? b.url ?? "");
  };
  const textAt = (i: number): string => { const o = telegram.sent.at(i); return o && o.kind !== "answer" ? o.text : ""; };
  return { links, session, telegram, bot, buttons, textAt };
};

const linked = (links: MemoryBotLinkStore) => links.putLink({ tgId: "7", account: ACCOUNT, owner: OWNER, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });

test("unlinked: the card names the signer and offers Connect only; a pasted token goes back to the card; Connect mints a nonce and sends the Sessions page", async () => {
  const { bot, telegram, buttons, links } = setup();
  await bot.handle(dm("/start"));
  assert.match(telegram.last(), /your keys stay with you/);
  assert.match(telegram.last(), new RegExp(SIGNER));
  assert.match(telegram.last(), /not audited by a firm yet/);
  assert.deepEqual(buttons(), ["connect", "help"], "no buy, no sell, no withdraw");
  await bot.handle(dm(PEPE));
  assert.match(telegram.last(), /never holds your key/, "no link, no token card");
  await bot.handle(tap("connect"));
  const href = buttons()[0]!;
  assert.ok(href.startsWith("https://chit.tools/app/sessions.html?link=") && href.endsWith(`&key=${SIGNER}`) && /link=[0-9a-f]{32}&/.test(href), href);
  const nonce = href.split("link=")[1]!.split("&")[0]!;
  assert.equal((await links.getNonce(nonce))!.tgId, "7", "the nonce is this telegram's");
  assert.match(telegram.last(), /15 minutes/);
});

test("linked: the card reads the session and the account; a token card offers buys only; a buy is one execute with the floor; refusals are the contract's words", async () => {
  const { bot, telegram, buttons, links, session, textAt } = setup();
  await linked(links);
  await bot.handle(dm("/start"));
  assert.match(telegram.last(), /session <b>active<\/b>: <code>0.05 ETH<\/code> a trade, <code>0.5 ETH<\/code> in all/);
  assert.match(telegram.last(), /account holds: <code>0.4 ETH<\/code>/);
  await bot.handle(dm(PEPE));
  assert.match(telegram.last(), /<b>PEPE<\/b>/);
  assert.match(telegram.last(), /your account holds: <code>42 PEPE<\/code>/);
  const b = buttons();
  assert.deepEqual(b.slice(0, 3), [`b:${PEPE}:0.005`, `b:${PEPE}:0.01`, `b:${PEPE}:0.05`]);
  assert.ok(!b.some((x) => /sell|withdraw/i.test(x)), "no sell, no withdraw on mainnet");
  await bot.handle(tap(`b:${PEPE}:0.01`));
  assert.equal(session.calls.length, 1, "one execute");
  assert.equal(session.calls[0]!.account, ACCOUNT);
  assert.equal(session.calls[0]!.target, ROUTER);
  assert.equal(session.calls[0]!.value, parseEther("0.01"));
  assert.ok(session.calls[0]!.data.startsWith(UNIVERSAL_ROUTER_EXECUTE_SELECTOR));
  assert.match(telegram.last(), /landed\. <a href="https:\/\/robinhoodchain\.blockscout\.com\/tx\/0xabab/);
  const floor = minOutFor((parseEther("0.01") * 1_000_000_000_000n) / 10n ** 18n, 300);
  assert.match(textAt(-2), new RegExp(`floor <code>${(floor / 1_000_000n).toString()}`));
  // Over the per-trade cap: the account refuses before any gas.
  await bot.handle(tap("ask:" + PEPE));
  await bot.handle(dm("0.06", "how much"));
  assert.match(telegram.last(), /your session says no: <b>over your per-trade cap<\/b>/);
  assert.equal(session.calls.length, 1, "no execute on a refusal");
  session.refuseWith("session paused");
  await bot.handle(tap(`b:${PEPE}:0.01`));
  assert.match(telegram.last(), /<b>session paused<\/b>/);
  session.refuseWith(null);
  session.set({ paused: true });
  await bot.handle(tap("home"));
  assert.match(telegram.last(), /session <b>paused<\/b> by you/);
});

test("the daily execute limit stops a loop, per user, and resets with the day", async () => {
  let t = clock;
  const { bot, links, session, telegram } = setup({ dailyExecutes: 2, now: () => t });
  await linked(links);
  for (let i = 0; i < 3; i++) await bot.handle(tap(`b:${PEPE}:0.01`));
  assert.equal(session.calls.length, 2);
  assert.match(telegram.last(), /2 buys today/);
  t = new Date(clock.getTime() + 86_400_000);
  await bot.handle(tap(`b:${PEPE}:0.01`));
  assert.equal(session.calls.length, 3, "a new day, a new count");
});

test("with a plate renderer the token card is a picture; the plate says mainnet; refresh redraws in place", async () => {
  const drawn: { testnet: boolean }[] = [];
  const { bot, links, telegram } = setup({ plate: async (c) => { drawn.push(c); return new Uint8Array([1]); } });
  await linked(links);
  await bot.handle(dm(PEPE));
  assert.equal(telegram.sent.at(-1)!.kind, "photo");
  assert.equal(drawn[0]!.testnet, false);
  await bot.handle(tap(`token:${PEPE}`, true));
  assert.equal(telegram.sent.at(-1)!.kind, "editPhoto");
});

test("orders: the card offers a limit buy and a dca only with a store; the prompts parse strictly and create orders the account first agreed to; the list cancels", async () => {
  const { MemoryOrderStore } = await import("../../src/fleet/bot-orders.js");
  const orders = new MemoryOrderStore();
  const { bot, telegram, buttons, links, session } = setup({ orders });
  await linked(links);
  await bot.handle(dm(PEPE));
  assert.ok(buttons().includes(`lim:${PEPE}`) && buttons().includes(`dca:${PEPE}`));
  // Without a store, no order buttons at all.
  const bare = setup();
  await linked(bare.links);
  await bare.bot.handle(dm(PEPE));
  assert.ok(!bare.buttons().some((b) => b.startsWith("lim:") || b.startsWith("dca:") || b === "orders"));
  // A limit: the wrong shape is refused with the format; the right one is stored in the token's base units.
  await bot.handle(tap(`lim:${PEPE}`));
  assert.match(telegram.last(), /like <code>0.02 at 1200000<\/code>/);
  await bot.handle(dm("0.02 for 1200000", "limit buy"));
  assert.match(telegram.last(), /not the format/);
  assert.equal((await orders.openFor("7")).length, 0);
  await bot.handle(tap(`lim:${PEPE}`));
  await bot.handle(dm("0.02 at 1200000", "limit buy"));
  let open = await orders.openFor("7");
  assert.equal(open.length, 1);
  assert.equal(open[0]!.kind, "limit");
  assert.equal(open[0]!.ethWei, parseEther("0.02"));
  assert.equal(open[0]!.triggerPerEth, 1_200_000n * 10n ** 6n, "tokens per eth in the token's six decimals");
  assert.equal(open[0]!.account, ACCOUNT);
  assert.match(telegram.last(), /limit buy <code>0.02 ETH<\/code> of <b>PEPE<\/b> at <code>1200000 PEPE<\/code> per ETH or better/);
  // Over the per-trade cap: the account says no before the order exists.
  await bot.handle(tap(`lim:${PEPE}`));
  await bot.handle(dm("0.06 at 1200000", "limit buy"));
  assert.match(telegram.last(), /your session says no to a buy of that size: <b>over your per-trade cap<\/b>/);
  assert.equal((await orders.openFor("7")).length, 1);
  // A dca: the first buy is due now, the interval in hours, the count kept.
  await bot.handle(tap(`dca:${PEPE}`));
  assert.match(telegram.last(), /like <code>0.01 every 4 hours 6 times<\/code>/);
  await bot.handle(dm("0.01 every 4 hours", "dca"));
  assert.match(telegram.last(), /not the format/);
  await bot.handle(tap(`dca:${PEPE}`));
  await bot.handle(dm("0.01 every 4 hours 6 times", "dca"));
  open = await orders.openFor("7");
  assert.equal(open.length, 2);
  const d = open.find((o) => o.kind === "dca")!;
  assert.equal(d.everyMs, 4 * 3_600_000);
  assert.equal(d.remaining, 6);
  assert.equal(d.nextAt, clock.toISOString());
  assert.equal(session.calls.length, 0, "placing an order executes nothing");
  // The home card has the list; the list has a cancel per order; only the owner's cancel counts.
  await bot.handle(dm("/start"));
  assert.ok(buttons().includes("orders"));
  await bot.handle(tap("orders"));
  assert.match(telegram.last(), /<b>your orders<\/b>\n1\. ⏱ limit buy .*\n2\. 🔁 dca <code>0.01 ETH<\/code> of <b>PEPE<\/b> every 4 hours, 6 left/);
  const cancels = buttons().filter((b) => b.startsWith("oc:"));
  assert.equal(cancels.length, 2);
  const stranger: Update = { callback_query: { id: "cb", data: cancels[0]!, from: { id: 8 }, message: { message_id: 9, chat: { id: 8, type: "private" } } } };
  await bot.handle(stranger);
  assert.equal((await orders.openFor("7")).length, 2, "someone else's tap cancels nothing");
  await bot.handle(tap(cancels[0]!));
  open = await orders.openFor("7");
  assert.equal(open.length, 1);
  assert.equal(open[0]!.kind, "dca");
  assert.equal((await orders.get(cancels[0]!.slice(3)))!.status, "cancelled");
  await bot.handle(tap(cancels[1]!));
  assert.match(telegram.last(), /no open orders/);
});
