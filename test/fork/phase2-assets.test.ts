import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createViemHandleClient } from "@iexec-nox/handle";
import { network } from "hardhat";

describe("Phase 2: live deployment assets", () => {
  it("wraps real ERC-20 collateral into a confidential ERC-7984 balance", async () => {
    const { viem } = await network.connect({ network: "sepoliaFork" });
    const [owner] = await viem.getWalletClients();
    const token = await viem.deployContract("ChitToken", [
      owner.account.address,
      1_000_000n,
    ]);
    const wrapper = await viem.deployContract("ChitBudgetToken", [token.address]);

    await token.write.approve([wrapper.address, 10_000n]);
    const before = await wrapper.read.confidentialBalanceOf([
      owner.account.address,
    ]);
    await wrapper.write.wrap([owner.account.address, 10_000n]);
    const after = await wrapper.read.confidentialBalanceOf([
      owner.account.address,
    ]);

    assert.notEqual(after, before);
    assert.equal(await token.read.balanceOf([wrapper.address]), 10_000n);
  });

  it("provides a deterministic target for the sponsored UserOperation", async () => {
    const { viem } = await network.connect({ network: "sepoliaFork" });
    const [owner] = await viem.getWalletClients();
    const counter = await viem.deployContract("ChitCounter");

    await counter.write.increment({ account: owner.account });

    assert.equal(await counter.read.count(), 1n);
  });

  it("moves an owner-scoped encrypted input through the vault operator", async () => {
    const { viem } = await network.connect({ network: "sepoliaFork" });
    const [owner, auditor] = await viem.getWalletClients();
    const token = await viem.deployContract("ChitToken", [
      owner.account.address,
      1_000_000n,
    ]);
    const wrapper = await viem.deployContract("ChitBudgetToken", [token.address]);
    const vault = await viem.deployContract("ChitVault", [
      wrapper.address,
      auditor.account.address,
      owner.account.address,
      owner.account.address,
    ]);
    await vault.write.setSettlement([owner.account.address]);
    for (let slot = 0; slot < 4; slot += 1) {
      await vault.write.initializeBudget([BigInt(slot)]);
    }
    await vault.write.activate();
    await token.write.approve([wrapper.address, 10_000n]);
    await wrapper.write.wrap([owner.account.address, 10_000n]);
    const expiry = Math.floor(Date.now() / 1000) + 3_600;
    await wrapper.write.setOperator([vault.address, expiry]);
    const handleClient = await createViemHandleClient(owner);
    const encrypted = await handleClient.encryptInput(
      5_000n,
      "uint256",
      vault.address,
    );

    const digest = await vault.read.admissionDigest([
      owner.account.address,
      expiry,
    ]);
    const signature = await owner.signMessage({ message: { raw: digest } });
    await vault.write.registerSponsor([
      encrypted.handle,
      encrypted.handleProof,
      expiry,
      signature,
    ]);

    assert.equal(await vault.read.sponsorCount(), 1n);
  });
});
