/**
 * Clean-account quickstart walk (FR-001 to FR-018, SC-001 to SC-010).
 *
 * Follows specs/001-fleet-mission/quickstart.md steps in order against a fresh
 * router, the way a first-time trader would. The on-chain preconditions (steps
 * 1-3) are represented by the same evidence-gated dependencies the service
 * uses; everything from step 4 on runs exactly as specified.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import { parseDependencyEvidence } from "../../src/fleet/dependency-evidence.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";
import type { PackedUserOperation, SubmitResult, UserOperationSubmitter } from "../../src/fleet/user-operation.js";

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const trader = privateKeyToAccount(`0x${"11".repeat(32)}`);
const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
const owner = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;
const salt = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const FUNDING = "1000000000000000";
const ACTUAL_COST = "120000000000";

class Ledger implements UserOperationSubmitter {
  tokenBalances = new Map<string, bigint>();
  operations: string[] = [];
  async submit(op: PackedUserOperation): Promise<SubmitResult> {
    this.operations.push(op.sender.toLowerCase());
    const key = op.sender.toLowerCase();
    this.tokenBalances.set(key, (this.tokenBalances.get(key) ?? 0n) + 1000n);
    return { userOpHash: `0x${"aa".repeat(32)}`, actualGasCost: ACTUAL_COST };
  }
}

const signed = async (service: CampaignService, action: string, body: Record<string, unknown>) => {
  const hash = payloadHash(body);
  const challenge = service.issueChallenge({ primaryWallet: trader.address, action, payloadHash: hash });
  const auth: AuthEnvelope = {
    primaryWallet: trader.address,
    nonce: challenge.nonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
    action, payloadHash: hash,
    signature: await trader.signMessage({
      message: challengeBytes(serviceConfig, {
        primaryWallet: trader.address,
        nonce: challenge.nonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
        action, payloadHash: hash,
      }),
    }),
  };
  return { action, auth, body };
};

let sequence = 0;
const key = () => `fleet-${(sequence++).toString().padStart(16, "0")}`;

test("the quickstart five-account journey holds end to end", async (t) => {
  const service = new CampaignService(serviceConfig);
  const ledger = new Ledger();
  const deps: RouterDeps = {
    service,
    feeConfig: { threshold: "1000", baseFee: "100", discount: "25", feeAsset: "ETH", recipient: owner(0xf1) },
    chitBalanceOf: async (wallet) => (wallet.toLowerCase() === trader.address.toLowerCase() ? "1000" : "0"),
    verifyFunding: async () => FUNDING,
    submitter: ledger,
  };
  const router = new CampaignRouter(deps);
  let campaign = "";

  await t.test("precondition: dependency evidence is valid and honestly labelled (FR-018)", async () => {
    const raw = JSON.parse(await readFile(join(repoRoot, "test/fleet/fixtures/dependency-evidence.json"), "utf8"));
    const evidence = parseDependencyEvidence(raw, new Date());
    assert.equal(evidence.chainId, 46630);
    assert.equal(evidence.allowedClaim, "test-only-fixture");
  });

  await t.test("step 1: the displayed quote matches the published facts (FR-003, SC-005)", async () => {
    const quote = await router.handle({ action: "quote", body: { primaryWallet: trader.address } });
    const body = quote.body as { threshold: string; netFee: string; eligible: boolean };
    assert.equal(body.threshold, "1000");
    assert.equal(body.netFee, "75");
    assert.equal(body.eligible, true);
  });

  await t.test("step 2: a five-account campaign with finite budget and bounded policy (FR-001, FR-004)", async () => {
    const create = await router.handle(await signed(service, "create", {
      quoteId: "q-1",
      policy: {
        chainId: 46630, accounts: 5, router: owner(0x88), function: "execute(bytes,bytes[],uint256)",
        maxTradeValue: "500000000000000", perAccountGas: "200000000000000",
        totalGas: "1000000000000000", expiry: "2026-12-31T00:00:00.000Z",
      },
      accounts: Array.from({ length: 5 }, (_, i) => ({ ownerAddress: owner(i + 1), salt: salt(i + 1) })),
      recoveryVaultCommitment: `0x${"3".repeat(64)}`,
    }), key());
    assert.equal(create.status, 201);
    campaign = (create.body as { campaign: string }).campaign;
  });

  await t.test("step 3: funding is blocked until recovery is confirmed (FR-006)", async () => {
    const early = await router.handle(await signed(service, "fund", { campaign, fundingReference: "tx-1" }), key());
    assert.equal(early.status, 409);
    const confirm = await router.handle(await signed(service, "confirmRecovery", { campaign, vaultConfirmed: true }), key());
    assert.equal((confirm.body as { state: string }).state, "Awaiting funding");
  });

  await t.test("step 4: fund, activate, and survive a reload without duplicates (SC-007)", async () => {
    await router.handle(await signed(service, "fund", { campaign, fundingReference: "tx-1" }), key());
    const activateKey = key();
    const first = await router.handle(await signed(service, "activate", { campaign }), activateKey);
    const replay = await router.handle(await signed(service, "activate", { campaign }), activateKey);
    assert.deepEqual(replay.body, first.body);
    assert.equal((first.body as { accounts: string[] }).accounts.length, 5);
  });

  await t.test("step 5: one sponsored buy per account; exact debit; no account ETH (SC-003, SC-004)", async () => {
    const buy = await router.handle(await signed(service, "buy", {
      campaign, accounts: Array.from({ length: 5 }, (_, i) => owner(i + 1)),
      token: owner(0x77), value: "400000000000000",
    }), key());
    const results = (buy.body as { results: { status: string; budget: { spent: string } }[] }).results;
    assert.equal(results.filter((r) => r.status === "sponsored").length, 5);
    assert.equal(results[4]!.budget.spent, (5n * BigInt(ACTUAL_COST)).toString());
    for (let i = 1; i <= 5; i += 1) assert.equal(ledger.tokenBalances.get(owner(i)), 1000n);
  });

  await t.test("step 6: public inspection shows the fleet, not the trader (SC-009)", async () => {
    assert.equal(ledger.operations.length, 5);
    assert.equal(ledger.operations.includes(trader.address.toLowerCase()), false);
  });

  await t.test("step 7: pause/resume, then revoke is terminal, then close refunds (SC-010, FR-016)", async () => {
    await router.handle(await signed(service, "pause", { campaign }), key());
    const paused = await router.handle(await signed(service, "buy", {
      campaign, accounts: [owner(1)], token: owner(0x77), value: "1",
    }), key());
    assert.equal(paused.status, 403);
    await router.handle(await signed(service, "resume", { campaign }), key());

    await router.handle(await signed(service, "revoke", { campaign }), key());
    const resume = await router.handle(await signed(service, "resume", { campaign }), key());
    assert.equal((resume.body as { code: string }).code, "revoked_terminal");

    const close = await router.handle(await signed(service, "close", { campaign }), key());
    assert.equal((close.body as { returnedEth: string }).returnedEth,
      (BigInt(FUNDING) - 5n * BigInt(ACTUAL_COST)).toString());
  });
});
