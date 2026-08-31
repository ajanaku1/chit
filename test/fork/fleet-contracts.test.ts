import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, parseEther, type Address } from "viem";

/**
 * On-chain behavioral tests for the hardened Fleet contracts.
 *
 * These exercise the security fixes against a live EVM: the owner escape hatch,
 * the operator's spent-ETH withdrawal, the lock that closes the close/commit
 * race, campaign registration against id-squatting, and openSession sanity
 * reverts.
 */
describe("Fleet contracts — production hardening", () => {
  let viem: Awaited<ReturnType<typeof network.connect>>["viem"];
  let wallets: Awaited<ReturnType<Awaited<ReturnType<typeof network.connect>>["viem"]["getWalletClients"]>>;

  before(async () => {
    ({ viem } = await network.connect({ network: "default" }));
    wallets = await viem.getWalletClients();
  });

  const CAMPAIGN = `0x${"11".repeat(32)}` as const;
  const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

  /** Five wallet-client addresses in strictly increasing order for a fleet. */
  const fleetOwners = () =>
    wallets
      .slice(1, 9)
      .map((w) => w.account.address)
      .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
      .slice(0, 5) as Address[];

  describe("FleetAccount owner escape hatch (HIGH)", () => {
    it("lets the owner sweep ERC-20 tokens and ETH; blocks the operator", async () => {
      const operator = wallets[0]!;
      const policy = await viem.deployContract("FleetSessionPolicy", [operator.account.address]);
      const factory = await viem.deployContract("FleetAccountFactory", [operator.account.address]);

      const owners = fleetOwners();
      const inits = owners.map((ownerAddress, i) => ({ ownerAddress, salt: key(i + 1) }));
      const predicted = (await factory.read.accountAddress([CAMPAIGN, policy.address, owners[0]!, key(1)])) as Address;
      await factory.write.createFleet([CAMPAIGN, policy.address, inits]);

      // Fund the account with a token and some ETH, simulating a completed buy.
      const token = await viem.deployContract("ChitToken", [predicted, parseEther("1000")]);
      await operator.sendTransaction({ to: predicted, value: parseEther("1") });

      const account = await viem.getContractAt("FleetAccount", predicted);
      const ownerWallet = wallets.find((w) => getAddress(w.account.address) === getAddress(owners[0]!))!;

      // The operator must NOT be able to sweep the owner's tokens.
      await assert.rejects(
        account.write.withdrawToken([token.address, operator.account.address, parseEther("1000")], {
          account: operator.account,
        }),
      );

      // The owner can recover both the token and the ETH.
      await account.write.withdrawToken([token.address, owners[0]!, parseEther("1000")], { account: ownerWallet.account });
      await account.write.withdrawEth([owners[0]!, parseEther("1")], { account: ownerWallet.account });

      const bal = (await token.read.balanceOf([owners[0]!])) as bigint;
      assert.equal(bal, parseEther("1000"));
    });
  });

  describe("FleetCampaignEscrow spent withdrawal (MEDIUM)", () => {
    it("lets the operator withdraw committed spend once, never more than accrued", async () => {
      const operator = wallets[0]!;
      const owner = wallets[1]!;
      const escrow = await viem.deployContract("FleetCampaignEscrow", [operator.account.address]);

      await escrow.write.registerCampaign([CAMPAIGN, owner.account.address]);
      await escrow.write.fund([CAMPAIGN], { account: owner.account, value: parseEther("1") });
      await escrow.write.reserve([CAMPAIGN, key(1), parseEther("0.3")]);
      await escrow.write.commit([CAMPAIGN, key(1), parseEther("0.2")]);

      // Pay out to a fresh recipient so gas paid by the operator doesn't muddy
      // the balance check.
      const recipient = wallets[6]!.account.address;
      const before = await (await viem.getPublicClient()).getBalance({ address: recipient });
      await escrow.write.withdrawSpent([CAMPAIGN, recipient]);
      const after = await (await viem.getPublicClient()).getBalance({ address: recipient });
      assert.equal(after - before, parseEther("0.2"), "recipient received exactly the committed spend");

      // A second withdrawal reverts: nothing left to withdraw.
      await assert.rejects(escrow.write.withdrawSpent([CAMPAIGN, recipient]));
    });
  });

  describe("FleetCampaignEscrow close/commit race (MEDIUM)", () => {
    it("a locked reservation cannot be clawed back by close", async () => {
      const operator = wallets[0]!;
      const owner = wallets[2]!;
      const campaign = `0x${"22".repeat(32)}` as const;
      const escrow = await viem.deployContract("FleetCampaignEscrow", [operator.account.address]);

      await escrow.write.registerCampaign([campaign, owner.account.address]);
      await escrow.write.fund([campaign], { account: owner.account, value: parseEther("1") });
      await escrow.write.reserve([campaign, key(1), parseEther("0.5")]);
      await escrow.write.lock([campaign, key(1)]);

      // Owner closes and lists the locked key: it must NOT be rolled back.
      await escrow.write.close([campaign, [key(1)]], { account: owner.account });

      // The operator can still commit the in-flight op after the race attempt.
      await escrow.write.commit([campaign, key(1), parseEther("0.4")]);
      const reservation = (await escrow.read.reservationOf([campaign, key(1)])) as { state: number };
      assert.equal(reservation.state, 2, "reservation committed, not rolled back");
    });

    it("the owner can reclaim a locked reservation the operator abandoned, after the window", async () => {
      const operator = wallets[0]!;
      const owner = wallets[7]!;
      const campaign = `0x${"55".repeat(32)}` as const;
      const escrow = await viem.deployContract("FleetCampaignEscrow", [operator.account.address]);
      const test = await viem.getTestClient();

      await escrow.write.registerCampaign([campaign, owner.account.address]);
      await escrow.write.fund([campaign], { account: owner.account, value: parseEther("1") });
      await escrow.write.reserve([campaign, key(1), parseEther("0.5")]);
      await escrow.write.lock([campaign, key(1)]);
      await escrow.write.close([campaign, [key(1)]], { account: owner.account });

      // Operator vanishes; within the window the owner cannot reclaim.
      await assert.rejects(escrow.write.reclaimExpiredLock([campaign, key(1)], { account: owner.account }));

      // After the window the owner reclaims the stranded reservation.
      await test.increaseTime({ seconds: 3601 });
      await test.mine({ blocks: 1 });
      const before = await (await viem.getPublicClient()).getBalance({ address: owner.account.address });
      await escrow.write.reclaimExpiredLock([campaign, key(1)], { account: owner.account });
      const after = await (await viem.getPublicClient()).getBalance({ address: owner.account.address });
      assert.ok(after > before, "owner recovered the stranded reservation");
    });
  });

  describe("FleetCampaignEscrow campaign registration (LOW — squatting)", () => {
    it("only the registered owner may fund; a stranger cannot", async () => {
      const operator = wallets[0]!;
      const owner = wallets[3]!;
      const stranger = wallets[4]!;
      const campaign = `0x${"33".repeat(32)}` as const;
      const escrow = await viem.deployContract("FleetCampaignEscrow", [operator.account.address]);

      await escrow.write.registerCampaign([campaign, owner.account.address]);
      await assert.rejects(escrow.write.fund([campaign], { account: stranger.account, value: parseEther("1") }));
      await escrow.write.fund([campaign], { account: owner.account, value: parseEther("1") });
    });

    it("an unregistered campaign cannot be funded", async () => {
      const operator = wallets[0]!;
      const stranger = wallets[5]!;
      const campaign = `0x${"44".repeat(32)}` as const;
      const escrow = await viem.deployContract("FleetCampaignEscrow", [operator.account.address]);
      await assert.rejects(escrow.write.fund([campaign], { account: stranger.account, value: parseEther("1") }));
    });
  });

  describe("FleetSessionPolicy openSession sanity checks (LOW)", () => {
    it("rejects a past expiry, chain mismatch, per>total gas, and zero router", async () => {
      const operator = wallets[0]!;
      const policy = await viem.deployContract("FleetSessionPolicy", [operator.account.address]);
      const owners = fleetOwners();
      const chainId = await (await viem.getPublicClient()).getChainId();

      const base = {
        chainId: BigInt(chainId),
        router: "0x0000000000000000000000000000000000000088" as Address,
        selector: "0x12345678" as `0x${string}`,
        maxTradeValue: parseEther("1"),
        perAccountGas: parseEther("0.0002"),
        totalGas: parseEther("0.001"),
        expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400),
        spentGas: 0n,
        paused: false,
        revoked: false,
        exists: false,
      };

      await assert.rejects(
        policy.write.openSession([CAMPAIGN, { ...base, expiry: 1n }, owners]),
        /.*/,
        "past expiry rejected",
      );
      await assert.rejects(
        policy.write.openSession([CAMPAIGN, { ...base, chainId: 999999n }, owners]),
        /.*/,
        "chain mismatch rejected",
      );
      await assert.rejects(
        policy.write.openSession([CAMPAIGN, { ...base, perAccountGas: parseEther("1"), totalGas: parseEther("0.001") }, owners]),
        /.*/,
        "per>total gas rejected",
      );
      await assert.rejects(
        policy.write.openSession([CAMPAIGN, { ...base, router: "0x0000000000000000000000000000000000000000" as Address }, owners]),
        /.*/,
        "zero router rejected",
      );
      // A well-formed session still opens.
      await policy.write.openSession([CAMPAIGN, base, owners]);
    });
  });
});
