/**
 * The copy desk: a leader needs a link and a name that cannot pass for
 * someone else's; a follow needs an open leader and a cap inside the
 * bounds; a mirror is gated by orus (a honeypot, no read, or no scanner at
 * all skips everyone, with the reason), by the aggregate cap per token per
 * day, by each follower's own session (its refusal quoted) and their own
 * daily allowance from the bot; it is sized to the smaller of the leader's
 * amount and the cap, runs in the fixed order inside a time budget, keeps
 * going past one follower's failed send, and logs every outcome; the feed
 * gets one message per landed buy, after the mirrors, with the two doors
 * into the bot, and nothing for a closed leader or without a feed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex, parseEther } from "viem";
import type { BotChain, TokenInfo } from "../../src/fleet/bot-chain.js";
import { CopyDesk, MAX_FOLLOW_CAP_WEI, MemoryCopyStore } from "../../src/fleet/bot-copy.js";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import type { OrusScan } from "../../src/fleet/bot-orus.js";
import type { SessionChain } from "../../src/fleet/bot-session-chain.js";
import type { Keyboard } from "../../src/fleet/bot-telegram.js";

const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
const OWNER = "0x0000000000000000000000000000000000000011" as Address;
const HASH = ("0x" + "ab".repeat(32)) as Hex;
const acct = (n: number): Address => ("0x" + n.toString(16).padStart(40, "0")) as Address;
const clock = new Date("2026-09-20T12:00:00Z");

const info: TokenInfo = { address: PEPE, symbol: "PEPE", decimals: 6, hasPool: true, perEth: 1_000_000_000_000n, poolEth: parseEther("5"), hooked: false, fee: 3000 };
const reads = {
  chainId: 4663, router: ROUTER,
  async tokenInfo(token: Address) { return { ...info, address: token, hasPool: token === PEPE }; },
  async quoteBuy(_token: Address, ethIn: bigint) { return (ethIn * 1_000_000_000_000n) / 10n ** 18n; },
} as unknown as BotChain;
const safe: OrusScan = { symbol: "PEPE", honeypot: false, buyTaxPct: 0, sellTaxPct: 0, bundlersPct: null, top10Pct: null, holders: 100, liquidityUsd: 50_000, lpBurnedPct: null, marketCapUsd: null, deployerLaunches: 1, checkedAt: clock.toISOString() };

const setup = (opts: { orus?: OrusScan | null | "off"; tokenDayCapWei?: bigint; mirrorBudgetMs?: number; feed?: boolean } = {}) => {
  const store = new MemoryCopyStore();
  const links = new MemoryBotLinkStore();
  const calls: { account: Address; value: bigint }[] = [];
  const told: { to: string; text: string }[] = [];
  const posted: { text: string; keyboard: Keyboard }[] = [];
  let refuse: ((account: Address) => string | null) = () => null;
  let failSend: ((account: Address) => boolean) = () => false;
  let t = clock;
  const session: SessionChain = {
    chainId: 4663, signer: acct(0xb0),
    async ownerOf() { return OWNER; },
    async sessionOf() { throw new Error("not read here"); },
    async canExecute(account) { const why = refuse(account); return why ? { ok: false, why } : { ok: true, why: "" }; },
    async execute(account, _t, value) { if (failSend(account)) throw new Error("nonce too low"); calls.push({ account, value }); return { hash: HASH, landed: true }; },
    async signerBalance() { return parseEther("1"); },
  };
  const answer: OrusScan | undefined = opts.orus === null || opts.orus === "off" ? undefined : opts.orus ?? safe;
  const orus = opts.orus === "off" ? undefined : { scan: async () => answer, link: (t: Address) => `https://www.orusagent.xyz/token/${t}` };
  const desk = new CopyDesk({
    store, links, reads, session, now: () => t,
    ...(orus ? { orus } : {}),
    ...(opts.tokenDayCapWei !== undefined ? { tokenDayCapWei: opts.tokenDayCapWei } : {}),
    ...(opts.mirrorBudgetMs !== undefined ? { mirrorBudgetMs: opts.mirrorBudgetMs } : {}),
    tell: async (to, text) => { told.push({ to, text }); },
    botUsername: "usechit_bot",
    ...(opts.feed === false ? {} : { feed: { chatId: "-100", post: async (text, keyboard) => { posted.push({ text, keyboard }); } } }),
  });
  const link = (tgId: string, n: number) => links.putLink({ tgId, account: acct(n), owner: OWNER, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });
  return { desk, store, links, link, calls, told, posted, refuseWith: (f: typeof refuse) => { refuse = f; }, failSendFor: (f: typeof failSend) => { failSend = f; }, advance: (ms: number) => { t = new Date(t.getTime() + ms); } };
};

test("become leader needs a link; the leader's account is the linked one; close hides them from the list and from leader()", async () => {
  const { desk, link } = setup();
  await assert.rejects(desk.becomeLeader("1", "@ogle"), /link your account first/);
  await link("1", 1);
  const l = await desk.becomeLeader("1", "@ogle");
  assert.equal(l.account, acct(1));
  assert.deepEqual((await desk.leaders()).map((x) => x.tgId), ["1"]);
  await desk.closeLeader("1");
  assert.deepEqual(await desk.leaders(), []);
  assert.equal(await desk.leader("1"), undefined);
});

test("a handle is the Telegram @ form or a plain name: markup, the project's name, a leading space are refused; a name another open leader has is refused whatever its case; a closed leader's name is free again", async () => {
  const { desk, link } = setup();
  await link("1", 1);
  await link("2", 2);
  await assert.rejects(desk.becomeLeader("1", "<b>x</b>"), /that name will not do/);
  await assert.rejects(desk.becomeLeader("1", "@lu cian"), /that name will not do/, "the @ form is Telegram's own shape or nothing");
  await assert.rejects(desk.becomeLeader("1", "chit team"), /that name will not do/);
  await assert.rejects(desk.becomeLeader("1", "Official Support"), /that name will not do/);
  await assert.rejects(desk.becomeLeader("1", " lucian"), /that name will not do/);
  assert.equal((await desk.becomeLeader("1", "@ogle")).handle, "@ogle", "the @ form is accepted when the cards pass Telegram's username in");
  assert.equal((await desk.becomeLeader("1", "lucian b.")).handle, "lucian b.", "a leader may rename themselves");
  await assert.rejects(desk.becomeLeader("2", "Lucian B."), /already on the leaders list/);
  await desk.closeLeader("1");
  assert.equal((await desk.becomeLeader("2", "Lucian B.")).handle, "Lucian B.", "closed leaders are off the list, so the name is free");
});

test("follow needs a linked follower, an open leader, a cap inside the bounds, and someone other than yourself", async () => {
  const { desk, link } = setup();
  await link("1", 1);
  await desk.becomeLeader("1", "@ogle");
  await assert.rejects(desk.follow("2", "1", parseEther("0.01")), /link your account first/);
  await link("2", 2);
  await assert.rejects(desk.follow("2", "3", parseEther("0.01")), /not open to followers/);
  await assert.rejects(desk.follow("2", "1", 0n), /cap must be between/);
  await assert.rejects(desk.follow("2", "1", MAX_FOLLOW_CAP_WEI + 1n), /cap must be between 1 wei and 1 ETH/);
  await assert.rejects(desk.follow("1", "1", parseEther("0.01")), /cannot follow yourself/);
  const f = await desk.follow("2", "1", parseEther("0.01"));
  assert.equal(f.capWei, parseEther("0.01"));
  await desk.closeLeader("1");
  await assert.rejects(desk.follow("2", "1", parseEther("0.01")), /not open to followers/, "a closed leader takes no new followers");
});

const leaderWithFollowers = async (s: ReturnType<typeof setup>, caps: string[]) => {
  await s.link("1", 1);
  await s.desk.becomeLeader("1", "@ogle");
  for (const [i, cap] of caps.entries()) { await s.link(String(i + 2), i + 2); await s.desk.follow(String(i + 2), "1", parseEther(cap)); }
};

test("mirror: orus says honeypot, or has no read at all, and every follower is skipped with the reason, nothing executed, everyone told", async () => {
  const hp = setup({ orus: { ...safe, honeypot: true } });
  await leaderWithFollowers(hp, ["0.01", "0.02"]);
  let out = await hp.desk.mirror("1", PEPE, parseEther("0.05"));
  assert.deepEqual(out.map((m) => [m.followerTgId, m.outcome, m.why]), [["2", "skipped", "orus says honeypot"], ["3", "skipped", "orus says honeypot"]]);
  assert.equal(hp.calls.length, 0);
  assert.deepEqual(hp.told.map((t) => t.to), ["2", "3"]);
  assert.match(hp.told[0]!.text, /skipped\. orus says honeypot/);
  const none = setup({ orus: null });
  await leaderWithFollowers(none, ["0.01"]);
  out = await none.desk.mirror("1", PEPE, parseEther("0.05"));
  assert.deepEqual(out.map((m) => m.why), ["orus had no read; unknown is not safe"]);
  assert.equal(none.calls.length, 0);
  const unsure = setup({ orus: { ...safe, honeypot: null } });
  await leaderWithFollowers(unsure, ["0.01"]);
  out = await unsure.desk.mirror("1", PEPE, parseEther("0.05"));
  assert.deepEqual(out.map((m) => m.why), ["orus could not rule out a honeypot"], "unknown is not safe");
});

test("mirror: with no orus scanner wired at all every follower is skipped and told, nothing executed: the card's promise holds whatever the deployment has", async () => {
  const s = setup({ orus: "off" });
  await leaderWithFollowers(s, ["0.01", "0.02"]);
  const out = await s.desk.mirror("1", PEPE, parseEther("0.05"));
  assert.deepEqual(out.map((m) => [m.outcome, m.why]), [["skipped", "orus is not wired into this bot; unknown is not safe"], ["skipped", "orus is not wired into this bot; unknown is not safe"]]);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.told.map((t) => t.to), ["2", "3"]);
});

test("mirror: one follower's send that throws is that follower's skip, with the day's room given back, and the next follower runs", async () => {
  const s = setup({ tokenDayCapWei: parseEther("0.02") });
  await leaderWithFollowers(s, ["0.01", "0.01", "0.01"]);
  s.failSendFor((a) => a === acct(2));
  const out = await s.desk.mirror("1", PEPE, parseEther("0.05"));
  assert.deepEqual(out.map((m) => [m.followerTgId, m.outcome, m.why]), [["2", "skipped", "the send failed on our side; nothing was spent for you"], ["3", "landed", ""], ["4", "landed", ""]]);
  assert.deepEqual(s.calls.map((c) => c.account), [acct(3), acct(4)], "the failed send left its 0.01 of the 0.02 cap to the third follower");
  assert.match(s.told[0]!.text, /skipped\. the send failed on our side/);
  assert.equal((await s.store.recent("1", 3)).length, 3, "the failure is in the log like any outcome");
});

test("mirror: the follower's own daily allowance is charged per execute, last of the checks, and its refusal is the skip's reason", async () => {
  const s = setup({ tokenDayCapWei: parseEther("0.02") });
  await leaderWithFollowers(s, ["0.01", "0.01", "0.01"]);
  const charged: string[] = [];
  const budget = (tgId: string) => { if (tgId === "3") return "that is 200 buys today from your account; again tomorrow"; charged.push(tgId); return null; };
  s.refuseWith((a) => (a === acct(4) ? "session paused" : null));
  const out = await s.desk.mirror("1", PEPE, parseEther("0.05"), { budget });
  assert.deepEqual(out.map((m) => [m.followerTgId, m.outcome, m.why]), [["2", "landed", ""], ["3", "skipped", "that is 200 buys today from your account; again tomorrow"], ["4", "skipped", "your session says no: session paused"]]);
  assert.deepEqual(charged, ["2"], "only the follower whose execute ran was charged; a skip for another reason costs nothing");
  assert.deepEqual(s.calls.map((c) => c.account), [acct(2)]);
  assert.equal(await s.store.addTokenDay(clock.toISOString().slice(0, 10), PEPE, 0n), parseEther("0.01"), "the refused follower's amount was given back to the day");
});

test("mirror: once the time budget is spent no more sends are started and the rest are skipped and told", async () => {
  const s = setup({ mirrorBudgetMs: 1_000 });
  await leaderWithFollowers(s, ["0.01", "0.01", "0.01"]);
  let n = 0;
  s.failSendFor(() => { if (++n === 1) s.advance(5_000); return false; });
  const out = await s.desk.mirror("1", PEPE, parseEther("0.05"));
  assert.deepEqual(out.map((m) => [m.followerTgId, m.outcome, m.why]), [["2", "landed", ""], ["3", "skipped", "this run ran out of time before your turn; nothing was sent for you"], ["4", "skipped", "this run ran out of time before your turn; nothing was sent for you"]]);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.told.map((t) => t.to), ["2", "3", "4"], "everyone is told, the ones not reached too");
});

test("mirror: sized to the smaller of the leader's amount and the cap, in the order they followed, and only for an open leader", async () => {
  const s = setup();
  await leaderWithFollowers(s, ["0.01", "0.5"]);
  const out = await s.desk.mirror("1", PEPE, parseEther("0.05"));
  assert.deepEqual(out.map((m) => [m.followerTgId, m.outcome, m.ethWei]), [["2", "landed", parseEther("0.01")], ["3", "landed", parseEther("0.05")]]);
  assert.deepEqual(s.calls, [{ account: acct(2), value: parseEther("0.01") }, { account: acct(3), value: parseEther("0.05") }], "fixed order: who followed first goes first");
  assert.match(s.told[0]!.text, /copied <b>@ogle<\/b>: <code>0.01 ETH<\/code> into/);
  await s.desk.closeLeader("1");
  assert.deepEqual(await s.desk.mirror("1", PEPE, parseEther("0.05")), [], "closed: nothing is mirrored");
  assert.equal(s.calls.length, 2);
});

test("mirror: the per-token daily cap across all followers stops the second follower, and the refused amount is not counted", async () => {
  const s = setup({ tokenDayCapWei: parseEther("0.06") });
  await leaderWithFollowers(s, ["0.05", "0.05", "0.01"]);
  const out = await s.desk.mirror("1", PEPE, parseEther("0.05"));
  assert.deepEqual(out.map((m) => m.outcome), ["landed", "skipped", "landed"]);
  assert.match(out[1]!.why, /today's cap into this token across all followers \(0.06 ETH\) is reached/);
  assert.deepEqual(s.calls.map((c) => c.value), [parseEther("0.05"), parseEther("0.01")], "the skipped 0.05 left room for the 0.01");
});

test("mirror: a follower's session refusal is quoted in the contract's words, nothing executed for them, the others go on", async () => {
  const s = setup();
  await leaderWithFollowers(s, ["0.01", "0.01"]);
  s.refuseWith((a) => (a === acct(2) ? "session paused" : null));
  const out = await s.desk.mirror("1", PEPE, parseEther("0.05"));
  assert.deepEqual(out.map((m) => [m.outcome, m.why]), [["skipped", "your session says no: session paused"], ["landed", ""]]);
  assert.deepEqual(s.calls.map((c) => c.account), [acct(3)]);
});

test("the log has every outcome, hash included, newest first", async () => {
  const s = setup({ tokenDayCapWei: parseEther("0.015") });
  await leaderWithFollowers(s, ["0.01", "0.01"]);
  await s.desk.mirror("1", PEPE, parseEther("0.05"));
  const recent = await s.store.recent("1", 10);
  assert.deepEqual(recent.map((m) => [m.followerTgId, m.outcome, m.hash]), [["3", "skipped", null], ["2", "landed", HASH]]);
  assert.equal(recent[1]!.leaderTgId, "1");
  assert.equal(recent[1]!.token, PEPE);
});

test("announce: one message to the feed with the handle, the amount, the token, the hash and the partners' lines, and two url doors into the bot; nothing without a feed or for a closed leader", async () => {
  const s = setup();
  await s.link("1", 1);
  await s.desk.becomeLeader("1", "@ogle");
  const hey = { statusLabel: "Shipping", verifiedBuilder: true, commits30d: 12, releases30d: 2, ships30d: null, lastShip: null, projectName: "pepe", url: "https://heyresearch.xyz/p/pepe" };
  assert.equal(await s.desk.announce("1", PEPE, parseEther("0.05"), HASH, info, safe, hey), true);
  assert.equal(s.posted.length, 1, "one message");
  const [m] = s.posted;
  assert.match(m!.text, /^<b>@ogle<\/b> bought <code>0.05 ETH<\/code> of <b>PEPE<\/b> · <a href="https:\/\/robinhoodchain\.blockscout\.com\/tx\/0xabab[0-9a-f]+">0xabababab…<\/a>\n/);
  assert.match(m!.text, /\norus: no honeypot · .*checked by orus/);
  assert.match(m!.text, /\nhey research lab: shipping · 12 commits · 2 releases · verified builder · <a href="https:\/\/heyresearch\.xyz\/p\/pepe">see on HEY<\/a>$/);
  assert.deepEqual(m!.keyboard, [[{ text: "buy this", url: `https://t.me/usechit_bot?start=t-${PEPE}` }, { text: "follow @ogle", url: "https://t.me/usechit_bot?start=f-1" }]]);
  assert.equal(await s.desk.announce("2", PEPE, parseEther("0.05"), HASH, info, safe, undefined), false, "not a leader: nothing");
  await s.desk.closeLeader("1");
  assert.equal(await s.desk.announce("1", PEPE, parseEther("0.05"), HASH, info, safe, undefined), false, "closed: nothing");
  assert.equal(s.posted.length, 1);
  const quiet = setup({ feed: false });
  await quiet.link("1", 1);
  await quiet.desk.becomeLeader("1", "@ogle");
  assert.equal(await quiet.desk.announce("1", PEPE, parseEther("0.05"), HASH, info, safe, undefined), false, "no feed: nothing, no error");
});

test("announce: a handle is escaped even when the store holds markup, and without an orus scanner the orus line is not drawn", async () => {
  const s = setup({ orus: "off" });
  await s.link("1", 1);
  // The desk refuses such a name; a row written some other way is still drawn safely.
  await s.store.putLeader({ tgId: "1", account: acct(1), handle: "<b>x</b>", since: clock.toISOString(), open: true });
  await s.desk.announce("1", PEPE, parseEther("0.01"), HASH, info, undefined, undefined);
  assert.match(s.posted[0]!.text, /^<b>&lt;b&gt;x&lt;\/b&gt;<\/b> bought/);
  assert.equal(s.posted[0]!.text.split("\n").length, 1);
});

test("announce: given the mirrors it says how many follower accounts the buy reached, so the feed reports what landed rather than what is about to", async () => {
  const s = setup();
  await leaderWithFollowers(s, ["0.01", "0.01"]);
  s.refuseWith((a) => (a === acct(3) ? "session paused" : null));
  const mirrors = await s.desk.mirror("1", PEPE, parseEther("0.05"));
  await s.desk.announce("1", PEPE, parseEther("0.05"), HASH, info, safe, undefined, mirrors);
  assert.match(s.posted[0]!.text, /\nmirrored into 1 of 2 follower accounts, already landed or sent$/);
});
