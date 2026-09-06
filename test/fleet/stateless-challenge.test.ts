import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignService, ServiceError, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

/**
 * Serverless functions share no memory: the instance that issues a challenge
 * is rarely the one that verifies it. With a shared secret the nonce is an
 * HMAC over the signed fields, so any instance verifies it, and tampering
 * with the issue time or the expiry is refused.
 */
describe("Stateless challenges across service instances", () => {
  const config = { origin: "https://chit.tools", chainId: 46630, maxTtlSeconds: 300 };
  const owner = privateKeyToAccount(`0x${"7".repeat(64)}`);
  const body = { campaign: "c-1", accounts: [owner.address], token: "0x0000000000000000000000000000000000000001", value: "1" };

  const signedBy = async (issuer: CampaignService, action = "buy", at = new Date("2026-09-06T00:00:00Z")) => {
    const hash = payloadHash(body);
    const c = issuer.issueChallenge({ primaryWallet: owner.address, action, payloadHash: hash });
    const fields = { primaryWallet: owner.address, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt, action, payloadHash: hash };
    const signature = await owner.signMessage({ message: challengeBytes(config, fields) });
    void at;
    return { ...fields, signature } as AuthEnvelope;
  };

  it("a challenge issued by one instance verifies on another holding the same secret", async () => {
    const a = new CampaignService(config, { nonceSecret: "s3cret", now: () => new Date("2026-09-06T00:00:00Z") });
    const b = new CampaignService(config, { nonceSecret: "s3cret", now: () => new Date("2026-09-06T00:01:00Z") });
    const auth = await signedBy(a);
    assert.equal(await b.verify("buy", { auth, body }), owner.address.toLowerCase());
  });

  it("a different secret, a shifted issue time, or a stretched expiry is refused", async () => {
    const a = new CampaignService(config, { nonceSecret: "s3cret", now: () => new Date("2026-09-06T00:00:00Z") });
    const other = new CampaignService(config, { nonceSecret: "different", now: () => new Date("2026-09-06T00:00:30Z") });
    const auth = await signedBy(a);
    await assert.rejects(other.verify("buy", { auth, body }), (e: ServiceError) => e.reason === "nonce_unknown");

    const b = new CampaignService(config, { nonceSecret: "s3cret", now: () => new Date("2026-09-06T00:00:30Z") });
    const shifted = { ...auth, issuedAt: "2026-09-06T00:00:10.000Z" };
    await assert.rejects(b.verify("buy", { auth: shifted, body }), (e: ServiceError) => e.reason === "nonce_unknown");
    const stretched = { ...auth, expiresAt: "2026-09-07T00:00:00.000Z" };
    await assert.rejects(b.verify("buy", { auth: stretched, body }), (e: ServiceError) => e.reason === "expiry_mismatch");
  });

  it("expires after the TTL on any instance, and the issuing instance refuses a replay", async () => {
    const a = new CampaignService(config, { nonceSecret: "s3cret", now: () => new Date("2026-09-06T00:00:00Z") });
    const auth = await signedBy(a);
    const late = new CampaignService(config, { nonceSecret: "s3cret", now: () => new Date("2026-09-06T00:05:00Z") });
    await assert.rejects(late.verify("buy", { auth, body }), (e: ServiceError) => e.reason === "challenge_expired");
    await a.verify("buy", { auth, body });
    await assert.rejects(a.verify("buy", { auth, body }), (e: ServiceError) => e.reason === "nonce_used");
  });

  it("without a secret, nonces stay random and instance-local as before", async () => {
    const a = new CampaignService(config);
    const b = new CampaignService(config);
    const auth = await signedBy(a);
    await assert.rejects(b.verify("buy", { auth, body }), (e: ServiceError) => e.reason === "nonce_unknown");
    await a.verify("buy", { auth, body });
  });
});
