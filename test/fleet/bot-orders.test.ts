/**
 * Standing orders: due() picks a limit when the pool crosses its price and
 * a dca when its time has come; the runner fires each as one execute inside
 * the session, moves a dca along and closes a limit, keeps a refused order
 * open with the reason and fails it after three in a row, never sends more
 * than its cap in one pass, and tells the owner every time. Money moves at
 * most once: a claim before the send that names the dca slot it is for (so
 * two overlapping runs cannot buy one slot twice), a settle that never
 * overwrites a cancel, a cut-off run settled as sent by the next; a limit never fills
 * under its level; one owner has a daily budget and cannot starve another;
 * a runner sees only its own chain's orders; the Neon store does each of
 * these in one conditional statement.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex, parseEther } from "viem";
import type { BotChain } from "../../src/fleet/bot-chain.js";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import { FIRING_LEASE_MS, MemoryOrderStore, NeonOrderStore, OrderRunner, due, fair, levelOut, type Order, type OrderSql, type OrderStore } from "../../src/fleet/bot-orders.js";
import type { SessionChain } from "../../src/fleet/bot-session-chain.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, encodeV4EthBuy, minOutFor } from "../../src/fleet/v4-swap.js";

const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address;
const OWNER = "0x0000000000000000000000000000000000000011" as Address;
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
const clock = new Date("2026-09-20T12:00:00Z");
const HOUR = 3_600_000;
const none = { fired: 0, landed: 0, refused: 0, waited: 0 };

const order = (p: Partial<Order> & { id: string; kind: Order["kind"] }): Order => ({
  tgId: "7", account: ACCOUNT, chainId: 4663, token: PEPE, ethWei: parseEther("0.01"), createdAt: clock.toISOString(), status: "open", refusals: 0, ...p,
});

test("due: a limit fires when the pool gives at least its tokens per eth, a dca when its next time has passed, nothing else; an order a run holds is not due", () => {
  const limit = order({ id: "l", kind: "limit", triggerPerEth: 1_200_000n });
  const dca = order({ id: "d", kind: "dca", everyMs: 4 * HOUR, remaining: 6, nextAt: clock.toISOString() });
  const later = order({ id: "d2", kind: "dca", everyMs: 4 * HOUR, remaining: 6, nextAt: new Date(clock.getTime() + 1).toISOString() });
  const spent = order({ id: "d3", kind: "dca", everyMs: 4 * HOUR, remaining: 0, nextAt: clock.toISOString() });
  const closed = order({ id: "c", kind: "limit", triggerPerEth: 1n, status: "cancelled" });
  const held = order({ id: "h", kind: "limit", triggerPerEth: 1n, firingAt: clock.toISOString() });
  const all = [limit, dca, later, spent, closed, held];
  assert.deepEqual(due(all, clock, () => 1_199_999n).map((o) => o.id), ["d"], "price below the level: only the dca");
  assert.deepEqual(due(all, clock, () => 1_200_000n).map((o) => o.id), ["l", "d"], "at the level: the limit fires");
  assert.deepEqual(due(all, clock, () => undefined).map((o) => o.id), ["d"], "no price: no limit");
  assert.deepEqual(due(all, new Date(clock.getTime() + 1), () => 0n).map((o) => o.id), ["d", "d2"]);
});

test("fair: one order per owner in turn, each owner's own order kept", () => {
  const a = (id: string) => order({ id, kind: "limit", tgId: "a" });
  const b = (id: string) => order({ id, kind: "limit", tgId: "b" });
  assert.deepEqual(fair([a("a1"), a("a2"), a("a3"), b("b1"), b("b2")]).map((o) => o.id), ["a1", "b1", "a2", "b2", "a3"]);
  assert.deepEqual(fair([]), []);
});

const reads = (perEth: bigint, quoteOf?: (ethIn: bigint) => bigint | null) => ({
  chainId: 4663, router: ROUTER,
  async tokenInfo(token: Address) { return { address: token, symbol: "PEPE", decimals: 6, hasPool: true, perEth, poolEth: parseEther("5"), hooked: false, fee: 3000 }; },
  async quoteBuy(_t: Address, ethIn: bigint) { return quoteOf ? quoteOf(ethIn) : (ethIn * perEth) / 10n ** 18n; },
} as unknown as BotChain);

const fakeSession = () => {
  const calls: { account: Address; value: bigint; data: Hex }[] = [];
  let refuse: string | null = null;
  let onExecute: (() => Promise<void>) | undefined;
  let fail: string | null = null;
  const s: SessionChain = {
    chainId: 4663, signer: "0x00000000000000000000000000000000000000b0",
    async ownerOf() { return OWNER; },
    async sessionOf() { throw new Error("not read here"); },
    async canExecute() { return refuse ? { ok: false, why: refuse } : { ok: true, why: "" }; },
    async execute(account, _t, value, data) {
      if (fail) throw new Error(fail);
      calls.push({ account, value, data });
      if (onExecute) await onExecute();
      return { hash: ("0x" + "ab".repeat(32)) as Hex, landed: true };
    },
    async signerBalance() { return parseEther("1"); },
    // Orders buy only; the sell side is never asked here.
    async sellAllowed() { return false; },
    async canSell() { return { ok: false, why: "sell not allowed" }; },
    async sell() { throw new Error("not sold here"); },
  };
  return { s, calls, refuseWith: (why: string | null) => { refuse = why; }, failWith: (why: string | null) => { fail = why; }, during: (f: (() => Promise<void>) | undefined) => { onExecute = f; } };
};

const setup = (perEth = 1_500_000n, opts: { maxPerRun?: number; dailyExecutes?: number; dailyGasWei?: bigint; reads?: BotChain } = {}) => {
  const orders = new MemoryOrderStore();
  const links = new MemoryBotLinkStore();
  const session = fakeSession();
  const telegram = new RecordingTelegram();
  const { reads: r, ...rest } = opts;
  const runner = new OrderRunner({ orders, links, reads: r ?? reads(perEth), session: session.s, telegram, now: () => clock, ...rest });
  return { orders, links, session, telegram, runner };
};
const linked = (links: MemoryBotLinkStore, account = ACCOUNT, tgId = "7", chainId = 4663) => links.putLink({ tgId, account, owner: OWNER, chainId, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });

test("a limit that fires is one execute on the account with the router's selector, then done; the owner gets the hash", async () => {
  const { orders, links, session, telegram, runner } = setup();
  await linked(links);
  await orders.put(order({ id: "l", kind: "limit", triggerPerEth: 1_200_000n }));
  assert.deepEqual(await runner.run(), { ...none, fired: 1, landed: 1 });
  assert.equal(session.calls.length, 1);
  assert.equal(session.calls[0]!.account, ACCOUNT);
  assert.equal(session.calls[0]!.value, parseEther("0.01"));
  assert.ok(session.calls[0]!.data.startsWith(UNIVERSAL_ROUTER_EXECUTE_SELECTOR));
  const l = (await orders.get("l"))!;
  assert.equal(l.status, "done");
  assert.equal(l.firingAt, undefined, "the claim is cleared with the settle");
  assert.match(telegram.last(), /limit buy: <code>0.01 ETH<\/code> into <b>PEPE<\/b> landed, <a href="https:\/\/robinhoodchain\.blockscout\.com\/tx\/0xabab/);
  assert.equal((telegram.sent[0] as { chatId: string }).chatId, "7", "told in the owner's private chat");
  assert.deepEqual(await runner.run(), none, "done is done");
});

test("a dca buys, counts down and sets its next time one interval on; the last buy closes it", async () => {
  const { orders, links, session, telegram, runner } = setup();
  await linked(links);
  await orders.put(order({ id: "d", kind: "dca", everyMs: 4 * HOUR, remaining: 2, nextAt: clock.toISOString() }));
  assert.deepEqual(await runner.run(), { ...none, fired: 1, landed: 1 });
  let d = (await orders.get("d"))!;
  assert.equal(d.remaining, 1);
  assert.equal(d.nextAt, new Date(clock.getTime() + 4 * HOUR).toISOString());
  assert.equal(d.status, "open");
  assert.match(telegram.last(), /dca: .* landed, .* 1 left\./);
  assert.deepEqual(await runner.run(clock), none, "not due again until the interval passes");
  await runner.run(new Date(clock.getTime() + 4 * HOUR));
  d = (await orders.get("d"))!;
  assert.equal(d.status, "done");
  assert.equal(session.calls.length, 2);
  assert.match(telegram.last(), /that was the last one/);
});

test("a refusal keeps the order open with the reason and tells the owner; three in a row fail it; a buy in between resets the count", async () => {
  const { orders, links, session, telegram, runner } = setup();
  await linked(links);
  await orders.put(order({ id: "l", kind: "limit", triggerPerEth: 1_200_000n }));
  session.refuseWith("session paused");
  assert.deepEqual(await runner.run(), { ...none, fired: 1, refused: 1 });
  let l = (await orders.get("l"))!;
  assert.equal(l.status, "open", "a paused session does not cancel the order");
  assert.equal(l.lastError, "your session says no: session paused");
  assert.equal(l.refusals, 1);
  assert.match(telegram.last(), /your session says no: session paused\. the order stays on; .* \(1 of 3\)/);
  await runner.run();
  session.refuseWith(null);
  await runner.run();
  l = (await orders.get("l"))!;
  assert.equal(l.status, "done", "the buy went through on the third try");
  assert.equal(session.calls.length, 1);
  // A dca that is refused three times in a row is failed, and it waits for its slot between tries rather than knocking every run.
  await orders.put(order({ id: "d", kind: "dca", everyMs: HOUR, remaining: 5, nextAt: clock.toISOString() }));
  session.refuseWith("over your per-trade cap");
  await runner.run();
  let d = (await orders.get("d"))!;
  assert.equal(d.refusals, 1);
  assert.equal(d.remaining, 5, "a refusal does not burn a buy");
  assert.equal(d.nextAt, new Date(clock.getTime() + HOUR).toISOString(), "next try at the next slot");
  assert.deepEqual(await runner.run(clock), none);
  await runner.run(new Date(clock.getTime() + HOUR));
  await runner.run(new Date(clock.getTime() + 2 * HOUR));
  d = (await orders.get("d"))!;
  assert.equal(d.status, "failed");
  assert.equal(d.refusals, 3);
  assert.match(telegram.last(), /3 refusals in a row, so the order is off/);
  assert.equal(session.calls.length, 1, "no execute on any refusal");
});

test("an order placed from an account the telegram no longer links to, or linked on another chain, is refused, not fired", async () => {
  const { orders, links, session, runner } = setup();
  await linked(links, "0x00000000000000000000000000000000000000bb");
  await orders.put(order({ id: "l", kind: "limit", triggerPerEth: 1n }));
  assert.deepEqual(await runner.run(), { ...none, fired: 1, refused: 1 });
  assert.equal(session.calls.length, 0);
  assert.match((await orders.get("l"))!.lastError ?? "", /no longer linked/);
  await linked(links, ACCOUNT, "7", 46630);
  assert.deepEqual(await runner.run(), { ...none, fired: 1, refused: 1 }, "the same account linked on the testnet is not this order's link");
  assert.equal(session.calls.length, 0);
});

test("one pass sends at most its cap of executes, one owner in turn, so a queue of one owner's orders never starves another's", async () => {
  const { orders, links, session, runner } = setup(1_500_000n, { maxPerRun: 3, dailyGasWei: parseEther("1") });
  await linked(links);
  await linked(links, ACCOUNT, "8");
  for (let i = 0; i < 5; i++) await orders.put(order({ id: `l${i}`, kind: "limit", triggerPerEth: 1n, createdAt: new Date(clock.getTime() + i).toISOString() }));
  await orders.put(order({ id: "other", kind: "limit", tgId: "8", triggerPerEth: 1n, createdAt: new Date(clock.getTime() + 10).toISOString() }));
  assert.deepEqual(await runner.run(), { ...none, fired: 3, landed: 3 });
  assert.equal(session.calls.length, 3);
  assert.equal((await orders.get("other"))!.status, "done", "the newest order of the other owner went in the first pass");
  assert.deepEqual((await orders.open(4663)).map((o) => o.id), ["l2", "l3", "l4"]);
  assert.deepEqual(await runner.run(), { ...none, fired: 3, landed: 3 });
  assert.equal((await orders.open(4663)).length, 0);
});

test("a claim goes before the send and the settle after it only lands on an open order: a cancel between the read and the send stops it, a cancel during the send is not written over", async () => {
  const { orders, links, session, telegram, runner } = setup();
  await linked(links);
  await orders.put(order({ id: "d", kind: "dca", everyMs: 4 * HOUR, remaining: 6, nextAt: clock.toISOString() }));
  // Cancelled while the run is still reading: the claim does not land, nothing is sent, nothing is written.
  const before = new OrderRunner({ orders, links, reads: reads(1_500_000n), session: { ...session.s, async canExecute() { await orders.cancel("d"); return { ok: true, why: "" }; } }, telegram, now: () => clock });
  assert.deepEqual(await before.run(), none);
  assert.equal(session.calls.length, 0);
  assert.equal((await orders.get("d"))!.status, "cancelled");
  // Cancelled while the send is in flight: that buy went out, the order stays cancelled, the owner is told, nothing more fires.
  await orders.put(order({ id: "d2", kind: "dca", everyMs: 4 * HOUR, remaining: 6, nextAt: clock.toISOString() }));
  session.during(async () => { assert.equal((await orders.get("d2"))!.firingAt, clock.toISOString(), "claimed before the send"); assert.equal(await orders.cancel("d2"), true); });
  assert.deepEqual(await runner.run(), { ...none, fired: 1, landed: 1 });
  assert.equal(session.calls.length, 1);
  const d2 = (await orders.get("d2"))!;
  assert.equal(d2.status, "cancelled", "the settle did not write the order back to open");
  assert.equal(d2.remaining, 6);
  assert.match(telegram.last(), /went out, .* and the order was cancelled while it was in flight; nothing more is sent/);
  session.during(undefined);
  assert.deepEqual(await runner.run(new Date(clock.getTime() + 4 * HOUR)), none);
  assert.equal(session.calls.length, 1);
  // A refusal's write is conditional the same way.
  await orders.put(order({ id: "l", kind: "limit", triggerPerEth: 1n }));
  const refusing = new OrderRunner({ orders, links, reads: reads(1_500_000n), session: { ...session.s, async canExecute() { await orders.cancel("l"); return { ok: false, why: "paused" }; } }, telegram, now: () => clock });
  await refusing.run();
  assert.equal((await orders.get("l"))!.status, "cancelled");
  assert.equal((await orders.get("l"))!.refusals, 0);
});

test("two runs over the same dca: the second, working from a read taken before the first bought the slot, claims nothing and sends nothing, because the claim names the slot and every write moves a dca's slot on", async () => {
  const { orders, links, session, telegram, runner } = setup();
  await linked(links);
  await orders.put(order({ id: "d", kind: "dca", everyMs: 4 * HOUR, remaining: 5, nextAt: clock.toISOString() }));
  // Run B reads the open orders now (cron jitter, a manual POST) and is slow to reach this owner's order; run A fires it meanwhile.
  const stale = await orders.open(4663);
  const behind: OrderStore = {
    put: (o) => orders.put(o), get: (id) => orders.get(id), openFor: (t, c) => orders.openFor(t, c), cancel: (id) => orders.cancel(id),
    claim: (id, at, slot) => orders.claim(id, at, slot), settle: (o) => orders.settle(o), firesSince: (t, c, s) => orders.firesSince(t, c, s),
    open: async () => stale.map((o) => ({ ...o })),
  };
  const runB = new OrderRunner({ orders: behind, links, reads: reads(1_500_000n), session: session.s, telegram, now: () => new Date(clock.getTime() + 45_000) });
  assert.deepEqual(await runner.run(), { ...none, fired: 1, landed: 1 });
  assert.equal((await orders.get("d"))!.remaining, 4);
  assert.equal((await orders.get("d"))!.firingAt, undefined, "run A's settle cleared its claim, which alone would let a stale claim in");
  assert.deepEqual(await runB.run(), none, "the slot run B read is gone: its claim does not land, nothing is skipped as refused or waited");
  assert.equal(session.calls.length, 1, "one buy for one slot");
  const d = (await orders.get("d"))!;
  assert.equal(d.remaining, 4, "and the count is what one buy leaves, not a stale copy's arithmetic");
  assert.equal(d.nextAt, new Date(clock.getTime() + 4 * HOUR).toISOString());
  assert.equal(orders.fires.length, 1, "the ledger has one fire");
  assert.equal(telegram.sent.length, 1, "the owner heard about one buy");
  // A wait moves the slot too: run A's wait (the day's budget) is enough to keep a stale run B from firing what A held back.
  await orders.put(order({ id: "w", kind: "dca", everyMs: HOUR, remaining: 2, nextAt: clock.toISOString(), createdAt: new Date(clock.getTime() + 1).toISOString() }));
  const staleW = (await orders.open(4663)).filter((o) => o.id === "w");
  const waiting = new OrderRunner({ orders, links, reads: reads(1_500_000n), session: session.s, telegram, now: () => clock, dailyExecutes: 1 });
  assert.deepEqual(await waiting.run(), { ...none, waited: 1 });
  const laterB = new OrderRunner({ orders: { ...behind, open: async () => staleW.map((o) => ({ ...o })) }, links, reads: reads(1_500_000n), session: session.s, telegram, now: () => clock });
  assert.deepEqual(await laterB.run(), none);
  assert.equal(session.calls.length, 1);
  // The store itself: a claim with the slot as it stands lands, one with the slot as it was does not; a limit has no slot on either side.
  await orders.put(order({ id: "d3", kind: "dca", everyMs: HOUR, remaining: 2, nextAt: clock.toISOString(), createdAt: new Date(clock.getTime() + 2).toISOString() }));
  assert.equal(await orders.claim("d3", clock, new Date(clock.getTime() + 1).toISOString()), false, "another slot: not this order's");
  assert.equal(await orders.claim("d3", clock, undefined), false, "no slot named for a dca: not taken");
  assert.equal(await orders.claim("d3", clock, clock.toISOString()), true);
  await orders.put(order({ id: "l", kind: "limit", triggerPerEth: 1n }));
  assert.equal(await orders.claim("l", clock, undefined), true);
});

test("a claim a dead run left behind is settled as sent once its lease is over, never sent again: a limit closes, a dca counts the slot; a live claim is left alone", async () => {
  const { orders, links, session, telegram, runner } = setup();
  await linked(links);
  const stale = new Date(clock.getTime() - FIRING_LEASE_MS).toISOString();
  await orders.put(order({ id: "l", kind: "limit", triggerPerEth: 1n, firingAt: stale }));
  await orders.put(order({ id: "d", kind: "dca", everyMs: 4 * HOUR, remaining: 3, nextAt: clock.toISOString(), firingAt: stale }));
  await orders.put(order({ id: "live", kind: "limit", triggerPerEth: 1n, firingAt: new Date(clock.getTime() - 60_000).toISOString() }));
  assert.deepEqual(await runner.run(), none);
  assert.equal(session.calls.length, 0, "nothing is sent for an order whose send may have gone out");
  const l = (await orders.get("l"))!;
  assert.equal(l.status, "failed");
  assert.equal(l.firingAt, undefined);
  assert.match(l.lastError ?? "", /cut off before the answer came/);
  const d = (await orders.get("d"))!;
  assert.equal(d.status, "open");
  assert.equal(d.remaining, 2, "the slot counts as spent so it cannot buy twice");
  assert.equal(d.nextAt, new Date(clock.getTime() + 4 * HOUR).toISOString());
  assert.equal(d.firingAt, undefined);
  const texts = telegram.sent.filter((o) => o.kind === "send").map((o) => (o as { text: string }).text);
  assert.ok(texts.some((t) => /limit buy on .*cut off before the answer came\. it is not sent again on its own: check the account on the explorer and set the order again if nothing landed/.test(t)), texts.join("\n"));
  assert.ok(texts.some((t) => /dca on .*that slot counts as spent so it cannot buy twice; check the account\. 2 left/.test(t)), texts.join("\n"));
  assert.equal((await orders.get("live"))!.firingAt, new Date(clock.getTime() - 60_000).toISOString(), "a claim inside its lease belongs to a run still going");
});

test("a send that throws is not sent again on its own, because the transaction may still have been relayed", async () => {
  const { orders, links, session, telegram, runner } = setup();
  await linked(links);
  await orders.put(order({ id: "l", kind: "limit", triggerPerEth: 1n }));
  await orders.put(order({ id: "d", kind: "dca", everyMs: HOUR, remaining: 1, nextAt: clock.toISOString() }));
  session.failWith("HTTP request timed out\nurl: https://rpc");
  assert.deepEqual(await runner.run(), { ...none, fired: 2 });
  const l = (await orders.get("l"))!;
  assert.equal(l.status, "failed");
  assert.equal(l.lastError, "the send did not answer (HTTP request timed out)");
  assert.equal(l.firingAt, undefined);
  const d = (await orders.get("d"))!;
  assert.equal(d.status, "done", "the only slot counts as spent");
  assert.equal(d.remaining, 0);
  assert.match(telegram.last(), /the send did not answer \(HTTP request timed out\)\. that slot counts as spent so it cannot buy twice; check the account\. that was the last one\./);
  session.failWith(null);
  assert.deepEqual(await runner.run(), none);
  assert.equal(session.calls.length, 0);
});

test("a limit never fills under its level: the level is the floor when the quote's floor is lower, a pool too thin to give it waits (told once), and a price that slipped back since the run's read is not due", async () => {
  // Spot at the level, the quote for this size 5% under it: the pool cannot fill at the level, the order waits with the reason on it.
  const trigger = 1_200_000n;
  const thin = reads(trigger, (ethIn) => ((ethIn * trigger) / 10n ** 18n) * 95n / 100n);
  const { orders, links, session, telegram, runner } = setup(trigger, { reads: thin });
  await linked(links);
  await orders.put(order({ id: "l", kind: "limit", ethWei: parseEther("0.05"), triggerPerEth: trigger }));
  assert.deepEqual(await runner.run(), { ...none, waited: 1 });
  assert.equal(session.calls.length, 0);
  let l = (await orders.get("l"))!;
  assert.equal(l.status, "open");
  assert.equal(l.refusals, 0, "waiting is not a refusal");
  assert.match(l.lastError ?? "", /the pool gives fewer PEPE than your level for 0\.05 ETH once the fee and the depth are in; the order waits for the price to move/);
  assert.equal(telegram.sent.length, 1);
  assert.deepEqual(await runner.run(), { ...none, waited: 1 });
  assert.equal(telegram.sent.length, 1, "the same reason is not said every five minutes");
  // The quote 1% over the level: it fires, and the floor is the level, higher than the quote less the slippage.
  const level = levelOut(l);
  const ample = reads(trigger * 102n / 100n, (ethIn) => ((ethIn * trigger) / 10n ** 18n) * 101n / 100n);
  const firing = new OrderRunner({ orders, links, reads: ample, session: session.s, telegram, now: () => clock });
  assert.deepEqual(await firing.run(), { ...none, fired: 1, landed: 1 });
  const quote = level * 101n / 100n;
  assert.ok(minOutFor(quote, 300) < level, "the quote's own floor would be under the level");
  assert.equal(session.calls[0]!.data, encodeV4EthBuy({ token: PEPE, amountIn: parseEther("0.05"), minOut: level, deadline: BigInt(Math.floor(clock.getTime() / 1000) + 3600) }));
  l = (await orders.get("l"))!;
  assert.equal(l.status, "done");
  assert.equal(l.lastError, undefined, "the note goes with the fill");
  // The run's price read is above the level, the fire's read is under it: not due any more, nothing sent, nothing written.
  await orders.put(order({ id: "l2", kind: "limit", triggerPerEth: trigger }));
  let n = 0;
  const slipping = { ...reads(trigger), async tokenInfo(token: Address) { n += 1; return { address: token, symbol: "PEPE", decimals: 6, hasPool: true, perEth: n === 1 ? trigger : trigger - 1n, poolEth: parseEther("5"), hooked: false, fee: 3000 }; } } as unknown as BotChain;
  const slipped = new OrderRunner({ orders, links, reads: slipping, session: session.s, telegram, now: () => clock });
  assert.deepEqual(await slipped.run(), none);
  assert.equal(session.calls.length, 1);
  assert.deepEqual(await orders.get("l2"), order({ id: "l2", kind: "limit", triggerPerEth: trigger }));
});

test("each owner has the same daily budget a tapped Buy has, counted from the ledger across runs: over it their orders wait for tomorrow, told once; the day turns and they fire", async () => {
  const { orders, links, session, telegram, runner } = setup(1_500_000n, { dailyExecutes: 2 });
  await linked(links);
  await linked(links, ACCOUNT, "8");
  for (let i = 0; i < 3; i++) await orders.put(order({ id: `l${i}`, kind: "limit", triggerPerEth: 1n, createdAt: new Date(clock.getTime() + i).toISOString() }));
  await orders.put(order({ id: "d", kind: "dca", everyMs: HOUR, remaining: 4, nextAt: clock.toISOString(), createdAt: new Date(clock.getTime() + 5).toISOString() }));
  await orders.put(order({ id: "other", kind: "limit", tgId: "8", triggerPerEth: 1n }));
  assert.deepEqual(await runner.run(), { ...none, fired: 3, landed: 3, waited: 2 });
  assert.equal(session.calls.length, 3, "two for the owner at the budget, one for the other");
  assert.equal((await orders.get("other"))!.status, "done");
  const l2 = (await orders.get("l2"))!;
  assert.equal(l2.status, "open");
  assert.equal(l2.refusals, 0);
  assert.equal(l2.lastError, "that is 2 buys today from this account; the order waits for tomorrow");
  const d = (await orders.get("d"))!;
  assert.equal(d.remaining, 4, "a wait does not burn a buy");
  assert.equal(d.nextAt, new Date(clock.getTime() + HOUR).toISOString(), "a dca moves to its next slot");
  const said = () => telegram.sent.filter((o) => o.kind === "send" && /waits for tomorrow/.test((o as { text: string }).text)).length;
  assert.equal(said(), 2, "one line per order, once");
  // A fresh runner on the same store an hour on: the ledger remembers the day's sends.
  const again = new OrderRunner({ orders, links, reads: reads(1_500_000n), session: session.s, telegram, now: () => clock, dailyExecutes: 2 });
  assert.deepEqual(await again.run(new Date(clock.getTime() + HOUR)), { ...none, waited: 2 });
  assert.equal(session.calls.length, 3);
  assert.equal(said(), 2, "not said again");
  // The next UTC day: the budget is fresh.
  const tomorrow = new Date("2026-09-21T00:00:00Z");
  assert.deepEqual(await again.run(tomorrow), { ...none, fired: 2, landed: 2 });
  assert.equal((await orders.get("l2"))!.status, "done");
  assert.equal((await orders.get("d"))!.remaining, 3);
  // The gas budget the same way: three executes at the ceiling, and the fourth waits.
  const gas = setup(1_500_000n, { dailyGasWei: 700_000n * 1_000_000_000n * 3n });
  await linked(gas.links);
  for (let i = 0; i < 4; i++) await gas.orders.put(order({ id: `g${i}`, kind: "limit", triggerPerEth: 1n, createdAt: new Date(clock.getTime() + i).toISOString() }));
  assert.deepEqual(await gas.runner.run(), { ...none, fired: 3, landed: 3, waited: 1 });
  assert.equal((await gas.orders.get("g3"))!.lastError, "the bot has fronted its daily gas for this account; the order waits for tomorrow");
});

test("a runner sees only its own chain's orders", async () => {
  const { orders, links, session, runner } = setup();
  await linked(links);
  await orders.put(order({ id: "t", kind: "limit", triggerPerEth: 1n, chainId: 46630 }));
  assert.deepEqual(await runner.run(), none);
  assert.equal(session.calls.length, 0);
  assert.deepEqual((await orders.open(46630)).map((o) => o.id), ["t"]);
  assert.deepEqual(await orders.openFor("7", 4663), []);
});

/** A scripted sql: the statements are pinned, the rows answered. */
const fakeSql = (answer: (query: string, params: unknown[]) => readonly Record<string, unknown>[] | undefined) => {
  const calls: { query: string; params: unknown[] }[] = [];
  const sql: OrderSql & { calls: typeof calls } = {
    calls,
    async query(query, params = []) {
      calls.push({ query, params });
      if (/^(CREATE|ALTER)/.test(query.trim())) return [];
      const rows = answer(query, params);
      if (rows === undefined) throw new Error(`unexpected sql: ${query}`);
      return rows;
    },
  };
  return sql;
};

test("neon: the claim is one statement that takes only an open, unclaimed order and writes the ledger; settle and cancel land only on an open order; a put never touches the claim; reads are by chain", async () => {
  const sql = fakeSql((query, params) => {
    if (query.includes("INSERT INTO bot_orders")) return [];
    if (query.includes("WITH claimed AS (UPDATE bot_orders SET firing_at")) return params[0] === "open" ? [{ order_id: "open" }] : [];
    if (query.includes("UPDATE bot_orders SET remaining")) return params[0] === "open" ? [{ id: "open" }] : [];
    if (query.includes("UPDATE bot_orders SET status = 'cancelled'")) return params[0] === "open" ? [{ id: "open" }] : [];
    if (query.includes("SELECT COUNT(*)::int AS n FROM bot_order_fires")) return [{ n: 2 }];
    if (query.includes("SELECT * FROM bot_orders WHERE status = 'open'")) return [{ id: "open", tg_id: "7", account: ACCOUNT, chain_id: 4663, token: PEPE, kind: "limit", eth_wei: "10000000000000000", trigger_per_eth: "1", every_ms: null, remaining: null, next_at: null, created_at: clock.toISOString(), status: "open", last_error: null, refusals: 0, firing_at: clock.toISOString() }];
    return undefined;
  });
  const store = new NeonOrderStore(sql);
  await store.put(order({ id: "open", kind: "limit", triggerPerEth: 1n }));
  const put = sql.calls.find((c) => c.query.includes("INSERT INTO bot_orders"))!;
  assert.ok(!/firing_at/.test(put.query), "a put never sets or clears a claim");
  assert.equal(put.params[3], 4663, "the chain goes in");
  assert.equal(await store.claim("open", clock, undefined), true);
  assert.equal(await store.claim("gone", clock, undefined), false);
  const claim = sql.calls.find((c) => c.query.includes("WITH claimed"))!;
  assert.match(claim.query, /UPDATE bot_orders SET firing_at = \$2 WHERE id = \$1 AND status = 'open' AND firing_at IS NULL AND next_at IS NOT DISTINCT FROM \$3::timestamptz RETURNING/, "the claim names the slot: a dca another run moved on is not taken");
  assert.match(claim.query, /INSERT INTO bot_order_fires .* FROM claimed RETURNING/s);
  assert.deepEqual(claim.params, ["open", clock.toISOString(), null], "a limit has no slot");
  assert.equal(sql.calls.filter((c) => c.query.includes("bot_order_fires") && !/^(CREATE|ALTER)/.test(c.query.trim())).length, 2, "one statement per claim, no read first");
  await store.claim("open", clock, clock.toISOString());
  assert.equal(sql.calls.at(-1)!.params[2], clock.toISOString(), "a dca's slot goes in as read");
  assert.equal(await store.settle(order({ id: "open", kind: "limit", triggerPerEth: 1n, status: "done" })), true);
  assert.equal(await store.settle(order({ id: "cancelled", kind: "limit", triggerPerEth: 1n, status: "done" })), false);
  const settle = sql.calls.find((c) => c.query.includes("UPDATE bot_orders SET remaining"))!;
  assert.match(settle.query, /firing_at = NULL WHERE id = \$1 AND status = 'open' RETURNING id/);
  assert.equal(await store.cancel("open"), true);
  assert.equal(await store.cancel("cancelled"), false);
  assert.match(sql.calls.find((c) => c.query.includes("SET status = 'cancelled'"))!.query, /WHERE id = \$1 AND status = 'open' RETURNING id/);
  assert.equal(await store.firesSince("7", 4663, clock), 2);
  const [row] = await store.open(4663);
  assert.equal(row!.chainId, 4663);
  assert.equal(row!.firingAt, clock.toISOString());
  assert.deepEqual(sql.calls.find((c) => c.query.includes("SELECT * FROM bot_orders WHERE status = 'open'"))!.params, [4663]);
  await store.openFor("7", 46630);
  assert.deepEqual(sql.calls.at(-1)!.params, [46630, "7"]);
  const schema = sql.calls.filter((c) => /^(CREATE|ALTER)/.test(c.query.trim())).map((c) => c.query);
  assert.ok(schema.some((q) => q.includes("ADD COLUMN IF NOT EXISTS chain_id")) && schema.some((q) => q.includes("ADD COLUMN IF NOT EXISTS firing_at")), "a table from before is brought along");
});
