import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createViemHandleClient } from "@iexec-nox/handle";
import { network } from "hardhat";
import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  padHex,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const ZERO_32 = `0x${"00".repeat(32)}` as Hex;

function paymasterPrefix(paymaster: Address): Hex {
  return concatHex([
    paymaster,
    padHex(toHex(500_000), { size: 16 }),
    padHex(toHex(500_000), { size: 16 }),
  ]);
}

function userOperation(sender: Address, paymasterAndData: Hex) {
  return {
    sender,
    nonce: 7n,
    initCode: "0x" as Hex,
    callData: "0x12345678" as Hex,
    accountGasLimits: ZERO_32,
    preVerificationGas: 50_000n,
    gasFees: ZERO_32,
    paymasterAndData,
    signature: "0x" as Hex,
  };
}

async function compatibleHandleClient(wallet: WalletClient) {
  const account = wallet.account;
  if (account === undefined) throw new Error("Test wallet has no account");
  return createViemHandleClient({
    ...wallet,
    getAddresses: async () => [account.address],
  });
}

async function deployEligibilityComponents() {
  const { viem } = await network.connect({ network: "sepoliaFork" });
  const [creator, operator, verifier, auditor, sponsor, sender] =
    await viem.getWalletClients();
  const token = await viem.deployContract("ChitToken", [
    creator.account.address,
    1_000_000n,
  ]);
  const wrapper = await viem.deployContract("ChitBudgetToken", [token.address]);
  const factory = await viem.deployContract("ChitRoundFactory", [
    ENTRY_POINT,
    wrapper.address,
    10n ** 18n,
  ]);
  return {
    auditor,
    creator,
    factory,
    operator,
    sender,
    sponsor,
    token,
    verifier,
    viem,
    wrapper,
  };
}

async function deployEligibilityFoundation() {
  const components = await deployEligibilityComponents();
  const salt = keccak256(stringToHex("phase1-signature"));
  const roundId = await components.factory.read.roundId([
    components.creator.account.address,
    salt,
  ]);
  await components.factory.write.beginRound([
    salt,
    components.operator.account.address,
    components.verifier.account.address,
    components.auditor.account.address,
  ]);
  return {
    ...components,
    roundId,
  };
}

type EligibilityFoundation = Awaited<
  ReturnType<typeof deployEligibilityFoundation>
>;

async function initializeEligibilityRound(fixture: EligibilityFoundation) {
  for (let step = 0; step < 5; step += 1) {
    await fixture.factory.write.initializeRoundStep([fixture.roundId, step]);
  }
  await fixture.factory.write.activateRound(
    [fixture.roundId, 10n ** 16n, 10n ** 18n, 1, 10n ** 15n],
    { value: 1_011n * 10n ** 15n },
  );
  const round = await fixture.factory.read.getRound([fixture.roundId]);
  return {
    ...fixture,
    paymaster: await fixture.viem.getContractAt(
      "ChitPaymaster",
      round.paymaster,
    ),
    settlement: await fixture.viem.getContractAt(
      "ChitSettlement",
      round.settlement,
    ),
    vault: await fixture.viem.getContractAt("ChitVault", round.vault),
  };
}

type EligibilityRound = Awaited<ReturnType<typeof initializeEligibilityRound>>;

async function admitEligibilitySponsor(
  fixture: EligibilityRound,
  sponsorWallet: EligibilityRound["creator"],
): Promise<void> {
  const account = sponsorWallet.account;
  const amount = 5_000n;
  if (account.address !== fixture.creator.account.address) {
    await fixture.token.write.transfer([account.address, amount]);
  }
  await fixture.token.write.approve([fixture.wrapper.address, amount], { account });
  await fixture.wrapper.write.wrap([account.address, amount], { account });
  const expiry = Math.floor(Date.now() / 1_000) + 3_600;
  await fixture.wrapper.write.setOperator([fixture.vault.address, expiry], {
    account,
  });
  const encrypted = await (
    await compatibleHandleClient(sponsorWallet)
  ).encryptInput(amount, "uint256", fixture.vault.address);
  const digest = await fixture.vault.read.admissionDigest([
    account.address,
    expiry,
  ]);
  const signature = await fixture.creator.signMessage({ message: { raw: digest } });
  await fixture.vault.write.registerSponsor(
    [encrypted.handle, encrypted.handleProof, expiry, signature],
    { account },
  );
}

async function enrollEligibilitySender(fixture: EligibilityRound): Promise<void> {
  const encryptedSlot = await (
    await compatibleHandleClient(fixture.operator)
  ).encryptInput(0n, "uint256", fixture.settlement.address);
  await fixture.settlement.write.enroll(
    [
      fixture.sender.account.address,
      encryptedSlot.handle,
      encryptedSlot.handleProof,
    ],
    { account: fixture.operator.account },
  );
}

async function deployEligiblePaymaster() {
  const fixture = await initializeEligibilityRound(
    await deployEligibilityFoundation(),
  );
  await admitEligibilitySponsor(fixture, fixture.creator);
  await admitEligibilitySponsor(fixture, fixture.sponsor);
  await enrollEligibilitySender(fixture);
  return {
    paymaster: fixture.paymaster,
    publicClient: await fixture.viem.getPublicClient(),
    sender: fixture.sender,
    verifier: fixture.verifier,
  };
}

describe("Phase 1: verifying paymaster", () => {
  it("accepts only a signature bound to the complete authorization digest", async () => {
    const { paymaster, publicClient, sender, verifier } =
      await deployEligiblePaymaster();
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const prefix = paymasterPrefix(paymaster.address);
    const unsigned = userOperation(sender.account.address, prefix);
    const maxCost = 900_000n;
    const digest = await paymaster.read.authorizationDigest([
      unsigned,
      maxCost,
      expiry,
    ]);
    const signature = await verifier.signMessage({ message: { raw: digest } });
    const tail = encodeAbiParameters(
      [{ type: "uint48" }, { type: "bytes" }],
      [expiry, signature],
    );
    const signed = userOperation(sender.account.address, concatHex([prefix, tail]));

    const [context, validationData] = await publicClient.readContract({
      address: paymaster.address,
      abi: paymaster.abi,
      functionName: "validatePaymasterUserOp",
      args: [signed, ZERO_32, maxCost],
      account: ENTRY_POINT,
    });
    const [, invalidData] = await publicClient.readContract({
      address: paymaster.address,
      abi: paymaster.abi,
      functionName: "validatePaymasterUserOp",
      args: [signed, ZERO_32, maxCost + 1n],
      account: ENTRY_POINT,
    });

    assert.notEqual(context, "0x");
    assert.notEqual(validationData, 1n);
    assert.equal(invalidData, 1n, "changed maxCost must invalidate the signature");
  });

  it("records the public chit in postOp without Nox work", async () => {
    const { viem, networkHelpers } = await network.connect({
      network: "sepoliaFork",
    });
    const [owner, verifier, sender] = await viem.getWalletClients();
    const paymaster = await viem.deployContract("ChitPaymaster", [
      ENTRY_POINT,
      owner.account.address,
      owner.account.address,
      owner.account.address,
      owner.account.address,
      verifier.account.address,
      owner.account.address,
    ]);
    await networkHelpers.impersonateAccount(ENTRY_POINT);
    await networkHelpers.setBalance(ENTRY_POINT, 10n ** 18n);
    const context = encodeAbiParameters(
      [{ type: "address" }],
      [sender.account.address],
    );

    await paymaster.write.postOp([0, context, 123_456n, 0n], {
      account: ENTRY_POINT,
    });

    assert.equal(await paymaster.read.claim([0n, sender.account.address]), 123_456n);
    assert.equal(await paymaster.read.epochTotal([0n]), 123_456n);
  });
});

describe("Phase 1: epoch settlement", () => {
  it("runs an oblivious four-slot pro-rata haircut and stores fresh handles", async () => {
    const { networkHelpers, viem } = await network.connect({
      network: "sepoliaFork",
    });
    const [owner, auditor, user] = await viem.getWalletClients();
    const vault = await viem.deployContract("ChitVault", [
      owner.account.address,
      auditor.account.address,
      owner.account.address,
      owner.account.address,
    ]);
    const settlement = await viem.deployContract("ChitSettlement", [
      vault.address,
      auditor.account.address,
      owner.account.address,
      owner.account.address,
      owner.account.address,
    ]);
    const paymaster = await viem.deployContract("ChitPaymaster", [
      ENTRY_POINT,
      vault.address,
      settlement.address,
      owner.account.address,
      owner.account.address,
      owner.account.address,
      owner.account.address,
    ]);
    await vault.write.setSettlement([settlement.address]);
    await settlement.write.setPaymaster([paymaster.address]);
    for (let slot = 0; slot < 4; slot += 1) {
      await vault.write.initializeBudget([BigInt(slot)]);
      await settlement.write.initializeCharge([BigInt(slot)]);
    }
    await settlement.write.initializeAggregate();
    await paymaster.write.activateRound([1n, 1n, 1], { value: 2n });
    const encryptedSlot = await (
      await createViemHandleClient(owner)
    ).encryptInput(0n, "uint256", settlement.address);
    await settlement.write.enroll([
      user.account.address,
      encryptedSlot.handle,
      encryptedSlot.handleProof,
    ]);
    const context = encodeAbiParameters(
      [{ type: "address" }],
      [user.account.address],
    );
    await networkHelpers.impersonateAccount(ENTRY_POINT);
    await networkHelpers.setBalance(ENTRY_POINT, 10n ** 18n);
    await paymaster.write.postOp([0, context, 123_456n, 0n], {
      account: ENTRY_POINT,
    });
    await paymaster.write.closeEpoch();
    const before = await settlement.read.lastChargeHandle([0n]);

    await settlement.write.settleEpoch([
      0n,
      [user.account.address],
      [123_456n],
    ]);

    const after = await settlement.read.lastChargeHandle([0n]);
    assert.notEqual(after, before, "settlement must produce a fresh charge handle");
    assert.equal(await settlement.read.settledEpochs(), 1n);
  });
});
