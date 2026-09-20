/**
 * The copy desk: a leader needs a link; a follow needs an open leader and
 * a cap inside the bounds; a mirror is gated by orus (a honeypot or no read
 * skips everyone, with the reason), by the aggregate cap per token per day,
 * and by each follower's own session (its refusal quoted); it is sized to
 * the smaller of the leader's amount and the cap, runs in the fixed order,
 * and logs every outcome; the feed gets one message per landed buy with the
 * two doors into the bot, and nothing for a closed leader or without a feed.
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

const setup = (opts: { orus?: OrusScan | null | "off"; tokenDayCapWei?: bigint; feed?: boolean } = {}) => {
  const store = new MemoryCopyStore();
  const links = new MemoryBotLinkStore();
  const calls: { account: Address; value: bigint }[] = [];
  const told: { to: string; text: string }[] = [];
  const posted: { text: string; keyboard: Keyboard }[] = [];
  let refuse: ((account: Address) => string | null) = () => null;
  const session: SessionChain = {
    chainId: 4663, signer: acct(0xb0),
    async ownerOf() { return OWNER; },
    async sessionOf() { throw new Error("not read here"); },
    async canExecute(account) { const why = refuse(account); return why ? { ok: false, why } : { ok: true, why: "" }; },
    async execute(account, _t, value) { calls.push({ account, value }); return { hash: HASH, landed: true }; },
    async signerBalance() { return parseEther("1"); },
  };
  const answer: OrusScan | undefined = opts.orus === null || opts.orus === "off" ? undefined : opts.orus ?? safe;
  const orus = opts.orus === "off" ? undefined : { scan: async () => answer, link: (t: Address) => `https://www.orusagent.xyz/token/${t}` };
  const desk = new CopyDesk({
    store, links, reads, session, now: () => clock,
    ...(orus ? { orus } : {}),
    ...(opts.tokenDayCapWei !== undefined ? { tokenDayCapWei: opts.tokenDayCapWei } : {}),
    tell: async (to, text) => { told.push({ to, text }); },
    botUsername: "usechit_bot",
    ...(opts.feed === false ? {} : { feed: { chatId: "-100", post: async (text, keyboard) => { posted.push({ text, keyboard }); } } }),
  });
  const link = (tgId: string, n: number) => links.putLink({ tgId, account: acct(n), owner: OWNER, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });
  return { desk, store, links, link, calls, told, posted, refuseWith: (f: typeof refuse) => { refuse = f; } };
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

test("announce: a handle is escaped, and without an orus scanner the orus line is not drawn", async () => {
  const s = setup({ orus: "off" });
  await s.link("1", 1);
  await s.desk.becomeLeader("1", "<b>x</b>");
  await s.desk.announce("1", PEPE, parseEther("0.01"), HASH, info, undefined, undefined);
  assert.match(s.posted[0]!.text, /^<b>&lt;b&gt;x&lt;\/b&gt;<\/b> bought/);
  assert.equal(s.posted[0]!.text.split("\n").length, 1);
});
