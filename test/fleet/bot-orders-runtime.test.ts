/** The orders route: the cron's bearer or nothing, no secret means no pass, one pass answers with what it fired; BOT_ORDERS_OFF stops the clock; the chain must be one of ours. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex, parseEther } from "viem";
import type { BotChain } from "../../src/fleet/bot-chain.js";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import { MemoryOrderStore } from "../../src/fleet/bot-orders.js";
import { handleOrdersRequest, setOrdersDepsForTests } from "../../src/fleet/bot-orders-runtime.js";
import type { SessionChain } from "../../src/fleet/bot-session-chain.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";

const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address;
const clock = new Date("2026-09-20T12:00:00Z");
const req = (auth?: string) => new Request("https://chit.tools/api/bot/orders", { headers: auth ? { authorization: auth } : {} });

test("no CRON_SECRET, no pass; the wrong bearer is 401; the right one runs once and reports", async () => {
  const orders = new MemoryOrderStore();
  const links = new MemoryBotLinkStore();
  const telegram = new RecordingTelegram();
  const executed: bigint[] = [];
  const session = {
    chainId: 4663, signer: "0x00000000000000000000000000000000000000b0",
    async canExecute() { return { ok: true, why: "" }; },
    async execute(_a: Address, _t: Address, value: bigint) { executed.push(value); return { hash: ("0x" + "cd".repeat(32)) as Hex, landed: true }; },
  } as unknown as SessionChain;
  const reads = {
    router: "0x8876789976decbfcbbbe364623c63652db8c0904",
    async tokenInfo() { return { symbol: "PEPE", decimals: 6, hasPool: true, perEth: 2_000_000n }; },
    async quoteBuy(_t: Address, ethIn: bigint) { return (ethIn * 2_000_000n) / 10n ** 18n; },
  } as unknown as BotChain;
  setOrdersDepsForTests({ orders, links, session, telegram, reads });
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal((await handleOrdersRequest(req("Bearer anything"), clock)).status, 401, "an unset secret is a refusal, not an open route");
    process.env.CRON_SECRET = "s3cret-s3cret-s3cret";
    assert.equal((await handleOrdersRequest(req("Bearer wrong"), clock)).status, 401);
    await links.putLink({ tgId: "7", account: ACCOUNT, owner: ACCOUNT, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });
    await orders.put({ id: "l", tgId: "7", account: ACCOUNT, chainId: 4663, token: PEPE, kind: "limit", ethWei: parseEther("0.01"), triggerPerEth: 1_000_000n, createdAt: clock.toISOString(), status: "open", refusals: 0 });
    const r = await handleOrdersRequest(req("Bearer s3cret-s3cret-s3cret"), clock);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { state: "ran", fired: 1, landed: 1, refused: 0, waited: 0 });
    assert.deepEqual(executed, [parseEther("0.01")]);
    assert.match(telegram.last(), /landed/);
  } finally {
    if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    setOrdersDepsForTests({});
  }
});

test("BOT_ORDERS_OFF=1 stops the clock: the route answers off and acts on no order; a chain that is not ours is a configuration fault", async () => {
  const orders = new MemoryOrderStore();
  const links = new MemoryBotLinkStore();
  const telegram = new RecordingTelegram();
  const executed: bigint[] = [];
  const session = {
    chainId: 4663, signer: "0x00000000000000000000000000000000000000b0",
    async canExecute() { return { ok: true, why: "" }; },
    async execute(_a: Address, _t: Address, value: bigint) { executed.push(value); return { hash: ("0x" + "cd".repeat(32)) as Hex, landed: true }; },
  } as unknown as SessionChain;
  const reads = {
    router: "0x8876789976decbfcbbbe364623c63652db8c0904",
    async tokenInfo() { return { symbol: "PEPE", decimals: 6, hasPool: true, perEth: 2_000_000n }; },
    async quoteBuy(_t: Address, ethIn: bigint) { return (ethIn * 2_000_000n) / 10n ** 18n; },
  } as unknown as BotChain;
  setOrdersDepsForTests({ orders, links, session, telegram, reads });
  const saved = { secret: process.env.CRON_SECRET, off: process.env.BOT_ORDERS_OFF, chain: process.env.BOT_ORDERS_CHAIN_ID };
  process.env.CRON_SECRET = "s3cret-s3cret-s3cret";
  try {
    await links.putLink({ tgId: "7", account: ACCOUNT, owner: ACCOUNT, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });
    await orders.put({ id: "d", tgId: "7", account: ACCOUNT, chainId: 4663, token: PEPE, kind: "dca", ethWei: parseEther("0.05"), everyMs: 4 * 3_600_000, remaining: 20, nextAt: clock.toISOString(), createdAt: clock.toISOString(), status: "open", refusals: 0 });
    process.env.BOT_ORDERS_OFF = "1";
    const off = await handleOrdersRequest(req("Bearer s3cret-s3cret-s3cret"), clock);
    assert.equal(off.status, 200);
    assert.deepEqual(await off.json(), { state: "off" });
    assert.deepEqual(executed, [], "the switch that hides the buttons also stops the executes");
    assert.equal((await orders.get("d"))!.remaining, 20);
    assert.equal((await handleOrdersRequest(req("Bearer wrong"), clock)).status, 401, "the bearer is still checked first");
    delete process.env.BOT_ORDERS_OFF;
    process.env.BOT_ORDERS_CHAIN_ID = "1";
    setOrdersDepsForTests({ orders, links, session, telegram, reads });
    const bad = await handleOrdersRequest(req("Bearer s3cret-s3cret-s3cret"), clock);
    assert.equal(bad.status, 503);
    assert.match(((await bad.json()) as { reason: string }).reason, /BOT_ORDERS_CHAIN_ID must be 4663/);
    assert.deepEqual(executed, []);
  } finally {
    for (const [k, v] of [["CRON_SECRET", saved.secret], ["BOT_ORDERS_OFF", saved.off], ["BOT_ORDERS_CHAIN_ID", saved.chain]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    setOrdersDepsForTests({});
  }
});
