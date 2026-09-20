/** The orders route: the cron's bearer or nothing, no secret means no pass, one pass answers with what it fired. */

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
    await orders.put({ id: "l", tgId: "7", account: ACCOUNT, token: PEPE, kind: "limit", ethWei: parseEther("0.01"), triggerPerEth: 1_000_000n, createdAt: clock.toISOString(), status: "open", refusals: 0 });
    const r = await handleOrdersRequest(req("Bearer s3cret-s3cret-s3cret"), clock);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { state: "ran", fired: 1, landed: 1, refused: 0 });
    assert.deepEqual(executed, [parseEther("0.01")]);
    assert.match(telegram.last(), /landed/);
  } finally {
    if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    setOrdersDepsForTests({});
  }
});
