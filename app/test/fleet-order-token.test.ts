import assert from "node:assert/strict";
import test from "node:test";

/**
 * A placed order is the trader's signature for every slice in it, so polling
 * it must not open the wallet again. The service's order token stands in; a
 * poll signs only when the service refuses that token, and never retries a
 * poll whose reply was lost, because its slices may already have run.
 */

type Sent = { url: string; payload: Record<string, unknown>; headers: Record<string, string> };
const sent: Sent[] = [];
const walletCalls: string[] = [];
let refuseSignature = false;
let reply: (payload: Record<string, unknown>) => { status: number; body: Record<string, unknown> } | "drop";

Object.assign(globalThis, {
  document: { getElementById: () => null },
  window: {
    ethereum: {
      request: async ({ method }: { method: string }) => {
        walletCalls.push(method);
        if (refuseSignature) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        return `0x${"11".repeat(65)}`;
      },
    },
    addEventListener: () => undefined,
    dispatchEvent: () => true,
  },
  fetch: async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    sent.push({ url, payload, headers: init.headers });
    const answer = reply(payload);
    if (answer === "drop") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  },
});

const { orderTrade, RequestFailed, SignatureMissing } = await import("../src/fleet/signed-request.js");

const WALLET = "0x00000000000000000000000000000000000000aa" as const;
const BODY = { campaign: "c1", order: { id: "0x01", owner: WALLET }, pending: [0, 1] };
const CHALLENGE = { challenge: "sign me", nonce: "n", issuedAt: "2026-09-16T00:00:00Z", expiresAt: "2026-09-16T00:05:00Z" };

test.beforeEach(() => {
  sent.length = 0;
  walletCalls.length = 0;
  refuseSignature = false;
});

test("with a token, a poll goes straight to the trade route and the wallet is not asked", async () => {
  reply = () => ({ status: 200, body: { executed: [{ index: 0, status: "sponsored" }] } });
  const result = await orderTrade(WALLET, "123.abc", BODY, { sign: true });
  assert.deepEqual(result["executed"], [{ index: 0, status: "sponsored" }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, "/api/fleet/trade");
  assert.equal(sent[0]!.payload["orderToken"], "123.abc");
  assert.equal(sent[0]!.payload["auth"], undefined);
  assert.match(sent[0]!.headers["idempotency-key"] ?? "", /^fleet-trade/);
  assert.deepEqual(walletCalls, []);
});

test("an order placed before tokens existed still polls, with a signature", async () => {
  reply = (payload) => (payload["action"] === "challenge" ? { status: 200, body: CHALLENGE } : { status: 200, body: { executed: [] } });
  await orderTrade(WALLET, undefined, BODY, { sign: true });
  assert.deepEqual(sent.map((s) => s.payload["action"]), ["challenge", "trade"]);
  assert.ok(sent[1]!.payload["auth"], "the poll went out unsigned");
  assert.deepEqual(walletCalls, ["personal_sign"]);
});

test("a refused token falls back to one signed poll", async () => {
  reply = (payload) => {
    if (payload["action"] === "challenge") return { status: 200, body: CHALLENGE };
    if (payload["orderToken"]) return { status: 401, body: { code: "challenge_invalid", reason: "order_token_expired" } };
    return { status: 200, body: { executed: [{ index: 1, status: "sponsored" }] } };
  };
  const result = await orderTrade(WALLET, "123.abc", BODY, { sign: true });
  assert.deepEqual(result["executed"], [{ index: 1, status: "sponsored" }]);
  assert.deepEqual(sent.map((s) => s.payload["action"]), ["trade", "challenge", "trade"]);
  assert.deepEqual(walletCalls, ["personal_sign"]);
});

test("any other refusal is reported as it is, without a signature", async () => {
  reply = () => ({ status: 400, body: { code: "order_tampered" } });
  await assert.rejects(orderTrade(WALLET, "123.abc", BODY, { sign: true }), (error: unknown) => error instanceof RequestFailed && error.code === "order_tampered");
  assert.equal(sent.length, 1);
  assert.deepEqual(walletCalls, []);
});

test("a lost reply is never re-sent, signed or not: its slices may already have run", async () => {
  reply = () => "drop";
  await assert.rejects(orderTrade(WALLET, "123.abc", BODY, { sign: true }), TypeError);
  assert.equal(sent.length, 1);
  assert.deepEqual(walletCalls, []);
});

test("a background poll never opens the wallet: a refused or missing token leaves the order waiting", async () => {
  reply = (payload) => (payload["orderToken"] ? { status: 401, body: { code: "challenge_invalid", reason: "order_token_expired" } } : { status: 200, body: CHALLENGE });
  await assert.rejects(orderTrade(WALLET, "123.abc", BODY, { sign: false }), SignatureMissing);
  await assert.rejects(orderTrade(WALLET, undefined, BODY, { sign: false }), SignatureMissing);
  assert.deepEqual(sent.map((s) => s.payload["action"]), ["trade"], "only the token poll went out");
  assert.deepEqual(walletCalls, []);
});

test("a signature the trader refuses is reported as not sent, never as a lost reply", async () => {
  refuseSignature = true;
  reply = (payload) => (payload["action"] === "challenge" ? { status: 200, body: CHALLENGE } : { status: 200, body: { executed: [] } });
  await assert.rejects(orderTrade(WALLET, undefined, BODY, { sign: true }), SignatureMissing);
  assert.deepEqual(sent.map((s) => s.payload["action"]), ["challenge"], "the trade itself never left");
});
