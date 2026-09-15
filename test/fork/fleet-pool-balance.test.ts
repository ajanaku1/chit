import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, type Address } from "viem";

import { CampaignRouter } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import { createFleetPool } from "../../src/fleet/chain-pool.js";
import { ledgerKey } from "../../src/fleet/pool-ledger.js";
import { coarseCharge, createPoolService } from "../../src/fleet/pool-buy.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

/**
 * The balance journey through the router against a real pool: a trader's
 * deposit is visible to an instance that never saw it, and a withdrawal is paid
 * by the operator's own wallet so the pool never publishes depositor-to-payee.
 */
describe("Pool balance through the router", () => {
  const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
  const NONCE_SECRET = "derived-from-operator-key";
  const OPERATOR_KEY = `0x${"7".repeat(64)}` as const;

  let viem: Awaited<ReturnType<typeof network.connect>>["viem"];

  before(async () => {
    ({ viem } = await network.connect({ network: "default" }));
  });

  it("shows a deposit to a fresh instance and pays a withdrawal from the operator wallet", async () => {
    const [operator, trader] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const contract = await viem.deployContract("FleetPool", [operator!.account.address]);

    const pool = createFleetPool(operator!, publicClient, contract.address as Address);
    const key = ledgerKey(OPERATOR_KEY);
    // Each router is its own serverless instance: separate memory, same chain.
    const instance = () => {
      const service = new CampaignService(serviceConfig, { nonceSecret: NONCE_SECRET });
      return {
        service,
        router: new CampaignRouter({ service, pool: createPoolService(operator!, publicClient, pool, key) }),
      };
    };
    const issuer = instance().service;

    const signed = async (action: string, body: Record<string, unknown>) => {
      const hash = payloadHash(body);
      const c = issuer.issueChallenge({ primaryWallet: trader!.account.address, action, payloadHash: hash });
      const fields = {
        primaryWallet: trader!.account.address, nonce: c.nonce, issuedAt: c.issuedAt,
        expiresAt: c.expiresAt, action, payloadHash: hash,
      };
      const signature = await trader!.signMessage({ account: trader!.account, message: challengeBytes(serviceConfig, fields) });
      const auth: AuthEnvelope = { ...fields, signature };
      return { action, auth, body };
    };
    let calls = 0;
    const elsewhere = async (action: string, body: Record<string, unknown>) =>
      instance().router.handle(await signed(action, body), `fleet-${action}-${String(calls++).padStart(16, "0")}`);

    // The trader deposits directly; no Chit call is involved.
    await contract.write.deposit({ account: trader!.account, value: parseEther("0.1") });

    const balance = await elsewhere("balance", {});
    assert.equal(balance.status, 200, JSON.stringify(balance.body));
    const view = balance.body as {
      available: string; deposited: string; headroom: { sizes: string[] }; pool: { paused: boolean };
    };
    assert.equal(view.deposited, parseEther("0.1").toString());
    assert.equal(view.available, parseEther("0.1").toString());
    assert.deepEqual(view.headroom.sizes, [
      parseEther("0.01").toString(), parseEther("0.05").toString(), parseEther("0.1").toString(),
    ]);
    assert.equal(view.pool.paused, false);

    const destination = "0x00000000000000000000000000000000000f3e58" as Address;
    const before = await publicClient.getBalance({ address: destination });
    const paid = await elsewhere("withdraw", { amount: parseEther("0.03").toString(), destination });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    const after = await publicClient.getBalance({ address: destination });
    assert.equal(after - before, parseEther("0.03"), "the destination was paid exactly");

    // The pool itself did not pay: it still holds the deposit, and the spend is
    // queued against the depositor for later posting.
    assert.equal(await publicClient.getBalance({ address: contract.address as Address }), parseEther("0.1"));
    assert.equal(await contract.read.queuedSpendCount(), 1n);
    const queued = await contract.read.queuedSpendAt([0n]);
    // The charge is the coarse form of the payout, one grain below it, so the
    // transfer to the payee and the charge to the depositor never carry the
    // same number; the grain is the pool's.
    assert.equal(queued.amount, coarseCharge(parseEther("0.03")));
    assert.ok(queued.amount < parseEther("0.03"));
    assert.equal(queued.posted, false);

    // Available drops immediately, so the same ETH cannot be withdrawn twice
    // while the posting is still in flight.
    const second = await elsewhere("balance", {});
    assert.equal((second.body as { available: string }).available, (parseEther("0.1") - coarseCharge(parseEther("0.03"))).toString());
    const tooMuch = await elsewhere("withdraw", { amount: parseEther("0.08").toString(), destination });
    assert.equal(tooMuch.status, 422, JSON.stringify(tooMuch.body));
  });
});
