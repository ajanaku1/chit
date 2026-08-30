import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";

import {
  CHALLENGE_VERSION,
  CampaignService,
  ServiceError,
  assertNoSecrets,
  canonicalJson,
  challengeBytes,
  isIdempotencyKey,
  payloadHash,
  redactForLog,
} from "../../src/fleet/campaign-service.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

const trader = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
const config = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
const now = new Date("2026-09-01T00:00:00.000Z");

const service = () => new CampaignService(config, { now: () => now });

const signedRequest = async (
  overrides: { action?: string; body?: Record<string, unknown>; signWith?: typeof trader; authAction?: string } = {},
) => {
  const instance = service();
  const action = overrides.action ?? "create";
  const body = overrides.body ?? { campaign: "handle" };
  const hash = payloadHash(body);
  const challenge = instance.issueChallenge({ primaryWallet: trader.address, action, payloadHash: hash });
  const auth: AuthEnvelope = {
    primaryWallet: (overrides.signWith ?? trader).address,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    action: overrides.authAction ?? action,
    payloadHash: hash,
    signature: await (overrides.signWith ?? trader).signMessage({
      message: challengeBytes(config, {
        primaryWallet: (overrides.signWith ?? trader).address,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
        action: overrides.authAction ?? action,
        payloadHash: hash,
      }),
    }),
  };
  return { instance, action, body, auth };
};

const rejects = async (run: () => Promise<unknown>, code: ServiceError["code"]): Promise<string> => {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, code);
    return error.reason;
  }
  return assert.fail(`expected ${code}`);
};

test("canonical JSON sorts every object key and adds no whitespace", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } }), '{"a":{"c":[3,1],"d":2},"b":1}');
  assert.equal(payloadHash({ a: 1, b: 2 }), payloadHash({ b: 2, a: 1 }));
  assert.notEqual(payloadHash({ a: 1 }), payloadHash({ a: 2 }));
});

test("challenge bytes are the versioned ordered ASCII fields", () => {
  const bytes = challengeBytes(config, {
    primaryWallet: trader.address,
    nonce: "n",
    issuedAt: "i",
    expiresAt: "e",
    action: "create",
    payloadHash: `0x${"0".repeat(64)}`,
  });
  assert.deepEqual(bytes.split("|"), [
    CHALLENGE_VERSION,
    config.origin,
    String(config.chainId),
    trader.address.toLowerCase(),
    "n",
    "i",
    "e",
    "create",
    `0x${"0".repeat(64)}`,
  ]);
});

test("a challenge carries the configured maximum TTL and a single-use nonce", async () => {
  const instance = service();
  const first = instance.issueChallenge({ primaryWallet: trader.address, action: "create", payloadHash: payloadHash({}) });
  const second = instance.issueChallenge({ primaryWallet: trader.address, action: "create", payloadHash: payloadHash({}) });

  assert.equal(first.maxTtlSeconds, config.maxTtlSeconds);
  assert.notEqual(first.nonce, second.nonce);
  assert.equal(Date.parse(first.expiresAt) - Date.parse(first.issuedAt), config.maxTtlSeconds * 1000);
});

test("a correctly signed request verifies once and never again", async () => {
  const { instance, action, body, auth } = await signedRequest();
  assert.equal(await instance.verify(action, { auth, body }), trader.address.toLowerCase());
  assert.equal(await rejects(() => instance.verify(action, { auth, body }), "challenge_invalid"), "nonce_used");
});

test("an outer action that disagrees with the envelope is refused before signature recovery", async () => {
  const { instance, body, auth } = await signedRequest({ action: "create", authAction: "create" });
  assert.equal(await rejects(() => instance.verify("revoke", { auth, body }), "challenge_invalid"), "action_mismatch");
});

test("a changed body is refused because its canonical hash no longer matches", async () => {
  const { instance, action, auth } = await signedRequest({ body: { campaign: "handle" } });
  assert.equal(
    await rejects(() => instance.verify(action, { auth, body: { campaign: "other" } }), "challenge_invalid"),
    "payload_hash_mismatch",
  );
});

test("a wrong signer, an unknown nonce, and an expired envelope are all refused", async () => {
  const wrongSigner = await signedRequest({ signWith: stranger });
  assert.equal(
    await rejects(
      () => wrongSigner.instance.verify(wrongSigner.action, { auth: { ...wrongSigner.auth, primaryWallet: trader.address }, body: wrongSigner.body }),
      "challenge_invalid",
    ),
    "signature_mismatch",
  );

  const unknown = await signedRequest();
  assert.equal(
    await rejects(
      () => unknown.instance.verify(unknown.action, { auth: { ...unknown.auth, nonce: "not-issued" }, body: unknown.body }),
      "challenge_invalid",
    ),
    "nonce_unknown",
  );

  const expired = await signedRequest();
  const late = new CampaignService(config, { now: () => new Date("2026-09-01T00:10:00.000Z") });
  assert.equal(
    await rejects(() => late.verify(expired.action, { auth: expired.auth, body: expired.body }), "challenge_invalid"),
    "nonce_unknown",
  );
});

test("idempotency keys follow the API format and are scoped to wallet, action, and campaign", async () => {
  assert.ok(isIdempotencyKey(`fleet-${"a".repeat(16)}`));
  assert.equal(isIdempotencyKey(`fleet-${"a".repeat(15)}`), false);
  assert.equal(isIdempotencyKey(`fleet-${"a".repeat(129)}`), false);
  assert.equal(isIdempotencyKey(`other-${"a".repeat(16)}`), false);
  assert.equal(isIdempotencyKey("fleet-has spaces here!!!!"), false);

  const instance = service();
  const scope = { primaryWallet: trader.address, action: "create", campaign: "handle" };
  const key = `fleet-${"a".repeat(16)}`;
  let runs = 0;
  const run = async () => {
    runs += 1;
    return { campaign: "handle", state: "Draft" as const };
  };

  const first = await instance.runIdempotent(key, scope, { policy: 1 }, run);
  const second = await instance.runIdempotent(key, scope, { policy: 1 }, run);
  assert.deepEqual(first, second);
  assert.equal(runs, 1);

  assert.equal(
    await rejects(() => instance.runIdempotent(key, scope, { policy: 2 }, run), "idempotency_conflict"),
    "payload_changed",
  );
  assert.equal(
    await rejects(() => instance.runIdempotent("fleet-bad", scope, { policy: 1 }, run), "idempotency_conflict"),
    "malformed_key",
  );

  await instance.runIdempotent(key, { ...scope, action: "fund" }, { policy: 1 }, run);
  assert.equal(runs, 2);
});

test("a rejected request consumes neither a fee nor campaign ETH", async () => {
  const instance = service();
  const scope = { primaryWallet: trader.address, action: "create", campaign: "handle" };
  const key = `fleet-${"b".repeat(16)}`;
  let runs = 0;

  await assert.rejects(async () =>
    instance.runIdempotent(key, scope, { policy: 1 }, async () => {
      runs += 1;
      throw new ServiceError("policy_rejected", "declined");
    }),
  );
  await assert.rejects(async () =>
    instance.runIdempotent(key, scope, { policy: 1 }, async () => {
      runs += 1;
      throw new ServiceError("policy_rejected", "declined");
    }),
  );
  assert.equal(runs, 2, "a failed action is retryable and records no result");
});

test("logs and responses never carry credential, recovery, or primary-to-fleet material", () => {
  const redacted = redactForLog({
    campaign: "handle",
    auth: { primaryWallet: trader.address, signature: "0xdead" },
    accounts: [{ ownerAddress: `0x${"1".repeat(40)}`, privateKey: `0x${"2".repeat(64)}` }],
    mapping: { primaryWallet: trader.address, fleet: [`0x${"1".repeat(40)}`] },
    payloadCiphertext: "0xbeef",
  }) as Record<string, unknown>;

  const serialized = JSON.stringify(redacted);
  for (const leaked of ["0xdead", "0x" + "2".repeat(64), "0xbeef"]) {
    assert.equal(serialized.includes(leaked), false, `redaction leaked ${leaked}`);
  }
  assert.equal(serialized.includes("[redacted]"), true);
  assert.equal(redacted["campaign"], "handle");

  assert.throws(() => assertNoSecrets({ accounts: [{ privateKey: "0x00" }] }), /forbidden_field:privateKey/);
  assert.throws(() => assertNoSecrets({ payloadCiphertext: "0x00" }), /forbidden_field:payloadCiphertext/);
  assert.doesNotThrow(() => assertNoSecrets({ campaign: "handle", recoveryVaultCommitment: `0x${"3".repeat(64)}` }));
});
