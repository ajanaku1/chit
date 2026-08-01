import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createViemHandleClient } from "@iexec-nox/handle";
import { network } from "hardhat";
import { keccak256, stringToHex, zeroAddress } from "viem";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const ONE_ETH = 10n ** 18n;

function assertAddress(actual: string, expected: string): void {
  assert.equal(actual.toLowerCase(), expected.toLowerCase());
}

async function deployFixture(minimumStake = ONE_ETH) {
  const { viem } = await network.connect({ network: "sepoliaFork" });
  const [creator, operator, verifier, auditor, outsider] =
    await viem.getWalletClients();
  const token = await viem.deployContract("ChitToken", [
    creator.account.address,
    1_000_000n,
  ]);
  const wrapper = await viem.deployContract("ChitBudgetToken", [token.address]);
  const factory = await viem.deployContract("ChitRoundFactory", [
    ENTRY_POINT,
    wrapper.address,
    minimumStake,
  ]);
  return {
    auditor,
    creator,
    factory,
    operator,
    outsider,
    token,
    verifier,
    viem,
    wrapper,
  };
}

async function initializeRound(
  factory: Awaited<ReturnType<typeof deployFixture>>["factory"],
  roundId: `0x${string}`,
): Promise<void> {
  for (let step = 0; step < 5; step += 1) {
    await factory.write.initializeRoundStep([roundId, step]);
  }
}

describe("public round factory", () => {
  it("pins a nonzero minimum stake and accepts its exact boundary", async () => {
    const minimumStake = 10n ** 17n;
    const { auditor, creator, factory, operator, verifier } =
      await deployFixture(minimumStake);
    assert.equal(await factory.read.minimumStake(), minimumStake);
    const salt = keccak256(stringToHex("lower-sepolia-stake"));
    const roundId = await factory.read.roundId([creator.account.address, salt]);
    await factory.write.beginRound([
      salt,
      operator.account.address,
      verifier.account.address,
      auditor.account.address,
    ]);
    await initializeRound(factory, roundId);
    const deposit = 10n ** 16n;
    const operatorGas = 10n ** 15n;
    await assert.rejects(
      factory.write.activateRound(
        [roundId, deposit, minimumStake - 1n, 1, operatorGas],
        { value: deposit + minimumStake - 1n + operatorGas },
      ),
    );
    await factory.write.activateRound(
      [roundId, deposit, minimumStake, 1, operatorGas],
      { value: deposit + minimumStake + operatorGas },
    );
  });

  it("rejects a zero minimum stake", async () => {
    await assert.rejects(deployFixture(0n));
  });

  it("deploys and wires an initializing round without constructor-time Nox work", async () => {
    const { auditor, creator, factory, operator, verifier, viem } =
      await deployFixture();
    const salt = keccak256(stringToHex("creator-round-1"));
    const roundId = await factory.read.roundId([creator.account.address, salt]);

    await factory.write.beginRound([
      salt,
      operator.account.address,
      verifier.account.address,
      auditor.account.address,
    ]);

    const round = await factory.read.getRound([roundId]);
    assertAddress(round.creator, creator.account.address);
    assertAddress(round.operator, operator.account.address);
    assertAddress(round.verifier, verifier.account.address);
    assertAddress(round.auditor, auditor.account.address);
    assert.equal(round.initializedSteps, 0);
    const publicClient = await viem.getPublicClient();
    assert.notEqual(await publicClient.getCode({ address: round.vault }), "0x");
    assert.notEqual(await publicClient.getCode({ address: round.settlement }), "0x");
    assert.notEqual(await publicClient.getCode({ address: round.paymaster }), "0x");

    const vault = await viem.getContractAt("ChitVault", round.vault);
    const settlement = await viem.getContractAt("ChitSettlement", round.settlement);
    assertAddress(await vault.read.settlement(), round.settlement);
    assertAddress(await settlement.read.paymaster(), round.paymaster);
  });

  it("rejects missing roles and a creator's reused salt", async () => {
    const { auditor, factory, operator, verifier } = await deployFixture();
    const salt = keccak256(stringToHex("unique-round"));
    await assert.rejects(
      factory.write.beginRound([
        salt,
        zeroAddress,
        verifier.account.address,
        auditor.account.address,
      ]),
    );
    await factory.write.beginRound([
      salt,
      operator.account.address,
      verifier.account.address,
      auditor.account.address,
    ]);
    await assert.rejects(
      factory.write.beginRound([
        salt,
        operator.account.address,
        verifier.account.address,
        auditor.account.address,
      ]),
    );
  });

  it("initializes each Nox step once and permits an outside caller", async () => {
    const { auditor, creator, factory, operator, outsider, verifier } =
      await deployFixture();
    const salt = keccak256(stringToHex("staged-round"));
    const roundId = await factory.read.roundId([creator.account.address, salt]);
    await factory.write.beginRound([
      salt,
      operator.account.address,
      verifier.account.address,
      auditor.account.address,
    ]);

    await factory.write.initializeRoundStep([roundId, 0], {
      account: outsider.account,
    });

    assert.equal((await factory.read.getRound([roundId])).initializedSteps, 1);
    await assert.rejects(
      factory.write.initializeRoundStep([roundId, 0], {
        account: outsider.account,
      }),
    );
    await assert.rejects(factory.write.initializeRoundStep([roundId, 5]));
  });

  it("activates only after all steps and splits the exact supplied value", async () => {
    const { auditor, creator, factory, operator, verifier, viem } =
      await deployFixture();
    const salt = keccak256(stringToHex("active-round"));
    const roundId = await factory.read.roundId([creator.account.address, salt]);
    await factory.write.beginRound([
      salt,
      operator.account.address,
      verifier.account.address,
      auditor.account.address,
    ]);
    const deposit = 10n ** 16n;
    const stake = 10n ** 18n;
    const operatorGas = 10n ** 15n;
    const value = deposit + stake + operatorGas;
    await assert.rejects(
      factory.write.activateRound([roundId, deposit, stake, 1, operatorGas], {
        value,
      }),
    );
    await initializeRound(factory, roundId);
    const operatorBefore = await (await viem.getPublicClient()).getBalance({
      address: operator.account.address,
    });

    await factory.write.activateRound([roundId, deposit, stake, 1, operatorGas], {
      value,
    });

    const round = await factory.read.getRound([roundId]);
    const paymaster = await viem.getContractAt("ChitPaymaster", round.paymaster);
    assert.equal(await paymaster.read.roundState(), 1);
    assert.equal(await paymaster.read.entryPointBalance(), deposit);
    assert.equal((await paymaster.read.stakeInfo())[0], stake);
    assert.equal(
      await (await viem.getPublicClient()).getBalance({ address: operator.account.address }),
      operatorBefore + operatorGas,
    );
  });

  it("rejects non-creator activation, zero funding fields, and value mismatch", async () => {
    const { auditor, creator, factory, operator, outsider, verifier } =
      await deployFixture();
    const salt = keccak256(stringToHex("activation-guards"));
    const roundId = await factory.read.roundId([creator.account.address, salt]);
    await factory.write.beginRound([
      salt,
      operator.account.address,
      verifier.account.address,
      auditor.account.address,
    ]);
    await initializeRound(factory, roundId);
    const deposit = 10n ** 16n;
    const stake = 10n ** 18n;
    const operatorGas = 10n ** 15n;
    const value = deposit + stake + operatorGas;

    await assert.rejects(
      factory.write.activateRound([roundId, deposit, stake, 1, operatorGas], {
        account: outsider.account,
        value,
      }),
    );
    await assert.rejects(
      factory.write.activateRound([roundId, 0n, stake, 1, operatorGas], {
        value: stake + operatorGas,
      }),
    );
    await assert.rejects(
      factory.write.activateRound([roundId, deposit, stake, 1, operatorGas], {
        value: value - 1n,
      }),
    );
  });

  it("requires active-round admission and prevents duplicate sponsor slots", async () => {
    const { auditor, creator, factory, operator, token, verifier, viem, wrapper } =
      await deployFixture();
    const salt = keccak256(stringToHex("sponsor-admission"));
    const roundId = await factory.read.roundId([creator.account.address, salt]);
    await factory.write.beginRound([
      salt,
      operator.account.address,
      verifier.account.address,
      auditor.account.address,
    ]);
    await initializeRound(factory, roundId);
    const round = await factory.read.getRound([roundId]);
    const vault = await viem.getContractAt("ChitVault", round.vault);
    await token.write.approve([wrapper.address, 10_000n]);
    await wrapper.write.wrap([creator.account.address, 10_000n]);
    const expiry = Math.floor(Date.now() / 1000) + 3_600;
    await wrapper.write.setOperator([vault.address, expiry]);
    const encrypted = await (
      await createViemHandleClient(creator)
    ).encryptInput(5_000n, "uint256", vault.address);
    const digest = await vault.read.admissionDigest([
      creator.account.address,
      expiry,
    ]);
    const signature = await creator.signMessage({ message: { raw: digest } });

    await assert.rejects(
      vault.write.registerSponsor(
        [encrypted.handle, encrypted.handleProof, expiry, signature],
      ),
    );
    await factory.write.activateRound(
      [roundId, 10n ** 16n, 10n ** 18n, 1, 10n ** 15n],
      { value: 1_011n * 10n ** 15n },
    );
    await vault.write.registerSponsor(
      [encrypted.handle, encrypted.handleProof, expiry, signature],
    );

    assert.equal(await vault.read.sponsorCount(), 1n);
    assertAddress(await vault.read.sponsorAt([0n]), creator.account.address);
    await assert.rejects(
      vault.write.registerSponsor(
        [encrypted.handle, encrypted.handleProof, expiry, signature],
      ),
    );
  });
});
