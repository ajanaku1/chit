/**
 * The copy desk: a leader needs a link and a name that cannot pass for
 * someone else's; a follow needs an open leader and a cap inside the
 * bounds; a mirror is gated by orus (a honeypot, no read, or no scanner at
 * all skips everyone, with the reason), by the aggregate cap per token per
 * day, by each follower's own session (its refusal quoted) and their own
 * daily allowance from the bot; it is sized to the smaller of the leader's
 * amount and the cap, runs in the fixed order inside a time budget, keeps
 * going past one follower's failed send, and logs every outcome; the time
 * budget bounds the receipts too, from the request's cut-off when the
 * session bot hands one in; the feed gets one message per landed buy,
 * after the mirrors, with the two doors into the bot (the follow door by
 * the leader's account, never their Telegram id), and nothing for a closed
 * leader or without a feed. A wallet leader's claim needs a fresh nonce
 * and the wallet's own signature (a stranger's is refused, a nonce is one
 * claim, a wallet is one leader's), and a venue buy by a claimed open
 * leader's wallet is mirrored and announced like a bot buy, told to the
 * leader, once per hash, claimed in the store before the first send so two
 * instances cannot both mirror it; anyone else's is ignored, and so is
 * dust, a buy through a pool that is not the token's, a day already full,
 * while a token orus will not clear is neither posted nor mirrored and only
 * the leader hears. A read that fails before the claim keeps the buy for the
 * next pass (read again, mirrored late or dropped after the window, the
 * leader told either way) and each step after the claim is caught, so a
 * failure loses nothing that was not already told. A mirror of either path
 * goes only through a pool on the bot's record; a token whose pool was
 * discovered is skipped with the reason and, on the venue path, not posted.
 * The followers' daily allowance is one ledger for taps and both paths'
 * mirrors.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { BotChain, TokenInfo } from "../../src/fleet/bot-chain.js";
import { CopyDesk, LeadError, MAX_FOLLOW_CAP_WEI, MIRROR_SEND_MS, MemoryCopyStore, NeonCopyStore, VENUE_BUYS_PER_DAY, VENUE_MIN_ETH_WEI, VENUE_RETRY_MS, leadMessage, type CopySql, type VenueBuy } from "../../src/fleet/bot-copy.js";
import { MemoryBotLinkStore, NONCE_TTL_MS } from "../../src/fleet/bot-link.js";
import type { OrusScan } from "../../src/fleet/bot-orus.js";
import type { SessionChain } from "../../src/fleet/bot-session-chain.js";
import type { Keyboard } from "../../src/fleet/bot-telegram.js";
import { poolIdOf } from "../../src/fleet/pool-registry.js";
import { venuePoolKey } from "../../src/fleet/v4-swap.js";

const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
const OWNER = "0x0000000000000000000000000000000000000011" as Address;
const HASH = ("0x" + "ab".repeat(32)) as Hex;
const acct = (n: number): Address => ("0x" + n.toString(16).padStart(40, "0")) as Address;
const clock = new Date("2026-09-20T12:00:00Z");

/** PEPE's pool is on the bot's record, as $CHIT's is on mainnet: the only kind a mirror goes through. */
const info: TokenInfo = { address: PEPE, symbol: "PEPE", decimals: 6, hasPool: true, perEth: 1_000_000_000_000n, poolEth: parseEther("5"), hooked: false, fee: 3000, poolOnRecord: true };
const reads = {
  chainId: 4663, router: ROUTER,
  async tokenInfo(token: Address) { return { ...info, address: token, hasPool: token === PEPE }; },
  async quoteBuy(_token: Address, ethIn: bigint) { return (ethIn * 1_000_000_000_000n) / 10n ** 18n; },
} as unknown as BotChain;
const safe: OrusScan = { symbol: "PEPE", honeypot: false, buyTaxPct: 0, sellTaxPct: 0, bundlersPct: null, top10Pct: null, holders: 100, liquidityUsd: 50_000, lpBurnedPct: null, marketCapUsd: null, deployerLaunches: 1, checkedAt: clock.toISOString() };

const setup = (opts: { orus?: OrusScan | null | "off"; tokenDayCapWei?: bigint; mirrorBudgetMs?: number; feed?: boolean; dailyExecutes?: number; venueMinEthWei?: bigint; venueBuysPerDay?: number; venueRetryMs?: number; store?: MemoryCopyStore; links?: MemoryBotLinkStore } = {}) => {
  const store = opts.store ?? new MemoryCopyStore();
  const links = opts.links ?? new MemoryBotLinkStore();
  /** Faults the test switches on: the chain read, the log line, the feed and the wallet leader's line each throw once when armed. */
  const faults = { tokenInfo: false, log: false, feed: false, tell: false };
  const once = (k: keyof typeof faults, why: string) => { if (faults[k]) { faults[k] = false; throw new Error(why); } };
  const chain = { ...reads, async tokenInfo(token: Address) { once("tokenInfo", "rpc timed out"); return reads.tokenInfo(token); } } as unknown as BotChain;
  const storeLog = store.log.bind(store);
  store.log = async (m) => { once("log", "store is away"); await storeLog(m); };
  const calls: { account: Address; value: bigint }[] = [];
  /** The receipt wait each execute was given, in the order of the sends. */
  const waits: (number | undefined)[] = [];
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
    async execute(account, _t, value, _data, receiptWaitMs) { if (failSend(account)) throw new Error("nonce too low"); calls.push({ account, value }); waits.push(receiptWaitMs); return { hash: HASH, landed: true }; },
    async signerBalance() { return parseEther("1"); },
    // The desk mirrors buys only; the sell side is never asked here.
    async sellAllowed() { return false; },
    async canSell() { return { ok: false, why: "sell not allowed" }; },
    async sell() { throw new Error("not sold here"); },
  };
  const answer: OrusScan | undefined = opts.orus === null || opts.orus === "off" ? undefined : opts.orus ?? safe;
  const orus = opts.orus === "off" ? undefined : { scan: async () => answer, link: (t: Address) => `https://www.orusagent.xyz/token/${t}` };
  const desk = new CopyDesk({
    store, links, reads: chain, session, now: () => t,
    ...(orus ? { orus } : {}),
    ...(opts.tokenDayCapWei !== undefined ? { tokenDayCapWei: opts.tokenDayCapWei } : {}),
    ...(opts.mirrorBudgetMs !== undefined ? { mirrorBudgetMs: opts.mirrorBudgetMs } : {}),
    ...(opts.dailyExecutes !== undefined ? { dailyExecutes: opts.dailyExecutes } : {}),
    ...(opts.venueMinEthWei !== undefined ? { venueMinEthWei: opts.venueMinEthWei } : {}),
    ...(opts.venueBuysPerDay !== undefined ? { venueBuysPerDay: opts.venueBuysPerDay } : {}),
    ...(opts.venueRetryMs !== undefined ? { venueRetryMs: opts.venueRetryMs } : {}),
    tell: async (to, text) => { if (to === "9") once("tell", "telegram 429"); told.push({ to, text }); },
    botUsername: "usechit_bot",
    ...(opts.feed === false ? {} : { feed: { chatId: "-100", post: async (text, keyboard) => { once("feed", "telegram 429"); posted.push({ text, keyboard }); } } }),
  });
  const link = (tgId: string, n: number) => links.putLink({ tgId, account: acct(n), owner: OWNER, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });
  return { desk, store, links, link, calls, waits, told, posted, faults, refuseWith: (f: typeof refuse) => { refuse = f; }, failSendFor: (f: typeof failSend) => { failSend = f; }, advance: (ms: number) => { t = new Date(t.getTime() + ms); } };
};

test("become leader needs a link; the leader's account is the linked one; close hides them from the list and from leader()", async () => {
  const { desk, link } = setup();
  await assert.rejects(desk.becomeLeader("1", "@ogle"), /link your account first/);
  await link("1", 1);
  const l = await desk.becomeLeader("1", "@ogle");
  assert.equal(l.account, acct(1));
  assert.deepEqual((await desk.leaders()).map((x) => x.tgId), ["1"]);
  assert.equal((await desk.leaderAt(acct(1)))!.tgId, "1", "the feed's follow door finds the leader by account");
  assert.equal(await desk.leaderAt(acct(2)), undefined);
  await desk.closeLeader("1");
  assert.deepEqual(await desk.leaders(), []);
  assert.equal(await desk.leader("1"), undefined);
  assert.equal(await desk.leaderAt(acct(1)), undefined, "closed: no door");
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

test("mirror: once the time budget is spent no more sends are started and the rest are skipped and told; each send waits for its receipt only with what is left after the send's own allowance", async () => {
  const s = setup({ mirrorBudgetMs: 10_000 });
  await leaderWithFollowers(s, ["0.01", "0.01", "0.01"]);
  let n = 0;
  s.failSendFor(() => { if (++n === 1) s.advance(15_000); return false; });
  const out = await s.desk.mirror("1", PEPE, parseEther("0.05"));
  assert.deepEqual(out.map((m) => [m.followerTgId, m.outcome, m.why]), [["2", "landed", ""], ["3", "skipped", "this run ran out of time before your turn; nothing was sent for you"], ["4", "skipped", "this run ran out of time before your turn; nothing was sent for you"]]);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.waits, [10_000 - MIRROR_SEND_MS], "the receipt wait is the budget less the send's own allowance");
  assert.deepEqual(s.told.map((t) => t.to), ["2", "3", "4"], "everyone is told, the ones not reached too");
  // Less than a send's allowance left is no send at all, not a send with no receipt.
  const tight = setup({ mirrorBudgetMs: MIRROR_SEND_MS - 1 });
  await leaderWithFollowers(tight, ["0.01"]);
  assert.deepEqual((await tight.desk.mirror("1", PEPE, parseEther("0.05"))).map((m) => m.outcome), ["skipped"]);
  assert.equal(tight.calls.length, 0);
});

test("mirror: the request's cut-off handed in by the session bot bounds the run below its own budget, receipts included, so a request that already spent forty seconds on the leader's receipt does not run its mirrors past the host", async () => {
  const s = setup();
  await leaderWithFollowers(s, ["0.01", "0.01", "0.01"]);
  // The request began 40 s ago and must be done with its mirrors in 12 s: the desk's own 30 s do not apply.
  const until = clock.getTime() + 12_000;
  let n = 0;
  s.failSendFor(() => { if (++n === 1) s.advance(8_000); return false; });
  const out = await s.desk.mirror("1", PEPE, parseEther("0.05"), { until });
  assert.deepEqual(out.map((m) => [m.followerTgId, m.outcome]), [["2", "landed"], ["3", "skipped"], ["4", "skipped"]], "12 s: one send with a 7 s receipt wait that took 8 s, then 4 s left is under a send's allowance");
  assert.deepEqual(s.waits, [12_000 - MIRROR_SEND_MS]);
  assert.match(out[1]!.why, /ran out of time before your turn/);
  // A cut-off far away leaves the desk's own budget in charge.
  const roomy = setup();
  await leaderWithFollowers(roomy, ["0.01"]);
  await roomy.desk.mirror("1", PEPE, parseEther("0.05"), { until: clock.getTime() + 600_000 });
  assert.deepEqual(roomy.waits, [30_000 - MIRROR_SEND_MS]);
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
  assert.deepEqual(m!.keyboard, [[{ text: "buy this", url: `https://t.me/usechit_bot?start=t-${PEPE}` }, { text: "follow @ogle", url: `https://t.me/usechit_bot?start=f-${acct(1)}` }]], "the follow door names the leader's account, public since they opened, never their Telegram id");
  assert.ok(!JSON.stringify(m).includes("f-1"), "the Telegram id is nowhere in the message");
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
  await s.store.putLeader({ tgId: "1", account: acct(1), handle: "<b>x</b>", since: clock.toISOString(), open: true, kind: "account" });
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

// ---------- leaders from their own wallet ----------

const WHALE = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const STRANGER = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const CHAIN = 4663;
const signedBy = (who: typeof WHALE, nonce: string, wallet: Address = WHALE.address, chainId = CHAIN) => who.signMessage({ message: leadMessage(chainId, wallet, nonce) });
const refused = (p: Promise<unknown>, status: number, why: RegExp) => assert.rejects(p, (e: unknown) => e instanceof LeadError && e.status === status && why.test(e.message), `${status} ${why}`);
/** The token's own pool on the venue, the one the bot quotes and the followers buy through; the fake's tokenInfo names no key, so it is the venue's default. */
const PEPE_POOL = poolIdOf(venuePoolKey(PEPE));
const venueBuy = (over: Partial<VenueBuy> = {}): VenueBuy => ({ block: 100n, txHash: ("0x" + "cd".repeat(32)) as Hex, buyer: WHALE.address, token: PEPE, ethInWei: parseEther("0.05"), tokensOut: 1n, poolId: PEPE_POOL, ...over });
const hash = (h: string): Hex => ("0x" + h.repeat(32)) as Hex;

test("claim: a fresh nonce of this telegram's and the wallet's own signature make a wallet leader, no link needed; the wallet is the public address and the nonce is spent; a stranger's signature, another chain's, a foreign or expired nonce and junk are refused by name without spending the nonce", async () => {
  const s = setup();
  const nonce = await s.desk.leadNonce("9");
  assert.match(nonce, /^[0-9a-f]{32}$/);
  assert.equal((await s.links.getNonce(nonce))!.tgId, "9", "the link store's nonce table, the same one the link uses");
  await refused(s.desk.claimWallet("9", "whale", WHALE.address, await signedBy(STRANGER, nonce), nonce, CHAIN, clock), 403, /not this wallet's/);
  await refused(s.desk.claimWallet("9", "whale", WHALE.address, await signedBy(WHALE, nonce, WHALE.address, 46630), nonce, CHAIN, clock), 403, /not this wallet's/);
  await refused(s.desk.claimWallet("8", "whale", WHALE.address, await signedBy(WHALE, nonce), nonce, CHAIN, clock), 404, /nonce unknown/);
  await refused(s.desk.claimWallet("9", "@whale", WHALE.address, await signedBy(WHALE, nonce), nonce, CHAIN, clock), 400, /no @/);
  await refused(s.desk.claimWallet("9", "chit team", WHALE.address, await signedBy(WHALE, nonce), nonce, CHAIN, clock), 400, /that name will not do/);
  await refused(s.desk.claimWallet("9", "", WHALE.address, await signedBy(WHALE, nonce), nonce, CHAIN, clock), 400, /needs a name/);
  await refused(s.desk.claimWallet("9", "whale", "nope", "0x00", nonce, CHAIN, clock), 400, /wallet must be/);
  await refused(s.desk.claimWallet("9", "whale", WHALE.address, "0x1234", nonce, CHAIN, clock), 400, /signature must be/);
  await refused(s.desk.claimWallet("9", "whale", WHALE.address, await signedBy(WHALE, nonce), "zz", CHAIN, clock), 400, /nonce is not one of ours/);
  await refused(s.desk.claimWallet("9", "whale", WHALE.address, await signedBy(WHALE, nonce), nonce, CHAIN, new Date(clock.getTime() + NONCE_TTL_MS + 1)), 410, /expired/);
  assert.equal((await s.links.getNonce(nonce))!.usedAt, null, "no refusal spent the nonce");
  const l = await s.desk.claimWallet("9", "whale", WHALE.address.toLowerCase(), await signedBy(WHALE, nonce), nonce, CHAIN, clock);
  assert.equal(l.kind, "wallet");
  assert.equal(l.wallet, WHALE.address, "checksummed, whatever case the page sent");
  assert.equal(l.account, WHALE.address, "the wallet is what the list and the feed's follow door show");
  assert.equal(l.handle, "whale");
  assert.ok(l.open);
  assert.deepEqual((await s.desk.leaders()).map((x) => x.tgId), ["9"]);
  assert.equal((await s.desk.leaderByWallet(WHALE.address.toLowerCase() as Address))!.tgId, "9");
  assert.equal((await s.desk.leaderAt(WHALE.address))!.tgId, "9", "the feed's door finds them by the wallet");
  // The proof is spent: the same claim again is a replay.
  await refused(s.desk.claimWallet("9", "whale", WHALE.address, await signedBy(WHALE, nonce), nonce, CHAIN, clock), 409, /already used/);
});

test("claim: one wallet, one leader; the same telegram may claim it again (a renewal keeps their since and reopens them), another's is refused even when the holder is closed; a name another open leader has is refused; an empty name keeps the one they had", async () => {
  const s = setup();
  await s.link("1", 1);
  await s.desk.becomeLeader("1", "@ogle");
  let nonce = await s.desk.leadNonce("9");
  await refused(s.desk.claimWallet("9", "@OGLE", WHALE.address, await signedBy(WHALE, nonce), nonce, CHAIN, clock), 400, /no @/);
  const first = await s.desk.claimWallet("9", "whale", WHALE.address, await signedBy(WHALE, nonce), nonce, CHAIN, clock);
  nonce = await s.desk.leadNonce("8");
  await refused(s.desk.claimWallet("8", "Whale", STRANGER.address, await signedBy(STRANGER, nonce, STRANGER.address), nonce, CHAIN, clock), 409, /already on the leaders list/);
  await refused(s.desk.claimWallet("8", "other", WHALE.address, await signedBy(WHALE, nonce), nonce, CHAIN, clock), 409, /already leads for another telegram/);
  assert.equal(await s.desk.leader("8"), undefined);
  await s.desk.closeLeader("9");
  await refused(s.desk.claimWallet("8", "other", WHALE.address, await signedBy(WHALE, nonce), nonce, CHAIN, clock), 409, /already leads for another telegram/);
  nonce = await s.desk.leadNonce("9");
  const later = new Date(clock.getTime() + 60_000);
  const again = await s.desk.claimWallet("9", "", WHALE.address, await signedBy(WHALE, nonce), nonce, CHAIN, later);
  assert.equal(again.handle, "whale", "an empty name keeps the one they had");
  assert.equal(again.since, first.since, "a renewal, not a new leader");
  assert.ok(again.open, "and it reopens them");
});

test("claim then becomeLeader: a wallet leader who opens from their account again is an account leader with the wallet kept, so their venue buys are no longer mirrored and nobody else can claim the wallet", async () => {
  const s = setup();
  await s.link("9", 9);
  const nonce = await s.desk.leadNonce("9");
  await s.desk.claimWallet("9", "whale", WHALE.address, await signedBy(WHALE, nonce), nonce, CHAIN, clock);
  const l = await s.desk.becomeLeader("9", "whale");
  assert.equal(l.kind, "account");
  assert.equal(l.account, acct(9));
  assert.equal(l.wallet, WHALE.address);
  assert.equal(await s.desk.onVenueBuy(venueBuy()), undefined, "an account leader's own wallet buys are theirs alone");
  assert.equal(s.posted.length, 0);
  const other = await s.desk.leadNonce("8");
  await refused(s.desk.claimWallet("8", "other", WHALE.address, await signedBy(WHALE, other), other, CHAIN, clock), 409, /already leads for another telegram/);
});

const walletLeaderWithFollowers = async (s: ReturnType<typeof setup>, caps: string[]) => {
  const nonce = await s.desk.leadNonce("9");
  await s.desk.claimWallet("9", "whale", WHALE.address, await signedBy(WHALE, nonce), nonce, CHAIN, clock);
  for (const [i, cap] of caps.entries()) { await s.link(String(i + 2), i + 2); await s.desk.follow(String(i + 2), "9", parseEther(cap)); }
};

test("onVenueBuy: a buy by a claimed open leader's wallet is mirrored in the fixed order at the smaller of the amounts, posted once to the feed after the mirrors with the follow door on the wallet, and the leader is told how many followed; anyone else's buy, and a closed leader's, is nothing", async () => {
  const s = setup();
  await walletLeaderWithFollowers(s, ["0.01", "0.5"]);
  assert.equal(await s.desk.onVenueBuy(venueBuy({ buyer: STRANGER.address })), undefined, "a wallet nobody claimed");
  assert.equal(s.calls.length, 0);
  assert.equal(s.posted.length, 0);
  const out = await s.desk.onVenueBuy(venueBuy({ buyer: WHALE.address.toLowerCase() as Address }));
  assert.deepEqual(out!.map((m) => [m.followerTgId, m.outcome, m.ethWei]), [["2", "landed", parseEther("0.01")], ["3", "landed", parseEther("0.05")]]);
  assert.deepEqual(s.calls, [{ account: acct(2), value: parseEther("0.01") }, { account: acct(3), value: parseEther("0.05") }]);
  assert.equal(s.posted.length, 1);
  assert.match(s.posted[0]!.text, /^<b>whale<\/b> bought <code>0.05 ETH<\/code> of <b>PEPE<\/b> · <a href="https:\/\/robinhoodchain\.blockscout\.com\/tx\/0xcdcd/);
  assert.match(s.posted[0]!.text, /\nmirrored into 2 of 2 follower accounts, already landed or sent$/);
  assert.deepEqual(s.posted[0]!.keyboard[0]![1], { text: "follow whale", url: `https://t.me/usechit_bot?start=f-${WHALE.address}` }, "the follow door carries the wallet they proved, never their Telegram id");
  assert.ok(!JSON.stringify(s.posted[0]).includes("f-9"));
  const toLeader = s.told.filter((t) => t.to === "9");
  assert.equal(toLeader.length, 1);
  assert.match(toLeader[0]!.text, /^your buy of <code>0.05 ETH<\/code> of <b>PEPE<\/b> from your wallet \(<a href="https:\/\/robinhoodchain\.blockscout\.com\/tx\/0xcdcd[0-9a-f]+">0xcdcdcdcd…<\/a>\) was posted to the feed and mirrored to 2 of 2 followers\.$/);
  assert.deepEqual(s.told.filter((t) => t.to !== "9").map((t) => t.to), ["2", "3"], "each follower was told too");
  assert.equal((await s.store.recent("9", 5)).length, 2, "the log has both");
  await s.desk.closeLeader("9");
  assert.equal(await s.desk.onVenueBuy(venueBuy({ txHash: ("0x" + "ee".repeat(32)) as Hex })), undefined, "closed: nothing");
  assert.equal(s.calls.length, 2);
  assert.equal(s.posted.length, 1);
});

test("onVenueBuy: without followers the leader is still posted and told that nobody follows yet; without a feed the leader is told the buy was seen", async () => {
  const s = setup();
  await walletLeaderWithFollowers(s, []);
  assert.deepEqual(await s.desk.onVenueBuy(venueBuy()), []);
  assert.equal(s.posted.length, 1, "the feed's message needs no follower");
  assert.match(s.told[0]!.text, /was posted to the feed; nobody follows you yet\.$/);
  const quiet = setup({ feed: false });
  await walletLeaderWithFollowers(quiet, ["0.01"]);
  await quiet.desk.onVenueBuy(venueBuy());
  assert.match(quiet.told.find((t) => t.to === "9")!.text, /from your wallet \(.*\) was mirrored to 1 of 1 follower\.$/);
});

test("onVenueBuy: the same transaction hash is not mirrored twice, whichever path saw it first; a different hash from the same wallet is", async () => {
  const s = setup();
  await walletLeaderWithFollowers(s, ["0.01"]);
  const first = await s.desk.onVenueBuy(venueBuy());
  assert.equal(first!.length, 1);
  assert.equal(await s.desk.onVenueBuy(venueBuy()), undefined, "delivered again: nothing");
  assert.equal(await s.desk.onVenueBuy(venueBuy({ txHash: ("0x" + "CD".repeat(32)) as Hex })), undefined, "the same hash in another case is the same hash");
  assert.equal(s.calls.length, 1);
  assert.equal(s.posted.length, 1);
  assert.equal(s.told.filter((t) => t.to === "9").length, 1);
  // A hash the feed already posted from the bot's own path is remembered the same way.
  await s.desk.announce("9", PEPE, parseEther("0.01"), HASH, info, safe, undefined);
  assert.equal(await s.desk.onVenueBuy(venueBuy({ txHash: HASH })), undefined);
  assert.equal(s.calls.length, 1);
  const second = await s.desk.onVenueBuy(venueBuy({ txHash: ("0x" + "ef".repeat(32)) as Hex, ethInWei: parseEther("0.02") }));
  assert.equal(second!.length, 1);
  assert.equal(s.calls.length, 2);
});

test("onVenueBuy: a token orus will not clear, or has no read for, is neither posted nor mirrored and the followers are not messaged; only the leader is told why and what buy would be", async () => {
  const hp = setup({ orus: { ...safe, honeypot: true } });
  await walletLeaderWithFollowers(hp, ["0.01"]);
  assert.deepEqual(await hp.desk.onVenueBuy(venueBuy()), [], "the leader's, but not for the feed");
  assert.equal(hp.calls.length, 0);
  assert.equal(hp.posted.length, 0, "a token the desk refuses to mirror is not advertised either");
  assert.deepEqual(hp.told.map((t) => t.to), ["9"], "the follower hears nothing for it");
  assert.match(hp.told[0]!.text, /from your wallet \(.*\) was not posted or mirrored: orus says honeypot\. a token orus clears is\.$/);
  assert.equal((await hp.store.recent("9", 5)).length, 0);
  const blind = setup({ orus: null });
  await walletLeaderWithFollowers(blind, ["0.01"]);
  assert.deepEqual(await blind.desk.onVenueBuy(venueBuy()), []);
  assert.equal(blind.posted.length, 0);
  assert.match(blind.told[0]!.text, /was not posted or mirrored: orus had no read; unknown is not safe\./);
  // The refusal is the transaction's answer: delivered again it is nothing.
  assert.equal(await blind.desk.onVenueBuy(venueBuy()), undefined);
  assert.equal(blind.told.length, 1);
});

test("onVenueBuy: the follower's daily allowance is one ledger with the session bot's taps: taps noted there count against a venue mirror, a venue mirror counts against the next tap, and the ledger's charge is add-first so two at once cannot both take the last slot", async () => {
  const tight = setup({ dailyExecutes: 3 });
  await walletLeaderWithFollowers(tight, ["0.01"]);
  // Two taps today, noted by the session bot from its own request: the third buy is the mirror, the fourth is refused.
  await tight.desk.noteDay("2");
  await tight.desk.noteDay("2");
  assert.equal(await tight.desk.overDay("2"), null);
  assert.deepEqual((await tight.desk.onVenueBuy(venueBuy()))!.map((m) => m.outcome), ["landed"], "two so far, the cap is three: the third runs");
  assert.equal(await tight.desk.overDay("2"), "that is 3 buys today from your account; again tomorrow", "and a tap now would be refused by the ledger the session bot asks");
  assert.deepEqual((await tight.desk.onVenueBuy(venueBuy({ txHash: hash("ef") })))!.map((m) => [m.outcome, m.why]), [["skipped", "that is 3 buys today from your account; again tomorrow"]]);
  assert.equal(tight.calls.length, 1);
  const gas = setup({ dailyExecutes: 100 });
  const pricey = new CopyDesk({ store: gas.store, links: gas.links, reads, session: { chainId: 4663 } as unknown as SessionChain, dailyGasWei: 700_000n * 1_000_000_000n * 2n, now: () => clock });
  await pricey.noteDay("5");
  assert.equal(await pricey.overDay("5"), null);
  await pricey.noteDay("5");
  assert.equal(await pricey.overDay("5"), "the bot has fronted its daily gas for your account; again tomorrow");
  // The last slot, asked for twice at once: one charge passes, the other is refused, the count left over only tightens the day.
  const race = setup({ dailyExecutes: 1 });
  const [a, b] = await Promise.all([race.desk.chargeDay("4"), race.desk.chargeDay("4")]);
  assert.deepEqual([a, b].filter((x) => x === null).length, 1);
  assert.equal(await race.desk.overDay("4"), "that is 1 buys today from your account; again tomorrow");
});

test("onVenueBuy: dust is read as nothing, nobody is told and the hash is not claimed; the size is the desk's constant or the deployment's", async () => {
  const s = setup();
  await walletLeaderWithFollowers(s, ["0.01"]);
  assert.equal(VENUE_MIN_ETH_WEI, parseEther("0.01"));
  assert.equal(await s.desk.onVenueBuy(venueBuy({ ethInWei: parseEther("0.01") - 1n })), undefined);
  assert.equal(s.told.length, 0, "five hundred dust buys are five hundred nothings, not five hundred messages");
  assert.equal(s.posted.length, 0);
  assert.equal(await s.store.venueBuysSince("9", new Date(0)), 0, "not claimed, not counted against the day");
  assert.equal((await s.desk.onVenueBuy(venueBuy({ ethInWei: parseEther("0.01") })))!.length, 1, "the minimum itself is read");
  const loose = setup({ venueMinEthWei: parseEther("0.001") });
  await walletLeaderWithFollowers(loose, ["0.01"]);
  assert.equal((await loose.desk.onVenueBuy(venueBuy({ ethInWei: parseEther("0.002") })))!.length, 1);
});

test("onVenueBuy: a buy through a pool that is not the token's own on the venue is the leader's alone: nothing mirrored, nothing posted, the leader told what buy would be read, the hash claimed", async () => {
  const s = setup();
  await walletLeaderWithFollowers(s, ["0.01"]);
  const own = venueBuy({ poolId: hash("11") });
  assert.deepEqual(await s.desk.onVenueBuy(own), []);
  assert.equal(s.calls.length, 0, "a pool the leader provides for themselves would make the trigger free");
  assert.equal(s.posted.length, 0);
  assert.deepEqual(s.told.map((t) => t.to), ["9"]);
  assert.match(s.told[0]!.text, /went through a pool that is not the token's pool on the venue, so it was not posted or mirrored\. a buy through the venue's own pool for the token, the one the bot quotes, is\.$/);
  assert.equal(await s.desk.onVenueBuy(own), undefined, "answered once");
  assert.equal((await s.desk.onVenueBuy(venueBuy({ poolId: ("0x" + PEPE_POOL.slice(2).toUpperCase()) as Hex, txHash: hash("ef") })))!.length, 1, "the id compares whatever its case");
  assert.equal(s.calls.length, 1);
  // The token's pool as the registry knows it, hooked or not, is the one that counts.
  const hooked = { currency0: "0x0000000000000000000000000000000000000000" as Address, currency1: PEPE, fee: 0, tickSpacing: 60, hooks: acct(0x77) };
  const withHook = new CopyDesk({ store: s.store, links: s.links, session: { chainId: 4663, async canExecute() { return { ok: true, why: "" }; }, async execute() { return { hash: HASH, landed: true }; } } as unknown as SessionChain, now: () => clock,
    reads: { ...reads, async tokenInfo(token: Address) { return { ...info, address: token, poolKey: hooked }; } } as unknown as BotChain, orus: { scan: async () => safe, link: () => "" }, tell: async () => undefined });
  assert.deepEqual(await withHook.onVenueBuy(venueBuy({ txHash: hash("a1") })), [], "the venue's default pool is not this token's pool");
  assert.equal((await withHook.onVenueBuy(venueBuy({ txHash: hash("a2"), poolId: poolIdOf(hooked) })))!.length, 1);
});

test("onVenueBuy: a wallet leader's day holds so many buys; the last one read says so, the ones after it are nothing until tomorrow, and a day full of refusals is a day full", async () => {
  const s = setup({ venueBuysPerDay: 2 });
  await walletLeaderWithFollowers(s, ["0.01"]);
  assert.equal(VENUE_BUYS_PER_DAY, 20);
  assert.equal((await s.desk.onVenueBuy(venueBuy({ txHash: hash("01") })))!.length, 1);
  assert.doesNotMatch(s.told.at(-1)!.text, /read from your wallet today/);
  assert.equal((await s.desk.onVenueBuy(venueBuy({ txHash: hash("02") })))!.length, 1);
  assert.match(s.told.at(-1)!.text, /\. that is 2 buys read from your wallet today; the next ones are read again tomorrow\.$/);
  assert.equal(await s.desk.onVenueBuy(venueBuy({ txHash: hash("03") })), undefined, "silent: the group and the followers are not this wallet's to flood");
  assert.equal(s.calls.length, 2);
  assert.equal(s.posted.length, 2);
  assert.equal(s.told.filter((t) => t.to === "9").length, 2);
  assert.equal(await s.store.venueBuysSince("9", new Date(0)), 2, "the third was not claimed either");
  // Tomorrow the count starts again.
  s.advance(24 * 3600_000);
  assert.equal((await s.desk.onVenueBuy(venueBuy({ txHash: hash("04") })))!.length, 1);
  // A scam token's buys count the same: two refusals fill a day of two.
  const hp = setup({ orus: { ...safe, honeypot: true }, venueBuysPerDay: 2 });
  await walletLeaderWithFollowers(hp, ["0.01"]);
  await hp.desk.onVenueBuy(venueBuy({ txHash: hash("01") }));
  await hp.desk.onVenueBuy(venueBuy({ txHash: hash("02") }));
  assert.equal(await hp.desk.onVenueBuy(venueBuy({ txHash: hash("03") })), undefined);
  assert.equal(hp.told.length, 2);
});

test("onVenueBuy: the transaction is claimed in the store before the first send, so two instances handed the same buy from the same window mirror it once; the second reads undefined", async () => {
  const one = setup();
  await walletLeaderWithFollowers(one, ["0.01"]);
  const two = setup({ store: one.store, links: one.links });
  const [a, b] = await Promise.all([one.desk.onVenueBuy(venueBuy()), two.desk.onVenueBuy(venueBuy())]);
  assert.equal([a, b].filter((x) => x === undefined).length, 1);
  assert.equal([a, b].filter((x) => x?.length === 1).length, 1);
  assert.equal(one.calls.length + two.calls.length, 1, "one execute across both instances");
  assert.equal(one.posted.length + two.posted.length, 1);
  assert.equal(await one.store.claimVenueBuy(venueBuy().txHash, "9", clock), false, "the row is one per hash");
  assert.equal(await one.store.claimVenueBuy(hash("CD"), "9", clock), false, "whatever the case of the hash");
});

test("onVenueBuy: a chain read that fails before the claim keeps the buy with nothing claimed and tells the leader once; retryVenueBuys reads it again and mirrors it as if it had just arrived; a read that fails again keeps the first time and says nothing more; past the retry window the buy is dropped and the leader told; a buy the store cannot keep either is the one rejection, naming both", async () => {
  const s = setup({ venueRetryMs: 15 * 60_000 });
  await walletLeaderWithFollowers(s, ["0.01"]);
  assert.equal(VENUE_RETRY_MS, 15 * 60_000);
  const quiet = console.warn;
  console.warn = () => undefined;
  try {
    s.faults.tokenInfo = true;
    assert.equal(await s.desk.onVenueBuy(venueBuy()), undefined, "not read: nothing mirrored, nothing posted");
    assert.equal(await s.store.venueBuysSince("9", new Date(0)), 0, "nothing claimed");
    assert.equal(s.calls.length, 0);
    assert.deepEqual((await s.store.deferredVenueBuys()).map((d) => [d.buy.txHash, d.since]), [[venueBuy().txHash, clock.toISOString()]], "kept, with the time it was first kept");
    assert.deepEqual(s.told.map((t) => t.to), ["9"], "the leader hears the buy was seen and will be read again; the followers hear nothing");
    assert.match(s.told[0]!.text, /^your buy of <code>0.05 ETH<\/code> of <code>0x[0-9a-f]+<\/code> from your wallet \(<a href=".*0xcdcd[0-9a-f]+">0xcdcdcdcd…<\/a>\) was seen but could not be read yet \(the chain or a partner did not answer\)\. it is read again on the next pass, for up to 15 minutes, then dropped; you hear either way\.$/);
    // The next pass: the chain still fails, the buy stays kept with its first time, and the leader is not told again.
    s.advance(5 * 60_000);
    s.faults.tokenInfo = true;
    assert.deepEqual(await s.desk.retryVenueBuys(), { read: 0, dropped: 0 });
    assert.deepEqual((await s.store.deferredVenueBuys()).map((d) => d.since), [clock.toISOString()], "the first keeping's time stands");
    assert.equal(s.told.length, 1, "told once");
    // The pass after: the chain answers, the buy is mirrored and posted as if it had just arrived, and it is kept no more.
    s.advance(5 * 60_000);
    assert.deepEqual(await s.desk.retryVenueBuys(), { read: 1, dropped: 0 });
    assert.equal(s.calls.length, 1, "mirrored");
    assert.equal(s.posted.length, 1, "posted");
    assert.match(s.told.at(-1)!.text, /was posted to the feed and mirrored to 1 of 1 follower\.$/);
    assert.deepEqual(await s.store.deferredVenueBuys(), []);
    assert.equal(await s.desk.onVenueBuy(venueBuy()), undefined, "the hash is claimed now: delivered again it is nothing");
    // A buy kept longer than the window is dropped, the leader told, and nothing is mirrored for it: a mirror that late is not a copy.
    s.faults.tokenInfo = true;
    await s.desk.onVenueBuy(venueBuy({ txHash: hash("d1") }));
    s.advance(15 * 60_000 + 1);
    assert.deepEqual(await s.desk.retryVenueBuys(), { read: 0, dropped: 1 });
    assert.deepEqual(await s.store.deferredVenueBuys(), []);
    assert.equal(s.calls.length, 1, "not mirrored");
    assert.match(s.told.at(-1)!.text, /from your wallet \(.*0xd1d1[0-9a-f]+".*\) could not be read for 15 minutes \(the chain or a partner did not answer\), so it was dropped: not posted, not mirrored\. your next buy is read fresh\.$/);
    // A kept buy that turns out to be nothing (the leader closed meanwhile) is read and dropped, not kept forever.
    s.faults.tokenInfo = true;
    await s.desk.onVenueBuy(venueBuy({ txHash: hash("d2") }));
    await s.desk.closeLeader("9");
    assert.deepEqual(await s.desk.retryVenueBuys(), { read: 1, dropped: 0 });
    assert.deepEqual(await s.store.deferredVenueBuys(), []);
    assert.equal(s.calls.length, 1);
    // The store itself is down before the claim: nothing can be kept, and the rejection says the buy was neither read nor kept.
    const down = setup();
    await walletLeaderWithFollowers(down, ["0.01"]);
    down.store.leaderByWallet = async () => { throw new Error("store is away"); };
    down.store.deferVenueBuy = async () => { throw new Error("store is away"); };
    await assert.rejects(down.desk.onVenueBuy(venueBuy()), /^Error: venue buy not read \(store is away\) and not kept \(store is away\): it will not be mirrored or posted$/);
    assert.equal(down.told.length, 0);
  } finally { console.warn = quiet; }
});

test("onVenueBuy: after the claim a mirror run that throws, a feed that refuses and a leader who cannot be reached are each caught, the claim stands and the leader hears what happened", async () => {
  const s = setup();
  await walletLeaderWithFollowers(s, ["0.01"]);
  assert.equal((await s.desk.onVenueBuy(venueBuy()))!.length, 1);
  // The log line after the follower's send throws: the send happened, so the claim stands; the leader is told the mirror broke; the feed is still posted.
  s.faults.log = true;
  assert.deepEqual(await s.desk.onVenueBuy(venueBuy({ txHash: hash("e1") })), []);
  assert.equal(s.calls.length, 2, "the send had gone");
  assert.equal(s.posted.length, 2, "the feed still posted");
  assert.match(s.told.at(-1)!.text, /was posted to the feed; a mirror broke on our side, every follower who was reached was told and the rest were not mirrored this time\.$/);
  assert.equal(await s.desk.onVenueBuy(venueBuy({ txHash: hash("e1") })), undefined, "not mirrored again: money moves at most once");
  assert.equal(s.calls.length, 2);
  assert.deepEqual(await s.store.deferredVenueBuys(), [], "a failure after the claim is never kept for another read");
  // The feed refuses: the mirrors stand, the leader hears the feed broke.
  s.faults.feed = true;
  assert.equal((await s.desk.onVenueBuy(venueBuy({ txHash: hash("e2") })))!.length, 1);
  assert.equal(s.posted.length, 2);
  assert.match(s.told.at(-1)!.text, /was not posted, the feed broke on our side and mirrored to 1 of 1 follower\.$/);
  // The leader cannot be reached: the handler still resolves with the mirrors.
  s.faults.tell = true;
  const out = await s.desk.onVenueBuy(venueBuy({ txHash: hash("e3") }));
  assert.equal(out!.length, 1);
  assert.equal(s.posted.length, 3);
});

test("the record: a mirror of either path goes only through a pool on the bot's record; a leader's buy of a token whose pool was discovered is skipped for every follower with the reason and nothing is sent, and on the venue path it is claimed, not posted, and the leader is told what buy would be", async () => {
  const found = { ...info, poolOnRecord: false };
  const s = setup();
  const discovered = new CopyDesk({
    store: s.store, links: s.links, session: { chainId: 4663, async canExecute() { return { ok: true, why: "" }; }, async execute() { throw new Error("must not be sent"); } } as unknown as SessionChain, now: () => clock,
    reads: { ...reads, async tokenInfo(token: Address) { return { ...found, address: token }; } } as unknown as BotChain, orus: { scan: async () => safe, link: () => "" },
    tell: async (to, text) => { s.told.push({ to, text }); }, botUsername: "usechit_bot", feed: { chatId: "-100", post: async (text, keyboard) => { s.posted.push({ text, keyboard }); } },
  });
  // The account path: the leader tapped a buy of a token the registry found a pool for.
  await s.link("1", 1);
  await discovered.becomeLeader("1", "@ogle");
  await s.link("2", 2);
  await discovered.follow("2", "1", parseEther("0.01"));
  const mirrors = await discovered.mirror("1", PEPE, parseEther("0.05"));
  assert.deepEqual(mirrors.map((m) => [m.followerTgId, m.outcome, m.ethWei]), [["2", "skipped", 0n]]);
  assert.equal(mirrors[0]!.why, "PEPE's pool is not on the bot's record, so a mirror cannot vouch for the pool it would buy through; nothing was sent for you. only a token the bot's record names is mirrored ($CHIT on mainnet); buy this one yourself from its token card if you want it");
  assert.match(s.told.at(-1)!.text, /^copy from <b>@ogle<\/b>: skipped\. PEPE's pool is not on the bot's record/);
  // The venue path: the same token bought from a wallet leader's wallet through the very pool the registry found.
  const nonce = await discovered.leadNonce("9");
  await discovered.claimWallet("9", "whale", WHALE.address, await signedBy(WHALE, nonce), nonce, CHAIN, clock);
  await s.link("3", 3);
  await discovered.follow("3", "9", parseEther("0.01"));
  assert.deepEqual(await discovered.onVenueBuy(venueBuy()), [], "the leader's, but not for the feed");
  assert.equal(s.posted.length, 0, "not advertised: the desk would not mirror it");
  assert.equal(await s.store.venueBuysSince("9", new Date(0)), 1, "claimed and counted against the day");
  assert.match(s.told.at(-1)!.text, /from your wallet \(.*\) is of a token whose pool is not on the bot's record, so it was not posted or mirrored: a pool found on the chain is anyone's to open at any price, and the desk moves your followers' money only through a recorded pool\. a buy of a token the record names \(\$CHIT on mainnet\) is\.$/);
  assert.deepEqual(s.told.filter((t) => t.to === "3"), [], "the follower is not messaged for it");
  assert.equal(await discovered.onVenueBuy(venueBuy()), undefined, "answered once");
});

test("neon: a kept venue buy is one insert whose RETURNING says whether this was the first keeping (a repeat changes nothing, so the first time stands), the kept buys come back whole and oldest first, and a drop is one delete; hashes, tokens and pool ids are stored lowercase", async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const calls: { query: string; params: unknown[] }[] = [];
  const sql: CopySql = {
    async query(query, params = []) {
      calls.push({ query, params });
      if (/^\s*(CREATE|ALTER)/.test(query)) return [];
      if (query.includes("INSERT INTO bot_venue_deferred")) {
        const [tx_hash, block, buyer, token, eth_in_wei, tokens_out, pool_id, since] = params as string[];
        if (rows.has(tx_hash!)) return [];
        rows.set(tx_hash!, { tx_hash, block, buyer, token, eth_in_wei, tokens_out, pool_id, since });
        return [{ tx_hash }];
      }
      if (query.includes("SELECT * FROM bot_venue_deferred")) return [...rows.values()].sort((a, b) => String(a.since).localeCompare(String(b.since)));
      if (query.includes("DELETE FROM bot_venue_deferred")) { rows.delete(String(params[0])); return []; }
      throw new Error(`unexpected sql: ${query}`);
    },
  };
  const store = new NeonCopyStore(sql);
  const b = venueBuy({ txHash: ("0x" + "AB".repeat(32)) as Hex, token: PEPE.toUpperCase().replace("0X", "0x") as Address });
  assert.equal(await store.deferVenueBuy(b, clock), true, "the first keeping");
  const insert = calls.find((c) => c.query.includes("INSERT INTO bot_venue_deferred"))!;
  assert.match(insert.query, /ON CONFLICT \(tx_hash\) DO NOTHING RETURNING tx_hash$/);
  assert.deepEqual(insert.params, ["0x" + "ab".repeat(32), "100", WHALE.address, PEPE, parseEther("0.05").toString(), "1", PEPE_POOL.toLowerCase(), clock.toISOString()]);
  assert.equal(await store.deferVenueBuy(b, new Date(clock.getTime() + 60_000)), false, "a repeat: no row back, the first time stands");
  await store.deferVenueBuy(venueBuy({ txHash: hash("01") }), new Date(clock.getTime() - 60_000));
  const kept = await store.deferredVenueBuys();
  assert.deepEqual(kept.map((d) => [d.buy.txHash, d.since]), [[hash("01"), new Date(clock.getTime() - 60_000).toISOString()], ["0x" + "ab".repeat(32), clock.toISOString()]], "oldest first");
  assert.deepEqual(kept[1]!.buy, { ...b, txHash: ("0x" + "ab".repeat(32)) as Hex, token: PEPE, poolId: PEPE_POOL.toLowerCase() as Hex }, "whole, as the watcher handed it");
  await store.dropVenueBuy(("0x" + "AB".repeat(32)) as Hex);
  assert.deepEqual(calls.at(-1), { query: "DELETE FROM bot_venue_deferred WHERE tx_hash = $1", params: ["0x" + "ab".repeat(32)] });
  assert.deepEqual((await store.deferredVenueBuys()).map((d) => d.buy.txHash), [hash("01")]);
  assert.ok(calls.some((c) => c.query.includes("CREATE TABLE IF NOT EXISTS bot_venue_deferred")), "the table is in the schema");
});
