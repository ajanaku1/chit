import assert from "node:assert/strict";
import test from "node:test";

import { FleetClient, SdkError, type Transport, type TransportRequest } from "../../src/fleet/sdk.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

const auth = (action: string): AuthEnvelope => ({
  primaryWallet: `0x${"a".repeat(40)}`,
  nonce: "n-1",
  issuedAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2026-09-01T00:05:00.000Z",
  action,
  payloadHash: `0x${"0".repeat(64)}`,
  signature: `0x${"1".repeat(130)}`,
});

const key = `fleet-${"k".repeat(16)}`;

const makeClient = (respond?: (request: TransportRequest) => { status: number; body: unknown }) => {
  const sent: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    sent.push(request);
    return respond?.(request) ?? { status: 200, body: { campaign: "c-1", state: "Active", budget: { funded: "0", reserved: "0", spent: "0", unused: "0" } } };
  };
  return { client: new FleetClient(transport), sent };
};

test("signed requests serialize as { action, auth, body } with the key as a header only", async () => {
  const { client, sent } = makeClient();
  await client.fund({ auth: auth("fund"), idempotencyKey: key, body: { campaign: "c-1", fundingReference: "tx-1" } });

  assert.equal(sent.length, 1);
  const request = sent[0]!;
  assert.equal(request.route, "campaign");
  assert.equal(request.idempotencyKey, key);
  assert.deepEqual(Object.keys(request.payload).sort(), ["action", "auth", "body"]);
  assert.equal(JSON.stringify(request.payload).includes("idempotencyKey"), false, "the key never appears in JSON");
  assert.equal((request.payload as { action: string }).action, "fund");
});

test("the SDK refuses to send when the outer action disagrees with auth.action", async () => {
  const { client, sent } = makeClient();
  await assert.rejects(
    () => client.buy({ auth: auth("fund"), idempotencyKey: key, body: { campaign: "c-1", accounts: [], token: `0x${"7".repeat(40)}`, value: "1" } }),
    (error: unknown) => {
      assert.ok(error instanceof SdkError);
      assert.equal(error.reason, "action_mismatch");
      return true;
    },
  );
  assert.equal(sent.length, 0);
});

test("for control, the method argument is the only outer action and must match auth", async () => {
  const { client, sent } = makeClient();
  await client.control("pause", { auth: auth("pause"), idempotencyKey: key, body: { campaign: "c-1" } });
  assert.equal((sent[0]!.payload as { action: string }).action, "pause");
  assert.equal(sent[0]!.route, "control");

  await assert.rejects(
    () => client.control("revoke", { auth: auth("pause"), idempotencyKey: key, body: { campaign: "c-1" } }),
    (error: unknown) => error instanceof SdkError && error.reason === "action_mismatch",
  );
});

test("a malformed idempotency key is refused before transport", async () => {
  const { client, sent } = makeClient();
  await assert.rejects(
    () => client.activate({ auth: auth("activate"), idempotencyKey: "not-a-fleet-key", body: { campaign: "c-1" } }),
    (error: unknown) => error instanceof SdkError && error.reason === "malformed_idempotency_key",
  );
  assert.equal(sent.length, 0);
});

test("quote and challenge are unsigned and carry no idempotency key", async () => {
  const { client, sent } = makeClient((request) =>
    (request.payload as { action: string }).action === "quote"
      ? { status: 200, body: { quoteId: "q", threshold: "1", baseFee: "1", discount: "0", netFee: "1", eligible: true } }
      : { status: 200, body: { nonce: "n", issuedAt: "i", challenge: "c", expiresAt: "e", maxTtlSeconds: 300 } });
  await client.quote({ primaryWallet: `0x${"a".repeat(40)}` });
  await client.challenge({ primaryWallet: `0x${"a".repeat(40)}`, action: "create", payloadHash: `0x${"0".repeat(64)}` });
  for (const request of sent) {
    assert.equal(request.idempotencyKey, undefined);
    assert.equal("auth" in (request.payload as Record<string, unknown>), false);
  }
});

test("a server rejection surfaces its ApiError code and consumes nothing locally", async () => {
  const { client } = makeClient(() => ({ status: 422, body: { code: "budget_exceeded", retryable: false } }));
  await assert.rejects(
    () => client.buy({ auth: auth("buy"), idempotencyKey: key, body: { campaign: "c-1", accounts: [], token: `0x${"7".repeat(40)}`, value: "1" } }),
    (error: unknown) => {
      assert.ok(error instanceof SdkError);
      assert.equal(error.reason, "budget_exceeded");
      assert.equal(error.status, 422);
      return true;
    },
  );
});

test("once a campaign reports Revoked, the SDK refuses further buys locally (FR-013)", async () => {
  let revokeSeen = false;
  const { client, sent } = makeClient((request) => {
    const action = (request.payload as { action: string }).action;
    if (action === "revoke") revokeSeen = true;
    return {
      status: 200,
      body: { campaign: "c-1", state: revokeSeen ? "Revoked" : "Active", budget: { funded: "0", reserved: "0", spent: "0", unused: "0" } },
    };
  });

  await client.control("revoke", { auth: auth("revoke"), idempotencyKey: key, body: { campaign: "c-1" } });
  const before = sent.length;

  for (const attempt of [
    () => client.buy({ auth: auth("buy"), idempotencyKey: key, body: { campaign: "c-1", accounts: [], token: `0x${"7".repeat(40)}`, value: "1" } }),
    () => client.control("resume", { auth: auth("resume"), idempotencyKey: key, body: { campaign: "c-1" } }),
  ]) {
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof SdkError);
      assert.equal(error.reason, "revoked_terminal");
      return true;
    });
  }
  assert.equal(sent.length, before, "no request left the client after revocation");

  // Close is the one remaining permitted action.
  await client.control("close", { auth: auth("close"), idempotencyKey: key, body: { campaign: "c-1" } });
  assert.equal(sent.length, before + 1);
});
