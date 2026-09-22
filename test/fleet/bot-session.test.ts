/**
 * The mainnet bot: no link, no trade; a link is a nonce and a signed
 * message; a buy asks the account first and is refused in its words; a buy
 * that passes is one execute from the bot's key with the bot's floor; the
 * daily limits stop a loop; a sell needs the owner's flag and is then one
 * `sell` on the account from the bot's key, asked `canSell` first and
 * refused in the contract's words, with no approval step before or after;
 * an update delivered twice runs once; a failure is a message, never a
 * throw; a tap from a group draws nothing there; withdrawals are never
 * offered. A refusal of a typed reply says how to get the prompt back and
 * offers it. The copy desk's cards promise only what the desk does: tapped
 * buys mirrored, orders and sells not; the feed's follow door names the
 * leader's account, never their Telegram id; a leader's mirrors are given
 * what is left of the request's sixty seconds, receipts included. Become a
 * leader asks from where, the account or the wallet; the wallet choice
 * mints a nonce and sends the Sessions page's lead link, and a wallet
 * leader's cards say the wallet and what is copied from it, with the venue
 * path's bounds; a wallet leader's own taps are not mirrored or posted. A
 * tap asks the copy desk's ledger too and writes itself into it, so the
 * mirrors the watcher's function made into an account and the taps made
 * here are one day's allowance.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex, parseEther } from "viem";
import type { BotChain } from "../../src/fleet/bot-chain.js";
import type { Update } from "../../src/fleet/bot-handlers.js";
import { CopyDesk, MemoryCopyStore } from "../../src/fleet/bot-copy.js";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import type { OrusScan } from "../../src/fleet/bot-orus.js";
import { SessionBot } from "../../src/fleet/bot-session.js";
import type { SessionSell } from "../../src/fleet/session-keys.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";
import { sellPreflight, type SessionChain } from "../../src/fleet/bot-session-chain.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, minOutFor, venuePoolKey } from "../../src/fleet/v4-swap.js";

const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address;
const OWNER = "0x0000000000000000000000000000000000000011" as Address;
const SIGNER = "0x00000000000000000000000000000000000000b0" as Address;
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
const clock = new Date("2026-09-20T12:00:00Z");

const reads = {
  chainId: 4663, router: ROUTER,
  async tokenInfo(token: Address) { return { address: token, symbol: token === PEPE ? "PEPE" : "NOPE", decimals: 6, hasPool: token === PEPE, perEth: 1_000_000_000_000n, poolEth: parseEther("5"), hooked: false, fee: 3000, poolOnRecord: token === PEPE }; },
  async tokenBalance() { return 42_000_000n; },
  async ethBalance() { return parseEther("0.4"); },
  async quoteBuy(token: Address, ethIn: bigint) { return token === PEPE ? (ethIn * 1_000_000_000_000n) / 10n ** 18n : null; },
  async quoteSell(token: Address, tokensIn: bigint) { return token === PEPE ? (tokensIn * 10n ** 18n) / 1_000_000_000_000n : null; },
} as unknown as BotChain;

const fakeSession = () => {
  const calls: { account: Address; target: Address; value: bigint; data: Hex; receiptWaitMs?: number }[] = [];
  let onExecute: ((account: Address) => Promise<void>) | undefined;
  let state = { exists: true, paused: false, revoked: false, expiry: Math.floor(clock.getTime() / 1000) + 86400, maxValuePerCall: parseEther("0.05").toString(), totalValueCap: parseEther("0.5").toString(), spentValue: "0", calls: 0 };
  let refuse: string | null = null;
  // The sell side: the owner's flag, each sale sent, and whether a sale lands. canSell answers the way the contract does: the flag first, then the session.
  let sell = false, saleLands = true;
  const sales: { account: Address; sale: SessionSell }[] = [];
  const s: SessionChain = {
    chainId: 4663, signer: SIGNER,
    async ownerOf(a) { return a.toLowerCase() === ACCOUNT ? OWNER : undefined; },
    async sessionOf() { return state; },
    async canExecute(_a, _t, _sel, value) { if (refuse) return { ok: false, why: refuse }; if (value > BigInt(state.maxValuePerCall)) return { ok: false, why: "over your per-trade cap" }; return { ok: true, why: "" }; },
    async execute(account, target, value, data, receiptWaitMs) { calls.push({ account, target, value, data, ...(receiptWaitMs !== undefined ? { receiptWaitMs } : {}) }); if (onExecute) await onExecute(account); return { hash: ("0x" + "ab".repeat(32)) as Hex, landed: true }; },
    async signerBalance() { return parseEther("1"); },
    async sellAllowed() { return sell; },
    async canSell(_a, _router, poolKey, _amountIn, minOut) {
      const early = sellPreflight(poolKey?.currency1 ?? PEPE, poolKey, minOut);
      if (early) return { ok: false, why: early };
      if (!sell) return { ok: false, why: "sell not allowed" };
      return refuse ? { ok: false, why: refuse } : { ok: true, why: "" };
    },
    async sell(account, sale) { sales.push({ account, sale }); return { hash: ("0x" + "cd".repeat(32)) as Hex, landed: saleLands }; },
  };
  return { s, calls, sales, set: (p: Partial<typeof state>) => { state = { ...state, ...p }; }, refuseWith: (why: string | null) => { refuse = why; }, allowSell: (v: boolean) => { sell = v; }, saleLands: (v: boolean) => { saleLands = v; }, during: (f: ((account: Address) => Promise<void>) | undefined) => { onExecute = f; } };
};

const dm = (text: string, replyTo?: string): Update => ({ message: { message_id: 1, text, chat: { id: 7, type: "private" }, from: { id: 7 }, ...(replyTo ? { reply_to_message: { text: replyTo } } : {}) } });
const tap = (data: string, photo = false, updateId?: number): Update => ({ ...(updateId !== undefined ? { update_id: updateId } : {}), callback_query: { id: "cb", data, from: { id: 7 }, message: { message_id: 9, chat: { id: 7, type: "private" }, ...(photo ? { photo: [{}] } : {}) } } });

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
  assert.ok(!b.some((x) => /withdraw/i.test(x)), "no withdraw on mainnet");
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

test("the same update id delivered twice runs the buy once: the claim is taken before anything else, so a retry after a throw or a killed function is a no-op", async () => {
  const { bot, links, session, telegram } = setup();
  await linked(links);
  await bot.handle(tap(`b:${PEPE}:0.01`, false, 1001));
  const sent = telegram.sent.length;
  await bot.handle(tap(`b:${PEPE}:0.01`, false, 1001));
  assert.equal(session.calls.length, 1, "one execute for one update, however often it is delivered");
  assert.equal(telegram.sent.length, sent, "and not a word on the second delivery");
  await bot.handle(tap(`b:${PEPE}:0.01`, false, 1002));
  assert.equal(session.calls.length, 2, "a new update id is a new tap");
});

test("a throw while handling is a message to the user and a resolved handle, never a rejection that would earn a redelivery", async () => {
  const broken = { ...reads, async tokenInfo() { throw new Error("rpc: 502 bad gateway"); } } as unknown as BotChain;
  const { bot, links, telegram } = setup({ reads: broken });
  await linked(links);
  await bot.handle(tap(`b:${PEPE}:0.01`));
  assert.match(telegram.last(), /something broke on our side\. try again in a moment\./);
  const chainy = { ...reads, async tokenInfo() { throw Object.assign(new Error("x"), { shortMessage: "execution reverted: paused" }); } } as unknown as BotChain;
  const c = setup({ reads: chainy });
  await linked(c.links);
  await c.bot.handle(dm(PEPE));
  assert.match(c.telegram.last(), /the chain said: <code>execution reverted: paused<\/code>/);
});

test("a tap that arrives from a group is answered and nothing is drawn or edited there: the feed's messages carry url buttons only, so such a callback is forged", async () => {
  const { bot, links, telegram, session } = setup();
  await linked(links);
  const forged: Update = { callback_query: { id: "cb", data: `b:${PEPE}:0.01`, from: { id: 7 }, message: { message_id: 55, chat: { id: -100, type: "supergroup" } } } };
  await bot.handle(forged);
  assert.equal(session.calls.length, 0);
  assert.deepEqual(telegram.sent, [{ kind: "answer", callbackId: "cb", text: "open the bot in private" }]);
  await bot.handle({ callback_query: { id: "cb2", data: `token:${PEPE}`, from: { id: 7 }, message: { message_id: 55, chat: { id: -100, type: "supergroup" } } } });
  assert.ok(!telegram.sent.some((o) => o.kind !== "answer"), "no card into the group, no edit of the feed's message");
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

// ---------- leaders and followers (bot-copy.ts, bot-copy-cards.ts) ----------

const FOLLOWER_ACCOUNT = "0x00000000000000000000000000000000000000bb" as Address;
const safe: OrusScan = { symbol: "PEPE", honeypot: false, buyTaxPct: 0, sellTaxPct: 0, bundlersPct: null, top10Pct: null, holders: 100, liquidityUsd: 50_000, lpBurnedPct: null, marketCapUsd: null, deployerLaunches: 1, checkedAt: clock.toISOString() };
const orus = { scan: async () => safe, link: (t: Address) => `https://www.orusagent.xyz/token/${t}` };
const withCopy = (opts: Partial<Deps> = {}, feed: { post?: (text: string) => Promise<void> } = {}) => {
  const s = setup(opts);
  const store = new MemoryCopyStore();
  // What the feed saw when each message was posted: the text and how many executes had run by then.
  const posted: { text: string; keyboard?: unknown; executesSoFar: number }[] = [];
  const copy = new CopyDesk({
    store, links: s.links, reads, session: opts.session ?? s.session.s, orus, now: opts.now ?? (() => clock), botUsername: "usechit_bot",
    // The daily limits are the bot's, as the runtime hands the same env to both.
    ...(opts.dailyExecutes !== undefined ? { dailyExecutes: opts.dailyExecutes } : {}), ...(opts.dailyGasWei !== undefined ? { dailyGasWei: opts.dailyGasWei } : {}),
    tell: (to, text) => s.telegram.deliver({ kind: "send", chatId: to, text }),
    feed: { chatId: "-100", post: async (text, keyboard) => { if (feed.post) await feed.post(text); posted.push({ text, keyboard, executesSoFar: s.session.calls.length }); } },
  });
  const bot = new SessionBot({ reads, session: s.session.s, links: s.links, telegram: s.telegram, botUsername: "usechit_bot", siteUrl: "https://chit.tools", now: () => clock, copy, orus, ...opts });
  return { ...s, bot, copy, store, posted };
};
const asUser = (id: number, data: string, from: Record<string, unknown> = {}): Update => ({ callback_query: { id: "cb", data, from: { id, ...from }, message: { message_id: 9, chat: { id, type: "private" } } } });
const says = (id: number, text: string, replyTo?: string): Update => ({ message: { message_id: 1, text, chat: { id, type: "private" }, from: { id }, ...(replyTo ? { reply_to_message: { text: replyTo } } : {}) } });
const followerLinked = (links: MemoryBotLinkStore) => links.putLink({ tgId: "8", account: FOLLOWER_ACCOUNT, owner: OWNER, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });

test("without a copy desk the home card has no leader buttons; with one, a linked card offers Leaders, My follows and Become a leader", async () => {
  const plain = setup();
  await linked(plain.links);
  await plain.bot.handle(dm("/start"));
  assert.ok(!plain.buttons().some((b) => /leaders|follows|lead:/.test(b)));
  const { bot, buttons, links } = withCopy();
  await linked(links);
  await bot.handle(dm("/start"));
  assert.deepEqual(buttons().filter((b) => /leaders|follows|lead:/.test(b)), ["leaders", "follows", "lead:on"]);
});

test("⭐ Become a leader asks from where, the account or the wallet, and says what each means; the account choice takes the Telegram username as the handle; the card then offers close leader; the list shows the leader with a short account and the count, without a follow button for yourself", async () => {
  const { bot, buttons, links, telegram, copy } = withCopy();
  await linked(links);
  await bot.handle(asUser(7, "lead:on", { username: "ogle", first_name: "O" }));
  assert.match(telegram.last(), /<b>become a leader<\/b>\nwhere do you trade from\?/);
  assert.match(telegram.last(), /<b>my session account<\/b>: every buy you tap in this bot that lands is posted to the feed and mirrored/);
  assert.match(telegram.last(), /<b>my own wallet<\/b>: you sign one message on the Sessions page with the wallet you trade from \(no account, no session, no key handed over\), and every ETH buy that wallet makes on the venue is read from the chain within a few minutes, posted and mirrored the same way: a buy of 0.01 ETH or more through the token's own pool on the venue, up to 20 a day, for a token orus clears; a smaller buy, one through another pool or a token orus will not clear is not, and your taps in this bot are not either\./);
  assert.match(telegram.last(), /either way your sells and your standing orders are never mirrored/);
  assert.deepEqual(buttons(), ["lead:acct", "lead:wallet", "home"]);
  assert.equal(await copy.leader("7"), undefined, "asking opens nobody");
  await bot.handle(asUser(7, "lead:acct", { username: "ogle", first_name: "O" }));
  assert.match(telegram.last(), /you are a leader as <b>@ogle<\/b>/);
  assert.match(telegram.last(), new RegExp(`<code>${ACCOUNT}</code> is public on the leaders list and on the feed's follow button now \\(your telegram id never is\\)`));
  assert.match(telegram.last(), /every buy you tap here that lands is posted to the feed and mirrored/);
  assert.match(telegram.last(), /a limit buy or a dca of yours that fires from the clock, and a sell, is yours alone: not posted, not mirrored/, "the leader is promised only what the desk does");
  assert.equal((await copy.leader("7"))!.handle, "@ogle");
  await bot.handle(dm("/start"));
  assert.ok(buttons().includes("lead:off"));
  await bot.handle(tap("leaders"));
  assert.match(telegram.last(), /<b>@ogle<\/b> · <code>0x0000…00aa<\/code> · 0 followers/);
  assert.match(telegram.last(), /orus's read first/);
  assert.match(telegram.last(), /when a buy they tap in this bot lands/);
  assert.match(telegram.last(), /their sells are never mirrored/);
  assert.ok(!buttons().includes("fl:7"), "no follow button for yourself");
  await bot.handle(tap("lead:off"));
  assert.match(telegram.last(), /leader closed/);
  assert.equal(await copy.leader("7"), undefined);
});

test("a leader with no username and no first name is asked once for a name, and the reply opens them", async () => {
  const { bot, links, telegram, copy } = withCopy();
  await linked(links);
  await bot.handle(asUser(7, "lead:acct"));
  assert.match(telegram.last(), /what should followers call you/);
  await bot.handle(dm("lucian", "what should"));
  assert.equal((await copy.leader("7"))!.handle, "lucian");
});

test("a first name that starts with @ or reads as the project is not a handle: the bot asks; a typed @name or a taken name is refused in words, a plain one opens them", async () => {
  const { bot, links, telegram, copy } = withCopy();
  await linked(links);
  await followerLinked(links);
  await bot.handle(asUser(7, "lead:acct", { first_name: "@lucian" }));
  assert.match(telegram.last(), /what should followers call you/, "a first name is any text; one wearing an @ is not taken as a handle");
  await bot.handle(dm("@lucian", "what should"));
  assert.match(telegram.last(), /that name will not do: .*no @/);
  assert.equal(await copy.leader("7"), undefined);
  await bot.handle(asUser(7, "lead:acct", { first_name: "chit support" }));
  assert.match(telegram.last(), /what should followers call you/);
  await bot.handle(dm("lucian", "what should"));
  assert.equal((await copy.leader("7"))!.handle, "lucian");
  await bot.handle(asUser(8, "lead:acct", { first_name: "Lucian" }));
  assert.match(telegram.last(), /not a leader yet: that name is already on the leaders list\. tap ⭐ Become a leader again and reply with another\./);
  assert.equal(await copy.leader("8"), undefined);
});

test("following: the list's button opens the leader's card, set a cap asks by reply, the reply follows within the cap; My follows lists it with an unfollow button; /start f-<account> opens the same card, a Telegram id does not", async () => {
  const { bot, buttons, links, telegram, copy } = withCopy();
  await linked(links);
  await followerLinked(links);
  await bot.handle(asUser(7, "lead:acct", { username: "ogle" }));
  await bot.handle(asUser(8, "leaders"));
  assert.ok(buttons().includes("fl:7"));
  await bot.handle(asUser(8, "fl:7"));
  assert.match(telegram.last(), /<b>follow @ogle<\/b>/);
  assert.match(telegram.last(), /unfollow is one tap here; revoke the session in one transaction/);
  assert.match(telegram.last(), /when a buy they tap in this bot lands, the same token is bought on your session account/);
  assert.match(telegram.last(), /only a buy they tap in this bot is mirrored: their limit buys and dca fire from the clock and are not, and their sells are never mirrored, so getting out of a mirrored position is yours alone/, "the card says what is not mirrored: the exit is the follower's own");
  assert.ok(buttons().includes("askf:7"));
  await bot.handle(asUser(8, "askf:7"));
  assert.match(telegram.last(), /how much ETH at most per buy mirrored from <b>@ogle<\/b>/);
  await bot.handle(says(8, "0.02", "how much"));
  assert.match(telegram.last(), /following <b>@ogle<\/b> at <code>0.02 ETH<\/code> a buy/);
  assert.match(telegram.last(), /their next tapped buy that lands through this bot is mirrored on your account.*their orders and their sells are not, so the exit is yours/);
  assert.equal((await copy.followsOf("8"))[0]!.capWei, parseEther("0.02"));
  await bot.handle(asUser(8, "follows"));
  assert.match(telegram.last(), /<b>@ogle<\/b> · <code>0.02 ETH<\/code> a buy/);
  assert.ok(buttons().includes("unf:7"));
  await bot.handle(says(8, `/start f-${ACCOUNT}`));
  assert.match(telegram.last(), /<b>follow @ogle<\/b>/, "the feed's door names the leader's account");
  assert.match(telegram.last(), /you follow them at <code>0.02 ETH<\/code>/);
  await bot.handle(says(8, "/start f-7"));
  assert.match(telegram.last(), /that leader is not open to followers right now/, "a Telegram id is not a door: nobody maps an id to a leader through the bot");
  await bot.handle(says(8, `/start f-${FOLLOWER_ACCOUNT}`));
  assert.match(telegram.last(), /that leader is not open to followers right now/, "an account that is not an open leader's is not one either");
  await bot.handle(asUser(8, "unf:7"));
  assert.match(telegram.last(), /unfollowed <b>@ogle<\/b>/);
  assert.deepEqual(await copy.followsOf("8"), []);
  // A cap over the bound is refused in words, with what to do.
  await bot.handle(asUser(8, "askf:7"));
  await bot.handle(says(8, "2", "how much"));
  assert.match(telegram.last(), /not followed: cap must be between 1 wei and 1 ETH\. tap follow again/);
  assert.deepEqual(await copy.followsOf("8"), []);
});

test("a leader's landed buy is mirrored into the follower's account at the smaller of the amounts and then posted once to the feed with the two doors and the count; the leader is told in one line, the follower too", async () => {
  const { bot, links, telegram, session, posted } = withCopy();
  await linked(links);
  await followerLinked(links);
  await bot.handle(asUser(7, "lead:acct", { username: "ogle" }));
  await bot.handle(asUser(8, "askf:7"));
  await bot.handle(says(8, "0.005", "how much"));
  await bot.handle(tap(`b:${PEPE}:0.01`));
  assert.equal(posted.length, 1, "one message to the feed");
  assert.equal(posted[0]!.executesSoFar, 2, "posted after the follower's mirror ran, never before: the group cannot run ahead of it");
  assert.match(posted[0]!.text, /^<b>@ogle<\/b> bought <code>0.01 ETH<\/code> of <b>PEPE<\/b> · <a href="https:\/\/robinhoodchain\.blockscout\.com\/tx\/0xabab/);
  assert.match(posted[0]!.text, /\nmirrored into 1 of 1 follower account, already landed or sent$/);
  assert.deepEqual(posted[0]!.keyboard, [[{ text: "buy this", url: `https://t.me/usechit_bot?start=t-${PEPE}` }, { text: "follow @ogle", url: `https://t.me/usechit_bot?start=f-${ACCOUNT}` }]], "the follow door carries the account the leader agreed to show, not their Telegram id");
  assert.ok(!JSON.stringify(posted[0]).includes("f-7"), "the leader's Telegram id is nowhere in what the group reads");
  assert.deepEqual(session.calls.map((c) => [c.account, c.value]), [[ACCOUNT, parseEther("0.01")], [FOLLOWER_ACCOUNT, parseEther("0.005")]], "the leader first, then the follower at their cap");
  const toFollower = telegram.sent.filter((o) => o.kind === "send" && o.chatId === "8").map((o) => (o as { text: string }).text);
  assert.match(toFollower.at(-1)!, /copied <b>@ogle<\/b>: <code>0.005 ETH<\/code> into/);
  assert.match(telegram.last(), /mirrored to 1 of 1 follower\./);
  // A buy that did not land posts nothing and mirrors nothing.
  const quiet = withCopy({ session: { ...session.s, execute: async () => ({ hash: ("0x" + "cd".repeat(32)) as Hex, landed: false }) } });
  await linked(quiet.links);
  await followerLinked(quiet.links);
  await quiet.bot.handle(asUser(7, "lead:acct", { username: "ogle" }));
  await quiet.bot.handle(asUser(8, "askf:7"));
  await quiet.bot.handle(says(8, "0.005", "how much"));
  await quiet.bot.handle(tap(`b:${PEPE}:0.01`));
  assert.equal(quiet.posted.length, 0);
  assert.match(quiet.telegram.last(), /sent, not confirmed as landed/);
});

test("a mirrored buy spends the follower's own daily allowance, the same one their taps spend: at the limit the mirror is skipped with the reason, and a mirror counts against their next tap", async () => {
  const { bot, links, telegram, session } = withCopy({ dailyExecutes: 1 });
  await linked(links);
  await followerLinked(links);
  await bot.handle(asUser(7, "lead:acct", { username: "ogle" }));
  await bot.handle(asUser(8, "askf:7"));
  await bot.handle(says(8, "0.005", "how much"));
  // The leader's first buy mirrors once into the follower: that is the follower's one execute today.
  await bot.handle(tap(`b:${PEPE}:0.01`));
  assert.deepEqual(session.calls.map((c) => c.account), [ACCOUNT, FOLLOWER_ACCOUNT]);
  const follower = () => telegram.sent.filter((o) => o.kind === "send" && o.chatId === "8").map((o) => (o as { text: string }).text);
  await bot.handle({ callback_query: { id: "cb", data: `b:${PEPE}:0.01`, from: { id: 8 }, message: { message_id: 9, chat: { id: 8, type: "private" } } } });
  assert.match(follower().at(-1)!, /that is 1 buys today from this account; again tomorrow/, "the mirror was counted like a tap of theirs");
  assert.equal(session.calls.length, 2);
  // The leader's day is their own: a second buy runs for them, and the follower's mirror is skipped with the reason.
  const fresh = withCopy({ dailyExecutes: 2 });
  await linked(fresh.links);
  await followerLinked(fresh.links);
  await fresh.bot.handle(asUser(7, "lead:acct", { username: "ogle" }));
  await fresh.bot.handle(asUser(8, "askf:7"));
  await fresh.bot.handle(says(8, "0.005", "how much"));
  await fresh.bot.handle({ callback_query: { id: "cb", data: `b:${PEPE}:0.01`, from: { id: 8 }, message: { message_id: 9, chat: { id: 8, type: "private" } } } });
  await fresh.bot.handle({ callback_query: { id: "cb", data: `b:${PEPE}:0.01`, from: { id: 8 }, message: { message_id: 9, chat: { id: 8, type: "private" } } } });
  await fresh.bot.handle(tap(`b:${PEPE}:0.01`));
  assert.deepEqual(fresh.session.calls.map((c) => c.account), [FOLLOWER_ACCOUNT, FOLLOWER_ACCOUNT, ACCOUNT], "the leader's buy ran; no third execute for the follower");
  const toFollower = fresh.telegram.sent.filter((o) => o.kind === "send" && o.chatId === "8").map((o) => (o as { text: string }).text);
  assert.match(toFollower.at(-1)!, /copy from <b>@ogle<\/b>: skipped\. that is 2 buys today from your account; again tomorrow\./);
  assert.match(fresh.telegram.last(), /mirrored to 0 of 1 follower, 1 skipped/);
});

test("a wallet leader who links an account too keeps their taps to themselves: their followers were promised that wallet's venue buys, so a tapped buy of theirs is neither mirrored nor posted and no count is said", async () => {
  const { bot, links, telegram, session, posted, store } = withCopy();
  await linked(links);
  await followerLinked(links);
  const wallet = "0x00000000000000000000000000000000000000ee" as Address;
  await store.putLeader({ tgId: "7", account: wallet, wallet, handle: "whale", since: clock.toISOString(), open: true, kind: "wallet" });
  await bot.handle(asUser(8, "askf:7"));
  await bot.handle(says(8, "0.005", "how much"));
  await bot.handle(tap(`b:${PEPE}:0.01`));
  assert.deepEqual(session.calls.map((c) => c.account), [ACCOUNT], "the leader's own buy and nothing into the follower");
  assert.equal(posted.length, 0, "the feed has nothing: the group was promised the wallet's buys");
  assert.doesNotMatch(telegram.last(), /mirrored to/);
  assert.match(telegram.last(), /landed\./);
  // Opened from the account again, the same user is an account leader and the tap is mirrored as before.
  await bot.handle(asUser(7, "lead:acct", { username: "whale" }));
  await bot.handle(tap(`b:${PEPE}:0.01`));
  assert.deepEqual(session.calls.map((c) => c.account), [ACCOUNT, ACCOUNT, FOLLOWER_ACCOUNT]);
  assert.equal(posted.length, 1);
});

test("a tap asks the copy desk's ledger and writes itself into it: mirrors the watcher's function made into the account today refuse the tap in the same words, and a tap counts against the next venue mirror", async () => {
  const { bot, links, telegram, session, copy } = withCopy({ dailyExecutes: 2 });
  await linked(links);
  // Two mirrors landed into this account from the watcher's function, in another instance: this instance's memory never saw them.
  await copy.chargeDay("7");
  await copy.chargeDay("7");
  await bot.handle(tap(`b:${PEPE}:0.01`));
  assert.equal(session.calls.length, 0, "the ledger says the day is spent");
  assert.match(telegram.last(), /^that is 2 buys today from your account; again tomorrow\.$/);
  const fresh = withCopy({ dailyExecutes: 2 });
  await linked(fresh.links);
  await fresh.bot.handle(tap(`b:${PEPE}:0.01`));
  assert.equal(fresh.session.calls.length, 1);
  assert.equal(await fresh.copy.overDay("7"), null, "one tap in the ledger, room for one more");
  assert.equal(await fresh.copy.chargeDay("7"), null, "a venue mirror takes the second");
  assert.equal(await fresh.copy.chargeDay("7"), "that is 2 buys today from your account; again tomorrow", "and the next venue mirror is refused: the tap counted");
});

test("a failure in the feed or the mirrors after the leader's buy landed is caught: the leader is told, the handle resolves, and a redelivery of the tap runs nothing", async () => {
  const { bot, links, telegram, session } = withCopy({}, { post: async () => { throw new Error("telegram: 429"); } });
  await linked(links);
  await followerLinked(links);
  await bot.handle(asUser(7, "lead:acct", { username: "ogle" }));
  await bot.handle(asUser(8, "askf:7"));
  await bot.handle(says(8, "0.005", "how much"));
  await bot.handle(tap(`b:${PEPE}:0.01`, false, 77));
  assert.deepEqual(session.calls.map((c) => c.account), [ACCOUNT, FOLLOWER_ACCOUNT], "the mirror ran before the feed failed");
  assert.match(telegram.last(), /your buy landed\. the feed or a mirror broke on our side after it/);
  await bot.handle(tap(`b:${PEPE}:0.01`, false, 77));
  assert.equal(session.calls.length, 2, "the redelivered tap buys nothing again for anyone");
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
  assert.match(telegram.last(), /not the format.*like <code>0.02 at 1200000<\/code>\. tap \u23F1 Limit buy again to retry\./u, "the refusal says how to get the prompt back");
  assert.ok(buttons().includes(`lim:${PEPE}`), "and offers it");
  assert.equal((await orders.openFor("7", 4663)).length, 0);
  await bot.handle(dm("0.02 at 1200000"));
  assert.match(telegram.last(), /<b>chit bot on mainnet<\/b>/, "a corrected line typed without the prompt is not an order: the slot was spent, which is why the way back is said");
  assert.equal((await orders.openFor("7", 4663)).length, 0);
  await bot.handle(tap(`lim:${PEPE}`));
  await bot.handle(dm("0.02 at 1200000", "limit buy"));
  let open = await orders.openFor("7", 4663);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.kind, "limit");
  assert.equal(open[0]!.ethWei, parseEther("0.02"));
  assert.equal(open[0]!.triggerPerEth, 1_200_000n * 10n ** 6n, "tokens per eth in the token's six decimals");
  assert.equal(open[0]!.account, ACCOUNT);
  assert.equal(open[0]!.chainId, 4663, "the order carries the chain it was placed on");
  assert.match(telegram.last(), /limit buy <code>0.02 ETH<\/code> of <b>PEPE<\/b> at <code>1200000 PEPE<\/code> per ETH or better/);
  // Over the per-trade cap: the account says no before the order exists.
  await bot.handle(tap(`lim:${PEPE}`));
  await bot.handle(dm("0.06 at 1200000", "limit buy"));
  assert.match(telegram.last(), /your session says no to a buy of that size: <b>over your per-trade cap<\/b>/);
  assert.equal((await orders.openFor("7", 4663)).length, 1);
  // A dca: the first buy is due now, the interval in hours, the count kept.
  await bot.handle(tap(`dca:${PEPE}`));
  assert.match(telegram.last(), /like <code>0.01 every 4 hours 6 times<\/code>/);
  await bot.handle(dm("0.01 every 4 hours", "dca"));
  assert.match(telegram.last(), /not the format.*\. tap \u{1F501} DCA again to retry\./u);
  assert.ok(buttons().includes(`dca:${PEPE}`));
  await bot.handle(tap(`dca:${PEPE}`));
  await bot.handle(dm("0.01 every 0 hours 6 times", "dca"));
  assert.match(telegram.last(), /the interval must be between 1 and 720 hours\. tap \u{1F501} DCA again to retry\./u, "every refusal of the shape says the same");
  assert.ok(buttons().includes(`dca:${PEPE}`));
  await bot.handle(tap(`dca:${PEPE}`));
  await bot.handle(dm("0.01 every 4 hours 6 times", "dca"));
  open = await orders.openFor("7", 4663);
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
  assert.equal((await orders.openFor("7", 4663)).length, 2, "someone else's tap cancels nothing");
  await bot.handle(tap(cancels[0]!));
  open = await orders.openFor("7", 4663);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.kind, "dca");
  assert.equal((await orders.get(cancels[0]!.slice(3)))!.status, "cancelled");
  await bot.handle(tap(cancels[1]!));
  assert.match(telegram.last(), /no open orders/);
});

test("orders: an account keeps at most ten open; the eleventh is refused with the way out, and a cancel makes room", async () => {
  const { MAX_OPEN_ORDERS, MemoryOrderStore } = await import("../../src/fleet/bot-orders.js");
  const orders = new MemoryOrderStore();
  const { bot, telegram, links, session } = setup({ orders });
  await linked(links);
  for (let i = 0; i < MAX_OPEN_ORDERS; i++) await orders.put({ id: `o${i}`, tgId: "7", account: ACCOUNT, chainId: 4663, token: PEPE, kind: "limit", ethWei: parseEther("0.01"), triggerPerEth: 1n, createdAt: clock.toISOString(), status: "open", refusals: 0 });
  await bot.handle(tap(`lim:${PEPE}`));
  await bot.handle(dm("0.02 at 1200000", "limit buy"));
  assert.match(telegram.last(), /that is 10 open orders, the most one account keeps in the beta; cancel one from \u{1F4CB} Orders to set another\./u);
  assert.equal((await orders.openFor("7", 4663)).length, MAX_OPEN_ORDERS);
  assert.equal(session.calls.length, 0);
  // Orders on another chain, or closed ones, do not count against this account.
  await orders.put({ id: "t", tgId: "7", account: ACCOUNT, chainId: 46630, token: PEPE, kind: "limit", ethWei: parseEther("0.01"), triggerPerEth: 1n, createdAt: clock.toISOString(), status: "open", refusals: 0 });
  assert.equal(await orders.cancel("o0"), true);
  await bot.handle(tap(`dca:${PEPE}`));
  await bot.handle(dm("0.01 every 4 hours 6 times", "dca"));
  assert.match(telegram.last(), /set\. the bot checks every five minutes/);
  assert.equal((await orders.openFor("7", 4663)).length, MAX_OPEN_ORDERS);
});

test("the custom amount refusal says how to get the prompt back and offers it", async () => {
  const { bot, links, telegram, buttons, session } = setup();
  await linked(links);
  await bot.handle(tap("ask:" + PEPE));
  await bot.handle(dm("0,02", "how much"));
  assert.match(telegram.last(), /amount must be a number of ETH, like 0\.02\. tap Buy custom again to retry\./);
  assert.ok(buttons().includes(`ask:${PEPE}`));
  assert.equal(session.calls.length, 0);
});

test("a leader's mirrors are given what is left of the request's budget: after a slow receipt on the leader's own buy each mirror waits only for the rest, and once that is spent the others are skipped and told, the feed still posted and the leader still told", async () => {
  const { MIRRORS_UNTIL_MS } = await import("../../src/fleet/bot-session.js");
  const { MIRROR_SEND_MS } = await import("../../src/fleet/bot-copy.js");
  let t = clock;
  const { bot, links, telegram, session, posted } = withCopy({ now: () => t });
  await linked(links);
  await followerLinked(links);
  await links.putLink({ tgId: "9", account: "0x00000000000000000000000000000000000000cc", owner: OWNER, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });
  await bot.handle(asUser(7, "lead:acct", { username: "ogle" }));
  await bot.handle(asUser(8, "askf:7"));
  await bot.handle(says(8, "0.005", "how much"));
  await bot.handle(asUser(9, "askf:7"));
  await bot.handle(says(9, "0.005", "how much"));
  // The leader's receipt takes the full 40 s; the first mirror's own receipt is slow too.
  session.during(async (account) => { t = new Date(t.getTime() + (account === ACCOUNT ? 40_000 : 10_000)); });
  await bot.handle(tap(`b:${PEPE}:0.01`));
  assert.deepEqual(session.calls.map((c) => c.account), [ACCOUNT, FOLLOWER_ACCOUNT], "the leader, the first follower; the second was not started");
  assert.equal(session.calls[0]!.receiptWaitMs, undefined, "the leader's own buy waits the chain's default");
  assert.equal(session.calls[1]!.receiptWaitMs, MIRRORS_UNTIL_MS - 40_000 - MIRROR_SEND_MS, "the mirror waits only for what is left of the request after a send's own allowance");
  const toNine = telegram.sent.filter((o) => o.kind === "send" && o.chatId === "9").map((o) => (o as { text: string }).text);
  assert.match(toNine.at(-1)!, /skipped\. this run ran out of time before your turn; nothing was sent for you/);
  assert.equal(posted.length, 1, "the feed is posted inside the request, not lost to the host's cut-off");
  assert.match(posted[0]!.text, /mirrored into 1 of 2 follower accounts/);
  assert.match(telegram.last(), /mirrored to 1 of 2 followers, 1 skipped/);
  // A fast receipt on the leader's buy leaves the mirrors the desk's own thirty seconds, less the send's allowance.
  const quick = withCopy();
  await linked(quick.links);
  await followerLinked(quick.links);
  await quick.bot.handle(asUser(7, "lead:acct", { username: "ogle" }));
  await quick.bot.handle(asUser(8, "askf:7"));
  await quick.bot.handle(says(8, "0.005", "how much"));
  await quick.bot.handle(tap(`b:${PEPE}:0.01`));
  assert.equal(quick.session.calls[1]!.receiptWaitMs, 30_000 - MIRROR_SEND_MS);
});

test("a leader's dca fired by the orders' cron is neither posted nor mirrored, as the cards say: the runner has no desk", async () => {
  const { MemoryOrderStore, OrderRunner } = await import("../../src/fleet/bot-orders.js");
  const orders = new MemoryOrderStore();
  const { bot, links, session, telegram, posted, store } = withCopy({ orders });
  await linked(links);
  await followerLinked(links);
  await bot.handle(asUser(7, "lead:acct", { username: "ogle" }));
  await bot.handle(asUser(8, "askf:7"));
  await bot.handle(says(8, "0.005", "how much"));
  await bot.handle(tap(`dca:${PEPE}`));
  await bot.handle(dm("0.01 every 4 hours 2 times", "dca"));
  const runner = new OrderRunner({ orders, links, reads, session: session.s, telegram, now: () => clock });
  const before = telegram.sent.length;
  assert.deepEqual(await runner.run(), { fired: 1, landed: 1, refused: 0, waited: 0 });
  assert.deepEqual(session.calls.map((c) => c.account), [ACCOUNT], "the leader's own buy, nobody else's");
  assert.equal(posted.length, 0, "nothing to the feed");
  assert.deepEqual(await store.recent("7", 5), [], "no mirror, not even a skip");
  assert.deepEqual(telegram.sent.slice(before).map((o) => (o as { chatId: string }).chatId), ["7"], "one line to the owner; the follower hears nothing, because nothing of theirs happened");
});

// ---------- sells ----------

test("sell buttons are on the token card only when the account holds the token; the card's words say a sell is one call with the ETH back into the account", async () => {
  const empty = setup({ reads: { ...reads, async tokenBalance() { return 0n; } } as unknown as BotChain });
  await linked(empty.links);
  await empty.bot.handle(dm(PEPE));
  assert.ok(!empty.buttons().some((x) => x.startsWith("s:") || x.startsWith("asks:")), "nothing held, nothing to sell");
  const { bot, links, buttons, telegram } = setup();
  await linked(links);
  await bot.handle(dm(PEPE));
  const b = buttons();
  assert.deepEqual(b.filter((x) => x.startsWith("s:")), [`s:${PEPE}:25`, `s:${PEPE}:50`, `s:${PEPE}:100`]);
  assert.ok(b.includes(`asks:${PEPE}`), "Sell custom asks for a share");
  assert.match(telegram.last(), /a sell is one call on your account too, guarded at 3%, the ETH back into your account/);
  assert.ok(!/approv|permit2|allowance/i.test(telegram.last()), "no approval step to explain: the account approves inside the sale and clears it");
});

test("a sell without the owner's flag says what to do, with the Sessions page, and what the flag trusts the key with; nothing is sent", async () => {
  const { bot, links, session, telegram, buttons } = setup();
  await linked(links);
  await bot.handle(tap(`s:${PEPE}:50`));
  assert.match(telegram.last(), /your session does not allow sells yet\. on the Sessions page, next to the bot's key, turn on let it sell \(one transaction\), then try again\./);
  assert.match(telegram.last(), /the ETH landing there and nothing approved afterwards, but the pool and the floor are the key's, so the flag trusts the bot's key with the position, not only the caps/, "the flag is sold for what it is: complete when off, unbounded on price");
  assert.ok(buttons().includes("https://chit.tools/app/sessions.html"), "the Sessions page is the button");
  assert.equal(session.sales.length, 0, "no sale");
  assert.equal(session.calls.length, 0, "no execute either");
});

test("with the flag a tap is one sell on the account from the bot's key: the share in base units, the quote's floor, the venue pool, the ETH into the account; no approval before or after, no execute", async () => {
  const { bot, links, session, telegram, textAt } = setup();
  await linked(links);
  session.allowSell(true);
  await bot.handle(tap(`s:${PEPE}:50`));
  assert.match(textAt(-2), /selling <code>21 PEPE<\/code> \(50%\) from your account: about <code>0\.00002 ETH<\/code>, floor <code>0\.00002<\/code>/, "five places shown");
  assert.equal(session.sales.length, 1, "one sell");
  assert.equal(session.calls.length, 0, "a sale is not an execute: the account writes the router calldata itself");
  const { account, sale } = session.sales[0]!;
  assert.equal(account, ACCOUNT);
  assert.equal(sale.router, ROUTER);
  assert.equal(sale.token, PEPE);
  assert.equal(sale.amountIn, 21_000_000n, "half of 42 PEPE in six decimals");
  const quote = (21_000_000n * 10n ** 18n) / 1_000_000_000_000n;
  assert.equal(sale.minOut, minOutFor(quote, 300), "the floor is the quote less 3%");
  assert.equal(sale.deadline, BigInt(Math.floor(clock.getTime() / 1000) + 3600));
  assert.deepEqual(sale.poolKey, venuePoolKey(PEPE), "the venue's ETH pool for the token when the token has no hooked pool of its own");
  assert.match(telegram.last(), /landed\. <a href="https:\/\/robinhoodchain\.blockscout\.com\/tx\/0xcdcd.*the ETH is in your account/);
  await bot.handle(tap(`s:${PEPE}:100`));
  assert.equal(session.sales.length, 2, "the next sale is the same one call; nothing to approve first");
});

test("a hooked pool's own key goes into the sale", async () => {
  const hooked = { currency0: "0x0000000000000000000000000000000000000000" as Address, currency1: PEPE, fee: 10_000, tickSpacing: 200, hooks: "0x00000000000000000000000000000000000000ee" as Address };
  const { bot, links, session } = setup({ reads: { ...reads, async tokenInfo(token: Address) { return { address: token, symbol: "PEPE", decimals: 6, hasPool: true, perEth: 1_000_000_000_000n, poolEth: parseEther("5"), hooked: true, fee: 10_000, poolKey: hooked }; } } as unknown as BotChain });
  await linked(links);
  session.allowSell(true);
  await bot.handle(tap(`s:${PEPE}:25`));
  assert.equal(session.sales.length, 1);
  assert.deepEqual(session.sales[0]!.sale.poolKey, hooked);
});

test("a sale sent but not confirmed as landed is reported with its hash and the explorer, once", async () => {
  const { bot, links, session, telegram } = setup();
  await linked(links);
  session.allowSell(true);
  session.saleLands(false);
  await bot.handle(tap(`s:${PEPE}:25`));
  assert.equal(session.sales.length, 1);
  assert.match(telegram.last(), /sent, not confirmed as landed: <a href="https:\/\/robinhoodchain\.blockscout\.com\/tx\/0xcdcd.*the account's floor protects the fill/);
});

test("an update delivered twice is acted on once: the redelivery of a Sell callback sells nothing more and says nothing", async () => {
  // Three sales in a day at the sale's gas ceiling are past the default gas budget, which is not what this test is about.
  const { bot, links, session, telegram } = setup({ dailyGasWei: parseEther("1") });
  await linked(links);
  session.allowSell(true);
  await bot.handle(tap(`s:${PEPE}:50`, false, 1001));
  assert.equal(session.sales.length, 1);
  const said = telegram.sent.length;
  await bot.handle(tap(`s:${PEPE}:50`, false, 1001));
  assert.equal(session.sales.length, 1, "the same update id sells no second share");
  assert.equal(telegram.sent.length, said, "not even an answer to the callback: the first delivery had it");
  await bot.handle(tap(`s:${PEPE}:50`, false, 1002));
  assert.equal(session.sales.length, 2, "a new update id is a new tap");
  await bot.handle(tap(`s:${PEPE}:50`));
  assert.equal(session.sales.length, 3, "an update without an id (the dual bot's floor switch, a test) is not claimed");
});

test("the share is a whole percent of the position: 25% of 42 PEPE is 10.5, in the token's six decimals, with the sell floor; a share that is not a number sells nothing and says how to get the prompt back", async () => {
  const { bot, links, session, telegram, textAt, buttons } = setup();
  await linked(links);
  session.allowSell(true);
  await bot.handle(tap(`asks:${PEPE}`));
  assert.match(telegram.last(), /what share of your <code>0x.*to sell\? reply with a whole percent/);
  await bot.handle(dm("25", "what share"));
  assert.match(textAt(-2), /selling <code>10\.5 PEPE<\/code> \(25%\)/);
  const amountIn = 10_500_000n;
  const quote = (amountIn * 10n ** 18n) / 1_000_000_000_000n;
  assert.equal(session.sales[0]!.sale.amountIn, amountIn, "amountIn is the share in base units");
  assert.equal(session.sales[0]!.sale.minOut, minOutFor(quote, 300), "the floor is the quote less 3%");
  await bot.handle(tap(`asks:${PEPE}`));
  await bot.handle(dm("half", "what share"));
  assert.match(telegram.last(), /a whole percent of your position, 1 to 100, like 50\. tap Sell custom again to retry\./, "the refusal says how to get the prompt back");
  assert.ok(buttons().includes(`asks:${PEPE}`), "and offers it");
  assert.equal(session.sales.length, 1);
  await bot.handle(dm("50"));
  assert.match(telegram.last(), /<b>chit bot on mainnet<\/b>/, "a retyped share without the prompt sells nothing: the slot was spent");
  assert.equal(session.sales.length, 1);
  await bot.handle(tap(`asks:${PEPE}`));
  await bot.handle(dm("50", "what share"));
  assert.equal(session.sales.length, 2, "the offered button reopens the prompt and the share goes through");
});

test("a sell the contract refuses is quoted in its words, before any gas: a paused session, and a floor of zero in the contract's own check", async () => {
  const { bot, links, session, telegram } = setup();
  await linked(links);
  session.allowSell(true);
  session.refuseWith("session paused");
  await bot.handle(tap(`s:${PEPE}:100`));
  assert.match(telegram.last(), /your session says no: <b>session paused<\/b>/);
  assert.equal(session.sales.length, 0, "no sale on a refusal");
  assert.equal(session.calls.length, 0, "no execute on a refusal");
  // A quote of zero (a pool too thin to give anything for the share) is a floor of zero, which `sell` reverts with NoFloor; the bot says so first.
  session.refuseWith(null);
  const dust = setup({ reads: { ...reads, async quoteSell() { return 0n; } } as unknown as BotChain });
  await linked(dust.links);
  dust.session.allowSell(true);
  await dust.bot.handle(tap(`s:${PEPE}:1`));
  assert.match(dust.telegram.last(), /your session says no: <b>no floor<\/b>/);
  assert.equal(dust.session.sales.length, 0);
});

test("the daily execute and gas limits count sells with buys, a sale at its own gas ceiling", async () => {
  const { bot, links, session, telegram } = setup({ dailyExecutes: 2 });
  await linked(links);
  session.allowSell(true);
  await bot.handle(tap(`b:${PEPE}:0.01`));
  await bot.handle(tap(`s:${PEPE}:50`));
  assert.equal(session.calls.length + session.sales.length, 2);
  await bot.handle(tap(`s:${PEPE}:50`));
  assert.equal(session.sales.length, 1, "the third trade of the day is refused");
  assert.match(telegram.last(), /2 trades today/);
  // The gas budget: one sale is charged 1,000,000 gas at one gwei; a budget of that much is spent by one sale.
  const tight = setup({ dailyGasWei: 1_000_000n * 1_000_000_000n });
  await linked(tight.links);
  tight.session.allowSell(true);
  await tight.bot.handle(tap(`s:${PEPE}:50`));
  assert.equal(tight.session.sales.length, 1);
  await tight.bot.handle(tap(`s:${PEPE}:50`));
  assert.equal(tight.session.sales.length, 1, "the second sale is over the day's gas");
  assert.match(tight.telegram.last(), /fronted its daily gas/);
});

test("the wallet choice mints a nonce of this telegram's and sends the Sessions page's lead link with the name Telegram gave as a hint, without the @; the card says one signature, no transaction, what is copied and what never is", async () => {
  const { bot, buttons, links, telegram, copy } = withCopy();
  await linked(links);
  await bot.handle(asUser(7, "lead:wallet", { username: "ogle" }));
  assert.match(telegram.last(), /<b>lead from your own wallet<\/b>/);
  assert.match(telegram.last(), /press <b>Lead from this wallet<\/b>: one signature, no transaction, nothing moves\. the link is good for 15 minutes/);
  assert.match(telegram.last(), /every ETH buy that wallet makes on the venue is read from the chain within a few minutes, posted to the feed with the hash and mirrored into your followers' accounts, each inside their own caps and behind orus's read: a buy of 0.01 ETH or more through the token's own pool on the venue, up to 20 a day, for a token orus clears\. a smaller buy, one through another pool or a token orus will not clear is not posted or mirrored, and you are told why in private\. your taps in this bot, if you link an account too, and your sells are never mirrored/);
  assert.match(telegram.last(), /your sells are never mirrored, and the wallet's own trades are never touched\. close leader on your card stops the feed and the mirrors, any time/);
  const [href, back] = buttons();
  assert.ok(href!.startsWith("https://chit.tools/app/sessions.html?lead=") && /lead=[0-9a-f]{32}&handle=ogle$/.test(href!), href);
  assert.equal(back, "home");
  const nonce = href!.split("lead=")[1]!.split("&")[0]!;
  assert.equal((await links.getNonce(nonce))!.tgId, "7", "the nonce is this telegram's, in the link store");
  assert.equal(await copy.leader("7"), undefined, "nobody leads until the wallet signs");
  // No name from Telegram: no hint, the page asks.
  await bot.handle(asUser(7, "lead:wallet", { first_name: "@x" }));
  assert.match(buttons()[0]!, /lead=[0-9a-f]{32}$/);
});

test("a wallet leader's cards: the list marks them and says what is copied from a wallet, the card shows the wallet and the words for it, the follow confirmation too; the feed's door opens their card by the wallet", async () => {
  const { bot, buttons, links, telegram, copy } = withCopy();
  await linked(links);
  await followerLinked(links);
  const { privateKeyToAccount } = await import("viem/accounts");
  const { leadMessage } = await import("../../src/fleet/bot-copy.js");
  const whale = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const nonce = await copy.leadNonce("7");
  await copy.claimWallet("7", "whale", whale.address, await whale.signMessage({ message: leadMessage(4663, whale.address, nonce) }), nonce, 4663, clock);
  await bot.handle(dm("/start"));
  assert.ok(buttons().includes("lead:off"), "a wallet leader closes from the same button");
  await bot.handle(asUser(8, "leaders"));
  assert.match(telegram.last(), /one marked "trades from their own wallet" is copied from the chain instead: a buy of 0.01 ETH or more through the token's own pool on the venue, up to 20 a day, for a token orus clears\./);
  assert.match(telegram.last(), new RegExp(`<b>whale</b> · <code>${whale.address.slice(0, 6)}…${whale.address.slice(-4)}</code> · trades from their own wallet · 0 followers`));
  await bot.handle(asUser(8, "fl:7"));
  assert.match(telegram.last(), new RegExp(`wallet <code>${whale.address}</code> · trades from their own wallet · 0 followers`));
  assert.match(telegram.last(), /when that wallet buys a token with ETH on the venue \(a buy of 0.01 ETH or more through the token's own pool on the venue, up to 20 a day, for a token orus clears\), the same token is bought on your session account within a few minutes, sized to the smaller of their amount and your cap/);
  assert.match(telegram.last(), /they trade from their own wallet: a buy of 0.01 ETH or more through the token's own pool on the venue, up to 20 a day, for a token orus clears, is read from the chain within a few minutes of landing and mirrored; a smaller one, one through another pool or a token orus will not clear is not, and you are not messaged for it; their taps in this bot and their sells are never mirrored, so getting out of a mirrored position is yours alone/);
  assert.doesNotMatch(telegram.last(), /only a buy they tap in this bot/, "the account words are not on a wallet leader's card");
  assert.match(telegram.last(), /orus's read first/);
  await bot.handle(asUser(8, "askf:7"));
  await bot.handle(says(8, "0.02", "how much"));
  assert.match(telegram.last(), /following <b>whale<\/b> at <code>0.02 ETH<\/code> a buy\.\ntheir next ETH buy from their wallet on the venue \(a buy of 0.01 ETH or more through the token's own pool on the venue, up to 20 a day, for a token orus clears\) is mirrored on your account within a few minutes, inside your session's caps and behind orus's read; their taps in this bot and their sells are not, so the exit is yours/);
  await bot.handle(says(8, `/start f-${whale.address}`));
  assert.match(telegram.last(), /<b>follow whale<\/b>/, "the feed's door is the wallet they proved");
  await bot.handle(asUser(7, "lead:off"));
  assert.match(telegram.last(), /leader closed/);
  assert.equal(await copy.leader("7"), undefined);
});

/**
 * T082, FR-019: the free playground has its own host once the beta opens
 * (testnet.chit.tools), and the mainnet floor's door goes there. A room in
 * this bot is better than a link and wins when there is one; with neither
 * there is no door at all, because a button to a host that does not exist is
 * worse than no button.
 */
test("the door to the playground: the room in this bot when there is one, the testnet host when there is not, nothing when there is neither", async () => {
  const room = setup({ playgroundFloor: true, playgroundUrl: "https://testnet.chit.tools" });
  await room.bot.handle(dm("/start"));
  assert.ok(room.buttons().includes("floor:playground"), "a room in this bot is one tap and stays in the chat");
  assert.ok(!room.buttons().includes("https://testnet.chit.tools"), "and it is the only door offered");

  const host = setup({ playgroundUrl: "https://testnet.chit.tools" });
  await host.bot.handle(dm("/start"));
  assert.ok(host.buttons().includes("https://testnet.chit.tools"), "without a room, the door is the playground's own host");

  const neither = setup();
  await neither.bot.handle(dm("/start"));
  assert.ok(!neither.buttons().some((b) => /playground|testnet/i.test(b)), "no room and no host, no door");
});
