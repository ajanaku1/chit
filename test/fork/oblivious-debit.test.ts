import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const NOX_COMPUTE_SEPOLIA = "0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF";

describe("GO/NO-GO: confidential paymaster on canonical EntryPoint", () => {
  it("fork has the real EntryPoint and the real NoxCompute", async () => {
    const { viem } = await network.connect({ network: "sepoliaFork" });
    const publicClient = await viem.getPublicClient();

    const chainId = await publicClient.getChainId();
    assert.equal(chainId, 11155111, "chainId must stay 11155111 for Nox resolution");

    const epCode = await publicClient.getCode({ address: ENTRY_POINT_V07 });
    assert.ok(epCode && epCode !== "0x", "EntryPoint v0.7 missing on fork");

    const noxCode = await publicClient.getCode({ address: NOX_COMPUTE_SEPOLIA });
    assert.ok(noxCode && noxCode !== "0x", "NoxCompute missing on fork");

    console.log(
      `    EntryPoint ${(epCode!.length - 2) / 2}b | NoxCompute ${(noxCode!.length - 2) / 2}b`,
    );
  });

  it("deploys: constructor runs 12 Nox ops against the real NoxCompute", async () => {
    const { viem } = await network.connect({ network: "sepoliaFork" });
    const publicClient = await viem.getPublicClient();
    const [deployer, auditor] = await viem.getWalletClients();

    const paymaster = await viem.deployContract("ConfidentialPaymaster", [
      ENTRY_POINT_V07,
      auditor.account.address,
    ]);

    assert.equal(
      (await paymaster.read.entryPoint()).toLowerCase(),
      ENTRY_POINT_V07.toLowerCase(),
    );
    // Constructor initialised 4 encrypted budgets; a non-zero handle proves the
    // Nox ops actually executed rather than silently no-oping.
    const handle = await paymaster.read.budgetHandle([0n]);
    console.log(`    budget[0] handle: ${handle}`);
    assert.notEqual(
      handle,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "budget handle is zero - Nox ops did not run",
    );
  });

  it("deposits real ETH into the canonical EntryPoint", async () => {
    const { viem } = await network.connect({ network: "sepoliaFork" });
    const [, auditor] = await viem.getWalletClients();

    const paymaster = await viem.deployContract("ConfidentialPaymaster", [
      ENTRY_POINT_V07,
      auditor.account.address,
    ]);

    await paymaster.write.deposit({ value: 10n ** 18n });
    const bal = await paymaster.read.entryPointBalance();
    console.log(`    EntryPoint deposit: ${bal}`);
    assert.equal(bal, 10n ** 18n, "EntryPoint did not credit the deposit");
  });

  it("THE GATE: postOp does the oblivious debit, and what does it cost?", async () => {
    const { viem, networkHelpers } = await network.connect({
      network: "sepoliaFork",
    });
    const publicClient = await viem.getPublicClient();
    const [, auditor] = await viem.getWalletClients();

    const paymaster = await viem.deployContract("ConfidentialPaymaster", [
      ENTRY_POINT_V07,
      auditor.account.address,
    ]);

    // Impersonate EntryPoint so postOp's access control is exercised for real.
    await networkHelpers.impersonateAccount(ENTRY_POINT_V07);
    await networkHelpers.setBalance(ENTRY_POINT_V07, 10n ** 18n);

    const account = "0x1111111111111111111111111111111111111111";
    const context = `0x${account.slice(2).padStart(64, "0")}` as `0x${string}`;

    const gas = await publicClient.estimateContractGas({
      address: paymaster.address,
      abi: paymaster.abi,
      functionName: "postOp",
      args: [0, context, 21000n * 30n, 0n],
      account: ENTRY_POINT_V07,
    });

    // Op count deliberately not stated here: it is not measured, and a stale
    // hand-written number is worse than no number. Gas is the real signal.
    console.log(`    >>> postOp gas (${4} sponsors): ${gas}`);
    assert.ok(gas > 0n);

    // Actually execute it, and prove the encrypted budget handle changed -
    // i.e. the oblivious debit really wrote new ciphertext, not a no-op.
    const before = await paymaster.read.budgetHandle([0n]);
    await paymaster.write.postOp([0, context, 21000n * 30n, 0n], {
      account: ENTRY_POINT_V07,
    });
    const after = await paymaster.read.budgetHandle([0n]);

    console.log(`    handle before: ${before}`);
    console.log(`    handle after:  ${after}`);
    assert.notEqual(before, after, "postOp did not produce a new handle");
  });
});
