/**
 * The mainnet bot: no link, no trade; a link is a nonce and a signed
 * message; a buy asks the account first and is refused in its words; a buy
 * that passes is one execute from the bot's key with the bot's floor; the
 * daily limits stop a loop; a sell needs the owner's flag, approves once
 * (its own tap, with the honest words about what the approval is), then is
 * one execute with value zero; an update delivered twice is acted on once;
 * withdrawals are never offered.
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
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, encodeV4TokenSell, minOutFor } from "../../src/fleet/v4-swap.js";

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
  async quoteSell(token: Address, tokensIn: bigint) { return token === PEPE ? (tokensIn * 10n ** 18n) / 1_000_000_000_000n : null; },
} as unknown as BotChain;

const fakeSession = () => {
  const calls: { account: Address; target: Address; value: bigint; data: Hex }[] = [];
  let state = { exists: true, paused: false, revoked: false, expiry: Math.floor(clock.getTime() / 1000) + 86400, maxValuePerCall: parseEther("0.05").toString(), totalValueCap: parseEther("0.5").toString(), spentValue: "0", calls: 0 };
  let refuse: string | null = null;
  // The sell side: the owner's flag, the approval the account has (the first approveForSell puts it in place), and each approval sent.
  let sell = false, ready = false, approvalLands = true;
  const approvals: { account: Address; token: Address; spender: Address }[] = [];
  const s: SessionChain = {
    chainId: 4663, signer: SIGNER,
    async ownerOf(a) { return a.toLowerCase() === ACCOUNT ? OWNER : undefined; },
    async sessionOf() { return state; },
    async canExecute(_a, _t, _sel, value) { if (refuse) return { ok: false, why: refuse }; if (value > BigInt(state.maxValuePerCall)) return { ok: false, why: "over your per-trade cap" }; return { ok: true, why: "" }; },
    async execute(account, target, value, data) { calls.push({ account, target, value, data }); return { hash: ("0x" + "ab".repeat(32)) as Hex, landed: true }; },
    async signerBalance() { return parseEther("1"); },
    async sellAllowed() { return sell; },
    async approveForSell(account, token, spender) { approvals.push({ account, token, spender }); ready = approvalLands; return { hash: ("0x" + "cd".repeat(32)) as Hex, landed: approvalLands }; },
    async tokenAllowanceReady() { return ready; },
  };
  return { s, calls, approvals, set: (p: Partial<typeof state>) => { state = { ...state, ...p }; }, refuseWith: (why: string | null) => { refuse = why; }, allowSell: (v: boolean) => { sell = v; }, allowanceReady: (v: boolean) => { ready = v; }, approvalLands: (v: boolean) => { approvalLands = v; } };
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

// ---------- sells ----------

test("sell buttons are on the token card only when the account holds the token", async () => {
  const empty = setup({ reads: { ...reads, async tokenBalance() { return 0n; } } as unknown as BotChain });
  await linked(empty.links);
  await empty.bot.handle(dm(PEPE));
  assert.ok(!empty.buttons().some((x) => x.startsWith("s:") || x.startsWith("asks:")), "nothing held, nothing to sell");
  const { bot, links, buttons } = setup();
  await linked(links);
  await bot.handle(dm(PEPE));
  const b = buttons();
  assert.deepEqual(b.filter((x) => x.startsWith("s:")), [`s:${PEPE}:25`, `s:${PEPE}:50`, `s:${PEPE}:100`]);
  assert.ok(b.includes(`asks:${PEPE}`), "Sell custom asks for a share");
});

test("a sell without the owner's flag says what to do, with the Sessions page, what the approval will be and that only pause or revoke undoes it, and sends nothing", async () => {
  const { bot, links, session, telegram, buttons } = setup();
  await linked(links);
  await bot.handle(tap(`s:${PEPE}:50`));
  assert.match(telegram.last(), /your session does not allow sells yet\. on the Sessions page, next to the bot's key, turn on let it sell \(one transaction\), then try again\./);
  assert.match(telegram.last(), /approves it for the bot's key without a limit, and that approval stays until you pause or revoke the session; turning let it sell off later does not undo it/, "the flag is not sold as a reversible bound");
  assert.ok(buttons().includes("https://chit.tools/app/sessions.html"), "the Sessions page is the button");
  assert.equal(session.approvals.length, 0, "no approval");
  assert.equal(session.calls.length, 0, "no execute");
});

test("with the flag and no allowance the first tap approves the router once, says what the approval is, and offers the sale as the next tap; that tap sells as one execute with value zero; the next sale approves nothing", async () => {
  const { bot, links, session, telegram, textAt, buttons } = setup();
  await linked(links);
  session.allowSell(true);
  await bot.handle(tap(`s:${PEPE}:50`));
  assert.deepEqual(session.approvals, [{ account: ACCOUNT, token: PEPE, spender: ROUTER }]);
  assert.match(textAt(-2), /first sale of <b>PEPE<\/b> from your account: approving it for the router once\. the approval is your account's, without a limit, and stays until you pause or revoke the session; turning let it sell off does not undo it/);
  assert.match(telegram.last(), /approved: <a href="https:\/\/robinhoodchain\.blockscout\.com\/tx\/0xcdcd.*tap to sell 50% of your <b>PEPE<\/b> now/);
  assert.equal(session.calls.length, 0, "the approval is this request's one send; no sale yet");
  assert.equal(buttons()[0], `s:${PEPE}:50`, "the sale is the next tap, with the same share");
  await bot.handle(tap(`s:${PEPE}:50`));
  assert.equal(session.approvals.length, 1, "no second approval");
  assert.match(textAt(-2), /selling <code>21 PEPE<\/code> \(50%\) from your account/);
  assert.equal(session.calls.length, 1, "one execute");
  assert.equal(session.calls[0]!.account, ACCOUNT);
  assert.equal(session.calls[0]!.target, ROUTER);
  assert.equal(session.calls[0]!.value, 0n, "a sale spends no ETH, so the caps are untouched");
  assert.ok(session.calls[0]!.data.startsWith(UNIVERSAL_ROUTER_EXECUTE_SELECTOR));
  assert.match(telegram.last(), /landed\. <a href="https:\/\/robinhoodchain\.blockscout\.com\/tx\/0xabab.*the ETH is in your account/);
  await bot.handle(tap(`s:${PEPE}:100`));
  assert.equal(session.approvals.length, 1, "the allowance is in place, no second approval");
  assert.equal(session.calls.length, 2);
});

test("an approval not confirmed as landed is reported with its hash, sells nothing, and leaves the sale to a tap after the explorer", async () => {
  const { bot, links, session, telegram, buttons } = setup();
  await linked(links);
  session.allowSell(true);
  session.approvalLands(false);
  await bot.handle(tap(`s:${PEPE}:25`));
  assert.equal(session.approvals.length, 1);
  assert.match(telegram.last(), /the approval is sent, not confirmed as landed: <a href="https:\/\/robinhoodchain\.blockscout\.com\/tx\/0xcdcd.*nothing was sold; check the explorer, then tap Sell again/);
  assert.equal(session.calls.length, 0, "no sale on an unconfirmed approval");
  assert.equal(buttons()[0], `s:${PEPE}:25`);
});

test("an update delivered twice is acted on once: the redelivery of a Sell callback sells nothing more and says nothing", async () => {
  const { bot, links, session, telegram } = setup();
  await linked(links);
  session.allowSell(true);
  session.allowanceReady(true);
  await bot.handle(tap(`s:${PEPE}:50`, false, 1001));
  assert.equal(session.calls.length, 1);
  const said = telegram.sent.length;
  await bot.handle(tap(`s:${PEPE}:50`, false, 1001));
  assert.equal(session.calls.length, 1, "the same update id sells no second share");
  assert.equal(telegram.sent.length, said, "not even an answer to the callback: the first delivery had it");
  await bot.handle(tap(`s:${PEPE}:50`, false, 1002));
  assert.equal(session.calls.length, 2, "a new update id is a new tap");
  await bot.handle(tap(`s:${PEPE}:50`));
  assert.equal(session.calls.length, 3, "an update without an id (the dual bot's floor switch, a test) is not claimed");
});

test("the share is a whole percent of the position: 25% of 42 PEPE is 10.5, in the token's six decimals, with the sell floor", async () => {
  const { bot, links, session, telegram, textAt } = setup();
  await linked(links);
  session.allowSell(true);
  session.allowanceReady(true);
  await bot.handle(tap(`asks:${PEPE}`));
  assert.match(telegram.last(), /what share of your <code>0x.*to sell\? reply with a whole percent/);
  await bot.handle(dm("25", "what share"));
  assert.match(textAt(-2), /selling <code>10\.5 PEPE<\/code> \(25%\)/);
  const amountIn = 10_500_000n;
  const quote = (amountIn * 10n ** 18n) / 1_000_000_000_000n;
  const expected = encodeV4TokenSell({ token: PEPE, amountIn, minOut: minOutFor(quote, 300), deadline: BigInt(Math.floor(clock.getTime() / 1000) + 3600) });
  assert.equal(session.calls[0]!.data, expected, "amountIn is the share in base units; the floor is the quote less 3%");
  await bot.handle(tap(`asks:${PEPE}`));
  await bot.handle(dm("half", "what share"));
  assert.match(telegram.last(), /a whole percent of your position, 1 to 100/);
  assert.equal(session.calls.length, 1, "a share that is not a number sells nothing");
});

test("a sell the contract refuses is quoted in its words, before any approval or gas", async () => {
  const { bot, links, session, telegram } = setup();
  await linked(links);
  session.allowSell(true);
  session.refuseWith("session paused");
  await bot.handle(tap(`s:${PEPE}:100`));
  assert.match(telegram.last(), /your session says no: <b>session paused<\/b>/);
  assert.equal(session.approvals.length, 0, "no approval on a refusal");
  assert.equal(session.calls.length, 0, "no execute on a refusal");
});

test("the daily execute limit counts sells with buys", async () => {
  const { bot, links, session, telegram } = setup({ dailyExecutes: 2 });
  await linked(links);
  session.allowSell(true);
  session.allowanceReady(true);
  await bot.handle(tap(`b:${PEPE}:0.01`));
  await bot.handle(tap(`s:${PEPE}:50`));
  assert.equal(session.calls.length, 2);
  await bot.handle(tap(`s:${PEPE}:50`));
  assert.equal(session.calls.length, 2, "the third trade of the day is refused");
  assert.match(telegram.last(), /2 trades today/);
});
