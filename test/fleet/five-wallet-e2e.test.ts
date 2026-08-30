import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";
import type { PackedUserOperation, SubmitResult, UserOperationSubmitter } from "../../src/fleet/user-operation.js";

const trader = privateKeyToAccount(`0x${"11".repeat(32)}`);
const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
const owner = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;
const salt = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const ACTUAL_COST = "120000000000";

/** The public ledger an outside observer sees. */
class PublicLedger implements UserOperationSubmitter {
  operations: { sender: string; callData: string }[] = [];
  tokenBalances = new Map<string, bigint>();

  async submit(op: PackedUserOperation): Promise<SubmitResult> {
    this.operations.push({ sender: op.sender, callData: op.callData });
    const key = op.sender.toLowerCase();
    this.tokenBalances.set(key, (this.tokenBalances.get(key) ?? 0n) + 1000n);
    return { userOpHash: `0x${"cd".repeat(32)}`, actualGasCost: ACTUAL_COST };
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

test("the full five-wallet journey: create, confirm, fund, activate, buy, verify the boundary", async () => {
  const service = new CampaignService(serviceConfig);
  const ledger = new PublicLedger();
  const responses: unknown[] = [];
  const deps: RouterDeps = {
    service,
    feeConfig: { threshold: "1000", baseFee: "100", discount: "25", feeAsset: "ETH", recipient: owner(0xf1) },
    chitBalanceOf: async () => "1000",
    verifyFunding: async () => "1000000000000000",
    submitter: ledger,
  };
  const router = new CampaignRouter(deps);
  const key = (suffix: string) => `fleet-${suffix.padEnd(16, "0")}`;
  const track = async (result: { status: number; body: unknown }) => {
    responses.push(result.body);
    return result;
  };

  // FR-001: five distinct new accounts.
  const accounts = Array.from({ length: 5 }, (_, i) => ({ ownerAddress: owner(i + 1), salt: salt(i + 1) }));
  const create = await track(await router.handle(await signed(service, "create", {
    quoteId: "q-1",
    policy: {
      chainId: 46630, accounts: 5, router: owner(0x88), function: "execute(bytes,bytes[],uint256)",
      maxTradeValue: "500000000000000", perAccountGas: "200000000000000",
      totalGas: "1000000000000000", expiry: "2026-12-31T00:00:00.000Z",
    },
    accounts,
    recoveryVaultCommitment: `0x${"3".repeat(64)}`,
  }), key("create")));
  assert.equal(create.status, 201);
  const campaign = (create.body as { campaign: string }).campaign;

  await track(await router.handle(await signed(service, "confirmRecovery", { campaign, vaultConfirmed: true }), key("confirm")));
  await track(await router.handle(await signed(service, "fund", { campaign, fundingReference: "tx-1" }), key("fund")));
  const activate = await track(await router.handle(await signed(service, "activate", { campaign }), key("activate")));
  assert.equal((activate.body as { state: string }).state, "Active");

  // SC-003: one permitted sponsored buy per account; all five balances change.
  const buy = await track(await router.handle(await signed(service, "buy", {
    campaign, accounts: accounts.map((a) => a.ownerAddress), token: owner(0x77), value: "400000000000000",
  }), key("buy")));
  const results = (buy.body as { results: { status: string; budget: { spent: string } }[] }).results;
  assert.equal(results.length, 5);
  for (const entry of results) assert.equal(entry.status, "sponsored");
  for (const account of accounts) {
    assert.equal(ledger.tokenBalances.get(account.ownerAddress.toLowerCase()), 1000n);
  }

  // SC-004: exact aggregate debit.
  assert.equal(results[4]!.budget.spent, (5n * BigInt(ACTUAL_COST)).toString());

  // FR-011 / SC-009: the public ledger shows accounts and trades; no operation
  // and no response carries the primary wallet or claims unlinkability.
  assert.equal(ledger.operations.length, 5);
  const everythingPublic = JSON.stringify(ledger.operations) + JSON.stringify(responses);
  assert.equal(everythingPublic.toLowerCase().includes(trader.address.toLowerCase()), false,
    "the primary-to-fleet edge is never published");
  assert.equal(everythingPublic.includes("unlinkab"), false);
});
