/**
 * Standing orders: due() picks a limit when the pool crosses its price and
 * a dca when its time has come; the runner fires each as one execute inside
 * the session, moves a dca along and closes a limit, keeps a refused order
 * open with the reason and fails it after three in a row, never sends more
 * than its cap in one pass, and tells the owner every time.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex, parseEther } from "viem";
import type { BotChain } from "../../src/fleet/bot-chain.js";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import { MemoryOrderStore, OrderRunner, due, type Order } from "../../src/fleet/bot-orders.js";
import type { SessionChain } from "../../src/fleet/bot-session-chain.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR } from "../../src/fleet/v4-swap.js";

const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address;
const OWNER = "0x0000000000000000000000000000000000000011" as Address;
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
const clock = new Date("2026-09-20T12:00:00Z");
const HOUR = 3_600_000;

const order = (p: Partial<Order> & { id: string; kind: Order["kind"] }): Order => ({
  tgId: "7", account: ACCOUNT, token: PEPE, ethWei: parseEther("0.01"), createdAt: clock.toISOString(), status: "open", refusals: 0, ...p,
});

test("due: a limit fires when the pool gives at least its tokens per eth, a dca when its next time has passed, nothing else", () => {
  const limit = order({ id: "l", kind: "limit", triggerPerEth: 1_200_000n });
  const dca = order({ id: "d", kind: "dca", everyMs: 4 * HOUR, remaining: 6, nextAt: clock.toISOString() });
  const later = order({ id: "d2", kind: "dca", everyMs: 4 * HOUR, remaining: 6, nextAt: new Date(clock.getTime() + 1).toISOString() });
  const spent = order({ id: "d3", kind: "dca", everyMs: 4 * HOUR, remaining: 0, nextAt: clock.toISOString() });
  const closed = order({ id: "c", kind: "limit", triggerPerEth: 1n, status: "cancelled" });
  const all = [limit, dca, later, spent, closed];
  assert.deepEqual(due(all, clock, () => 1_199_999n).map((o) => o.id), ["d"], "price below the level: only the dca");
  assert.deepEqual(due(all, clock, () => 1_200_000n).map((o) => o.id), ["l", "d"], "at the level: the limit fires");
  assert.deepEqual(due(all, clock, () => undefined).map((o) => o.id), ["d"], "no price: no limit");
  assert.deepEqual(due(all, new Date(clock.getTime() + 1), () => 0n).map((o) => o.id), ["d", "d2"]);
});

const reads = (perEth: bigint) => ({
  chainId: 4663, router: ROUTER,
  async tokenInfo(token: Address) { return { address: token, symbol: "PEPE", decimals: 6, hasPool: true, perEth, poolEth: parseEther("5"), hooked: false, fee: 3000 }; },
  async quoteBuy(_t: Address, ethIn: bigint) { return (ethIn * perEth) / 10n ** 18n; },
} as unknown as BotChain);

const fakeSession = () => {
  const calls: { account: Address; value: bigint; data: Hex }[] = [];
  let refuse: string | null = null;
  const s: SessionChain = {
    chainId: 4663, signer: "0x00000000000000000000000000000000000000b0",
    async ownerOf() { return OWNER; },
    async sessionOf() { throw new Error("not read here"); },
    async canExecute() { return refuse ? { ok: false, why: refuse } : { ok: true, why: "" }; },
    async execute(account, _t, value, data) { calls.push({ account, value, data }); return { hash: ("0x" + "ab".repeat(32)) as Hex, landed: true }; },
    async signerBalance() { return parseEther("1"); },
  };
  return { s, calls, refuseWith: (why: string | null) => { refuse = why; } };
};

const setup = (perEth = 1_500_000n, maxPerRun?: number) => {
  const orders = new MemoryOrderStore();
  const links = new MemoryBotLinkStore();
  const session = fakeSession();
  const telegram = new RecordingTelegram();
  const runner = new OrderRunner({ orders, links, reads: reads(perEth), session: session.s, telegram, now: () => clock, ...(maxPerRun ? { maxPerRun } : {}) });
  return { orders, links, session, telegram, runner };
};
const linked = (links: MemoryBotLinkStore, account = ACCOUNT) => links.putLink({ tgId: "7", account, owner: OWNER, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });

test("a limit that fires is one execute on the account with the router's selector, then done; the owner gets the hash", async () => {
  const { orders, links, session, telegram, runner } = setup();
  await linked(links);
  await orders.put(order({ id: "l", kind: "limit", triggerPerEth: 1_200_000n }));
  assert.deepEqual(await runner.run(), { fired: 1, landed: 1, refused: 0 });
  assert.equal(session.calls.length, 1);
  assert.equal(session.calls[0]!.account, ACCOUNT);
  assert.equal(session.calls[0]!.value, parseEther("0.01"));
  assert.ok(session.calls[0]!.data.startsWith(UNIVERSAL_ROUTER_EXECUTE_SELECTOR));
  assert.equal((await orders.get("l"))!.status, "done");
  assert.match(telegram.last(), /limit buy: <code>0.01 ETH<\/code> into <b>PEPE<\/b> landed, <a href="https:\/\/robinhoodchain\.blockscout\.com\/tx\/0xabab/);
  assert.equal((telegram.sent[0] as { chatId: string }).chatId, "7", "told in the owner's private chat");
  assert.deepEqual(await runner.run(), { fired: 0, landed: 0, refused: 0 }, "done is done");
});

test("a dca buys, counts down and sets its next time one interval on; the last buy closes it", async () => {
  const { orders, links, session, telegram, runner } = setup();
  await linked(links);
  await orders.put(order({ id: "d", kind: "dca", everyMs: 4 * HOUR, remaining: 2, nextAt: clock.toISOString() }));
  assert.deepEqual(await runner.run(), { fired: 1, landed: 1, refused: 0 });
  let d = (await orders.get("d"))!;
  assert.equal(d.remaining, 1);
  assert.equal(d.nextAt, new Date(clock.getTime() + 4 * HOUR).toISOString());
  assert.equal(d.status, "open");
  assert.match(telegram.last(), /dca: .* landed, .* 1 left\./);
  assert.deepEqual(await runner.run(clock), { fired: 0, landed: 0, refused: 0 }, "not due again until the interval passes");
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
  assert.deepEqual(await runner.run(), { fired: 1, landed: 0, refused: 1 });
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
  assert.deepEqual(await runner.run(clock), { fired: 0, landed: 0, refused: 0 });
  await runner.run(new Date(clock.getTime() + HOUR));
  await runner.run(new Date(clock.getTime() + 2 * HOUR));
  d = (await orders.get("d"))!;
  assert.equal(d.status, "failed");
  assert.equal(d.refusals, 3);
  assert.match(telegram.last(), /3 refusals in a row, so the order is off/);
  assert.equal(session.calls.length, 1, "no execute on any refusal");
});

test("an order placed from an account the telegram no longer links to is refused, not fired from the new account", async () => {
  const { orders, links, session, runner } = setup();
  await linked(links, "0x00000000000000000000000000000000000000bb");
  await orders.put(order({ id: "l", kind: "limit", triggerPerEth: 1n }));
  assert.deepEqual(await runner.run(), { fired: 1, landed: 0, refused: 1 });
  assert.equal(session.calls.length, 0);
  assert.match((await orders.get("l"))!.lastError ?? "", /no longer linked/);
});

test("one pass sends at most its cap of executes; the rest wait for the next pass, oldest first", async () => {
  const { orders, links, session, runner } = setup(1_500_000n, 3);
  await linked(links);
  for (let i = 0; i < 5; i++) await orders.put(order({ id: `l${i}`, kind: "limit", triggerPerEth: 1n, createdAt: new Date(clock.getTime() + i).toISOString() }));
  assert.deepEqual(await runner.run(), { fired: 3, landed: 3, refused: 0 });
  assert.equal(session.calls.length, 3);
  assert.deepEqual((await orders.open()).map((o) => o.id), ["l3", "l4"]);
  assert.deepEqual(await runner.run(), { fired: 2, landed: 2, refused: 0 });
  assert.equal((await orders.open()).length, 0);
});
