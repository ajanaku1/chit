import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createViemHandleClient } from "@iexec-nox/handle";
import { network } from "hardhat";
import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  padHex,
  parseAbi,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const ZERO_32 = `0x${"00".repeat(32)}` as Hex;
const settlementLifecycleAbi = parseAbi([
  "function settleEpoch(uint256 epoch, address[] users, uint256[] claims)",
]);
const roundAdminAbi = parseAbi([
  "function paused() view returns (bool)",
  "function setPaused(bool paused)",
  "function setOperator(address operator)",
  "function setVerifier(address verifier)",
]);
const paymasterLifecycleAbi = parseAbi([
  "function requestClose()",
  "function finalizeClose()",
  "function withdrawDeposit()",
  "function unlockStake()",
  "function withdrawStake()",
]);
const vaultRecoveryAbi = parseAbi([
  "function refundSponsor(uint256 slot)",
  "function refunded(uint256 slot) view returns (bool)",
]);

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
    nonce: 0n,
    initCode: "0x" as Hex,
    callData: "0x12345678" as Hex,
    accountGasLimits: ZERO_32,
    preVerificationGas: 50_000n,
    gasFees: ZERO_32,
    paymasterAndData,
    signature: "0x" as Hex,
  };
}

async function handleClient(wallet: WalletClient) {
  const account = wallet.account;
  if (account === undefined) throw new Error("Test wallet has no account");
  return createViemHandleClient({
    ...wallet,
    getAddresses: async () => [account.address],
  });
}

async function deployRoundComponents() {
  const { networkHelpers, viem } = await network.connect({
    network: "sepoliaFork",
  });
  const [creator, operator, verifier, auditor, sponsor, user] =
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
    networkHelpers,
    operator,
    sponsor,
    token,
    user,
    verifier,
    viem,
    wrapper,
  };
}

async function deployRoundFoundation() {
  const components = await deployRoundComponents();
  const salt = keccak256(stringToHex("round-lifecycle"));
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

type RoundFoundation = Awaited<ReturnType<typeof deployRoundFoundation>>;

async function initializeRound(foundation: RoundFoundation): Promise<void> {
  for (let step = 0; step < 5; step += 1) {
    await foundation.factory.write.initializeRoundStep([
      foundation.roundId,
      step,
    ]);
  }
  await foundation.factory.write.activateRound(
    [foundation.roundId, 10n ** 16n, 10n ** 18n, 60, 10n ** 15n],
    { value: 1_011n * 10n ** 15n },
  );
}

async function deployActiveRound() {
  const foundation = await deployRoundFoundation();
  await initializeRound(foundation);
  const round = await foundation.factory.read.getRound([foundation.roundId]);
  return {
    ...foundation,
    paymaster: await foundation.viem.getContractAt(
      "ChitPaymaster",
      round.paymaster,
    ),
    settlement: await foundation.viem.getContractAt(
      "ChitSettlement",
      round.settlement,
    ),
    vault: await foundation.viem.getContractAt("ChitVault", round.vault),
  };
}

type ActiveRoundFixture = Awaited<ReturnType<typeof deployActiveRound>>;

async function prepareSponsorBudget(
  fixture: ActiveRoundFixture,
  sponsor: ActiveRoundFixture["creator"],
  amount: bigint,
) {
  if (sponsor.account.address !== fixture.creator.account.address) {
    await fixture.token.write.transfer([sponsor.account.address, amount]);
  }
  await fixture.token.write.approve([fixture.wrapper.address, amount], {
    account: sponsor.account,
  });
  await fixture.wrapper.write.wrap([sponsor.account.address, amount], {
    account: sponsor.account,
  });
  const expiry = Math.floor(Date.now() / 1_000) + 3_600;
  await fixture.wrapper.write.setOperator([fixture.vault.address, expiry], {
    account: sponsor.account,
  });
  const encrypted = await (
    await handleClient(sponsor)
  ).encryptInput(amount, "uint256", fixture.vault.address);
  return { encrypted, expiry };
}

async function registerSponsor(
  fixture: ActiveRoundFixture,
  sponsor: ActiveRoundFixture["creator"],
): Promise<void> {
  const { encrypted, expiry } = await prepareSponsorBudget(
    fixture,
    sponsor,
    5_000n,
  );
  const digest = await fixture.vault.read.admissionDigest([
    sponsor.account.address,
    expiry,
  ]);
  const signature = await fixture.creator.signMessage({ message: { raw: digest } });
  await fixture.vault.write.registerSponsor(
    [encrypted.handle, encrypted.handleProof, expiry, signature],
    { account: sponsor.account },
  );
}

async function signedOperation(
  fixture: Awaited<ReturnType<typeof deployActiveRound>>,
): Promise<ReturnType<typeof userOperation>> {
  const maxCost = 900_000n;
  const expiry = Math.floor(Date.now() / 1_000) + 3_600;
  const prefix = paymasterPrefix(fixture.paymaster.address);
  const unsigned = userOperation(fixture.user.account.address, prefix);
  const digest = await fixture.paymaster.read.authorizationDigest([
    unsigned,
    maxCost,
    expiry,
  ]);
  const signature = await fixture.verifier.signMessage({ message: { raw: digest } });
  const tail = encodeAbiParameters(
    [{ type: "uint48" }, { type: "bytes" }],
    [expiry, signature],
  );
  return userOperation(fixture.user.account.address, concatHex([prefix, tail]));
}

async function validationData(
  fixture: Awaited<ReturnType<typeof deployActiveRound>>,
  operation: ReturnType<typeof userOperation>,
): Promise<bigint> {
  const publicClient = await fixture.viem.getPublicClient();
  const [, value] = await publicClient.readContract({
    address: fixture.paymaster.address,
    abi: fixture.paymaster.abi,
    functionName: "validatePaymasterUserOp",
    args: [operation, ZERO_32, 900_000n],
    account: ENTRY_POINT,
  });
  return value;
}

async function enrollAccount(
  fixture: Awaited<ReturnType<typeof deployActiveRound>>,
  slot: bigint,
  account = fixture.user.account.address,
): Promise<void> {
  const encryptedSlot = await (
    await handleClient(fixture.operator)
  ).encryptInput(slot, "uint256", fixture.settlement.address);
  await fixture.settlement.write.enroll(
    [account, encryptedSlot.handle, encryptedSlot.handleProof],
    { account: fixture.operator.account },
  );
}

async function recordClaim(
  fixture: Awaited<ReturnType<typeof deployActiveRound>>,
  amount: bigint,
  account = fixture.user.account.address,
): Promise<void> {
  await fixture.networkHelpers.impersonateAccount(ENTRY_POINT);
  await fixture.networkHelpers.setBalance(ENTRY_POINT, 10n ** 18n);
  const context = encodeAbiParameters(
    [{ type: "address" }],
    [account],
  );
  await fixture.paymaster.write.postOp([0, context, amount, 0n], {
    account: ENTRY_POINT,
  });
}

async function settle(
  fixture: Awaited<ReturnType<typeof deployActiveRound>>,
  epoch: bigint,
  claims: readonly bigint[],
): Promise<void> {
  await settleClaims(
    fixture,
    epoch,
    [fixture.user.account.address],
    claims,
  );
}

async function settleClaims(
  fixture: Awaited<ReturnType<typeof deployActiveRound>>,
  epoch: bigint,
  users: readonly Address[],
  claims: readonly bigint[],
): Promise<void> {
  await fixture.operator.writeContract({
    address: fixture.settlement.address,
    abi: settlementLifecycleAbi,
    functionName: "settleEpoch",
    args: [epoch, [...users], [...claims]],
  });
}

async function settleEmptyEpoch(
  fixture: Awaited<ReturnType<typeof deployActiveRound>>,
  epoch: bigint,
): Promise<void> {
  await fixture.operator.writeContract({
    address: fixture.settlement.address,
    abi: settlementLifecycleAbi,
    functionName: "settleEpoch",
    args: [epoch, [], []],
  });
}

async function lifecycleWrite(
  fixture: Awaited<ReturnType<typeof deployActiveRound>>,
  functionName:
    | "requestClose"
    | "finalizeClose"
    | "withdrawDeposit"
    | "unlockStake"
    | "withdrawStake",
  account = fixture.creator,
): Promise<void> {
  await account.writeContract({
    address: fixture.paymaster.address,
    abi: paymasterLifecycleAbi,
    functionName,
  });
}

describe("public round lifecycle", () => {
  it("requires two sponsors and an enrolled sender before authorization", async () => {
    const fixture = await deployActiveRound();
    const operation = await signedOperation(fixture);

    assert.equal(await validationData(fixture, operation), 1n);
    await registerSponsor(fixture, fixture.creator);
    assert.equal(await validationData(fixture, operation), 1n);
    await registerSponsor(fixture, fixture.sponsor);
    assert.equal(await validationData(fixture, operation), 1n);

    await enrollAccount(fixture, 0n);

    assert.notEqual(await validationData(fixture, operation), 1n);
    await fixture.paymaster.write.setPaused([true], {
      account: fixture.creator.account,
    });
    assert.equal(await validationData(fixture, operation), 1n);
    await fixture.paymaster.write.setPaused([false], {
      account: fixture.creator.account,
    });
    await lifecycleWrite(fixture, "requestClose");
    assert.equal(await validationData(fixture, operation), 1n);
  });

  it("locks an account to its first confidential sponsor enrollment", async () => {
    const fixture = await deployActiveRound();

    await enrollAccount(fixture, 0n);

    assert.equal(await fixture.settlement.read.enrolled([fixture.user.account.address]), true);
    await assert.rejects(enrollAccount(fixture, 1n));
  });

  it("allows only the delegated operator to close an epoch", async () => {
    const fixture = await deployActiveRound();

    await assert.rejects(
      fixture.paymaster.write.closeEpoch({ account: fixture.creator.account }),
    );
    await fixture.paymaster.write.closeEpoch({ account: fixture.operator.account });

    assert.equal(await fixture.paymaster.read.currentEpoch(), 1n);
  });

  it("settles only exact claims for the next closed epoch", async () => {
    const fixture = await deployActiveRound();
    await enrollAccount(fixture, 0n);
    await enrollAccount(fixture, 1n, fixture.sponsor.account.address);
    await recordClaim(fixture, 123_456n);
    await recordClaim(fixture, 50n, fixture.sponsor.account.address);
    await fixture.paymaster.write.closeEpoch({ account: fixture.operator.account });

    await assert.rejects(settle(fixture, 0n, [123_455n]));
    await assert.rejects(settle(fixture, 1n, [123_456n]));
    await assert.rejects(
      settleClaims(
        fixture,
        0n,
        [fixture.auditor.account.address],
        [0n],
      ),
    );
    await assert.rejects(
      settleClaims(
        fixture,
        0n,
        [fixture.user.account.address, fixture.user.account.address],
        [123_456n, 123_456n],
      ),
    );
    await assert.rejects(settle(fixture, 0n, [123_456n]));
    await settleClaims(
      fixture,
      0n,
      [fixture.user.account.address, fixture.sponsor.account.address],
      [123_456n, 50n],
    );

    assert.equal(await fixture.settlement.read.settledEpochs(), 1n);
    await assert.rejects(settle(fixture, 0n, [123_456n]));
  });

  it("lets only the creator pause and rotate delegated roles", async () => {
    const fixture = await deployActiveRound();
    const outsider = fixture.sponsor;

    await assert.rejects(
      outsider.writeContract({
        address: fixture.paymaster.address,
        abi: roundAdminAbi,
        functionName: "setPaused",
        args: [true],
      }),
    );
    for (const address of [fixture.paymaster.address, fixture.settlement.address]) {
      await fixture.creator.writeContract({
        address,
        abi: roundAdminAbi,
        functionName: "setPaused",
        args: [true],
      });
    }
    const publicClient = await fixture.viem.getPublicClient();
    assert.equal(
      await publicClient.readContract({
        address: fixture.paymaster.address,
        abi: roundAdminAbi,
        functionName: "paused",
      }),
      true,
    );
    await fixture.creator.writeContract({
      address: fixture.paymaster.address,
      abi: roundAdminAbi,
      functionName: "setOperator",
      args: [outsider.account.address],
    });
    await fixture.creator.writeContract({
      address: fixture.settlement.address,
      abi: roundAdminAbi,
      functionName: "setOperator",
      args: [outsider.account.address],
    });
    await assert.rejects(
      fixture.paymaster.write.closeEpoch({ account: fixture.operator.account }),
    );
  });

  it("settles the final epoch before creator-only deposit and stake recovery", async () => {
    const fixture = await deployActiveRound();

    await assert.rejects(lifecycleWrite(fixture, "finalizeClose"));
    await lifecycleWrite(fixture, "requestClose");
    assert.equal(await fixture.paymaster.read.roundState(), 2);
    assert.equal(await fixture.paymaster.read.currentEpoch(), 1n);
    await assert.rejects(lifecycleWrite(fixture, "finalizeClose"));

    await settleEmptyEpoch(fixture, 0n);
    await lifecycleWrite(fixture, "finalizeClose");
    assert.equal(await fixture.paymaster.read.roundState(), 3);
    await assert.rejects(
      lifecycleWrite(fixture, "withdrawDeposit", fixture.sponsor),
    );
    await assert.rejects(
      lifecycleWrite(fixture, "unlockStake", fixture.sponsor),
    );
    await assert.rejects(
      lifecycleWrite(fixture, "withdrawStake", fixture.sponsor),
    );
    await lifecycleWrite(fixture, "withdrawDeposit");
    assert.equal(await fixture.paymaster.read.entryPointBalance(), 0n);

    await lifecycleWrite(fixture, "unlockStake");
    await assert.rejects(lifecycleWrite(fixture, "withdrawStake"));
    await fixture.networkHelpers.time.increase(61);
    await lifecycleWrite(fixture, "withdrawStake");
    assert.equal((await fixture.paymaster.read.stakeInfo())[0], 0n);
  });

  it("returns each remaining confidential budget once to its recorded sponsor", async () => {
    const fixture = await deployActiveRound();
    await registerSponsor(fixture, fixture.sponsor);
    await assert.rejects(
      fixture.sponsor.writeContract({
        address: fixture.vault.address,
        abi: vaultRecoveryAbi,
        functionName: "refundSponsor",
        args: [0n],
      }),
    );
    await lifecycleWrite(fixture, "requestClose");
    await settleEmptyEpoch(fixture, 0n);
    await lifecycleWrite(fixture, "finalizeClose");
    const beforeSponsor = await fixture.wrapper.read.confidentialBalanceOf([
      fixture.sponsor.account.address,
    ]);
    const beforeOutsider = await fixture.wrapper.read.confidentialBalanceOf([
      fixture.user.account.address,
    ]);
    const beforeBudget = await fixture.vault.read.budgetHandle([0n]);

    await assert.rejects(
      fixture.user.writeContract({
        address: fixture.vault.address,
        abi: vaultRecoveryAbi,
        functionName: "refundSponsor",
        args: [0n],
      }),
    );
    await fixture.sponsor.writeContract({
      address: fixture.vault.address,
      abi: vaultRecoveryAbi,
      functionName: "refundSponsor",
      args: [0n],
    });

    assert.equal(
      await fixture.vault.read.refunded([0n]),
      true,
    );
    assert.notEqual(await fixture.vault.read.budgetHandle([0n]), beforeBudget);
    assert.notEqual(
      await fixture.wrapper.read.confidentialBalanceOf([
        fixture.sponsor.account.address,
      ]),
      beforeSponsor,
    );
    assert.equal(
      await fixture.wrapper.read.confidentialBalanceOf([
        fixture.user.account.address,
      ]),
      beforeOutsider,
    );
    await assert.rejects(
      fixture.sponsor.writeContract({
        address: fixture.vault.address,
        abi: vaultRecoveryAbi,
        functionName: "refundSponsor",
        args: [0n],
      }),
    );
  });
});
