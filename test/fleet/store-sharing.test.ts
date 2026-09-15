/**
 * Two service instances, one store. What the store makes true that memory
 * could not: a replay refused on the instance that did not verify it first,
 * and a retried action answered from the record another instance wrote.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignService, ServiceError, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import { createMemoryStore } from "../../src/fleet/store.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

describe("Two instances sharing one store", () => {
  const config = { origin: "https://chit.tools", chainId: 46630, maxTtlSeconds: 300 };
  const owner = privateKeyToAccount(`0x${"7".repeat(64)}`);
  const body = { campaign: "c-1", accounts: [owner.address], token: "0x0000000000000000000000000000000000000001", value: "1" };
  const KEY = "fleet-3f2b9c4e7d1a4b8e9c6d";
  const at = (s: number) => () => new Date(Date.UTC(2026, 8, 6, 0, 0, s));

  const signedBy = async (issuer: CampaignService, action = "buy") => {
    const hash = payloadHash(body);
    const c = issuer.issueChallenge({ primaryWallet: owner.address, action, payloadHash: hash });
    const fields = { primaryWallet: owner.address, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt, action, payloadHash: hash };
    return { ...fields, signature: await owner.signMessage({ message: challengeBytes(config, fields) }) } as AuthEnvelope;
  };

  it("a challenge verified on one instance is a replay on the other", async () => {
    const store = createMemoryStore();
    const a = new CampaignService(config, { nonceSecret: "s3cret", now: at(0), store });
    const b = new CampaignService(config, { nonceSecret: "s3cret", now: at(30), store });
    const auth = await signedBy(a);
    await a.verify("buy", { auth, body });
    await assert.rejects(b.verify("buy", { auth, body }), (e: ServiceError) => e.reason === "nonce_used");
  });

  it("a bad signature does not burn the nonce for the real signer", async () => {
    const store = createMemoryStore();
    const a = new CampaignService(config, { nonceSecret: "s3cret", now: at(0), store });
    const auth = await signedBy(a);
    const impostor = privateKeyToAccount(`0x${"8".repeat(64)}`);
    const forged = { ...auth, signature: await impostor.signMessage({ message: challengeBytes(config, auth) }) };
    await assert.rejects(a.verify("buy", { auth: forged, body }), (e: ServiceError) => e.reason === "signature_mismatch");
    assert.equal(await a.verify("buy", { auth, body }), owner.address.toLowerCase());
  });

  it("a retry that lands on the other instance is answered, not re-run", async () => {
    const store = createMemoryStore();
    const a = new CampaignService(config, { store });
    const b = new CampaignService(config, { store });
    const scope = { primaryWallet: owner.address, action: "create", campaign: "new" };
    let runs = 0;
    const work = async () => { runs += 1; return { status: 200, body: { run: runs } }; };
    const first = await a.runIdempotent(KEY, scope, body, work);
    const second = await b.runIdempotent(KEY, scope, body, work);
    assert.deepEqual(second, first);
    assert.equal(runs, 1);
    await assert.rejects(
      b.runIdempotent(KEY, scope, { ...body, value: "2" }, work),
      (e: ServiceError) => e.reason === "payload_changed",
    );
  });
});
