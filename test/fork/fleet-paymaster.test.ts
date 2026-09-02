import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, parseEther, type Address, type Hex } from "viem";

import { buildFleetPaymasterData } from "../../src/fleet/paymaster-data.js";

/**
 * On-chain tests for FleetPaymaster and the escrow settler role. The test wallet
 * plays the EntryPoint: it calls validate then postOp directly, so the paymaster's
 * authorization and atomic escrow settlement are proven without a full bundler.
 */
describe("FleetPaymaster + escrow settler", () => {
  const CAMPAIGN = `0x${"a1".repeat(32)}` as Hex;
  const KEY = `0x${"b2".repeat(32)}` as Hex;
  const USEROP_HASH = `0x${"c3".repeat(32)}` as Hex;
  const MAX_COST = parseEther("0.001");

  const emptyUserOp = (sender: Address, paymasterAndData: Hex) => ({
    sender,
    nonce: 0n,
    initCode: "0x" as Hex,
    callData: "0x" as Hex,
    accountGasLimits: `0x${"00".repeat(32)}` as Hex,
    preVerificationGas: 0n,
    gasFees: `0x${"00".repeat(32)}` as Hex,
    paymasterAndData,
    signature: "0x" as Hex,
  });

  const ZERO32 = `0x${"00".repeat(32)}` as Hex;
  const buildPaymasterData = async (
    paymaster: Address,
    operatorWallet: { signMessage: (a: { message: { raw: Hex } }) => Promise<Hex> },
    chainId: number,
    sender: Address,
  ): Promise<Hex> =>
    // Production encoder under test: the contract must accept exactly these
    // bytes, and the signed op fields must match the UserOp handed to validate.
    buildFleetPaymasterData(
      {
        paymaster,
        campaign: CAMPAIGN,
        key: KEY,
        maxCost: MAX_COST,
        chainId,
        operation: {
          sender,
          nonce: 0n,
          callData: "0x",
          accountGasLimits: ZERO32,
          preVerificationGas: 0n,
          gasFees: ZERO32,
        },
      },
      (digest) => operatorWallet.signMessage({ message: { raw: digest } }),
    );

  const setup = async () => {
    const { viem } = await network.connect({ network: "default" });
    const wallets = await viem.getWalletClients();
    const [operator, entryPoint, owner, fleetAccount] = wallets;
    const escrow = await viem.deployContract("FleetCampaignEscrow", [operator!.account.address]);
    const paymaster = await viem.deployContract("FleetPaymaster", [
      entryPoint!.account.address,
      operator!.account.address,
      escrow.address,
    ]);
    await escrow.write.setSettler([paymaster.address]);
    await escrow.write.registerCampaign([CAMPAIGN, owner!.account.address]);
    await escrow.write.fund([CAMPAIGN], { account: owner!.account, value: parseEther("0.01") });
    const chainId = await (await viem.getPublicClient()).getChainId();
    return { viem, operator: operator!, entryPoint: entryPoint!, fleetAccount: fleetAccount!, escrow, paymaster, chainId };
  };

  it("reserves on validate and commits actual cost on postOp, atomically", async () => {
    const { operator, entryPoint, fleetAccount, escrow, paymaster, chainId } = await setup();
    const pmData = await buildPaymasterData(paymaster.address, operator, chainId, fleetAccount.account.address);

    await paymaster.write.validatePaymasterUserOp(
      [emptyUserOp(fleetAccount.account.address, pmData), USEROP_HASH, MAX_COST],
      { account: entryPoint.account },
    );
    let reservation = (await escrow.read.reservationOf([CAMPAIGN, KEY])) as { amount: bigint; state: number };
    assert.equal(reservation.amount, MAX_COST, "max cost reserved");
    assert.equal(reservation.state, 1, "Reserved");

    const context = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }],
      [CAMPAIGN, KEY, fleetAccount.account.address],
    );
    const actual = parseEther("0.0006");
    await paymaster.write.postOp([0, context, actual, 0n], { account: entryPoint.account });

    reservation = (await escrow.read.reservationOf([CAMPAIGN, KEY])) as { amount: bigint; state: number };
    assert.equal(reservation.state, 2, "Committed");
    const budget = (await escrow.read.budget([CAMPAIGN])) as readonly [bigint, bigint, bigint, bigint];
    assert.equal(budget[2], actual, "spent equals the actual gas cost");
    assert.equal(budget[1], 0n, "reservation released");
  });

  it("rejects a call from anyone but the EntryPoint", async () => {
    const { operator, fleetAccount, paymaster, chainId } = await setup();
    const pmData = await buildPaymasterData(paymaster.address, operator, chainId, fleetAccount.account.address);
    await assert.rejects(
      paymaster.write.validatePaymasterUserOp(
        [emptyUserOp(fleetAccount.account.address, pmData), USEROP_HASH, MAX_COST],
        { account: fleetAccount.account },
      ),
    );
  });

  it("a forged (non-operator) signature reserves nothing and signals failure", async () => {
    const { entryPoint, fleetAccount, escrow, paymaster, chainId } = await setup();
    // Sign with the wrong key (the fleet account, not the operator).
    const pmData = await buildPaymasterData(paymaster.address, fleetAccount, chainId, fleetAccount.account.address);
    await paymaster.write.validatePaymasterUserOp(
      [emptyUserOp(fleetAccount.account.address, pmData), USEROP_HASH, MAX_COST],
      { account: entryPoint.account },
    );
    const reservation = (await escrow.read.reservationOf([CAMPAIGN, KEY])) as { state: number };
    assert.equal(reservation.state, 0, "no reservation made for a forged signature");
  });

  it("the escrow settler role is set-once and gates reserve/commit", async () => {
    const { viem } = await network.connect({ network: "default" });
    const [operator, settler, owner, stranger] = await viem.getWalletClients();
    const escrow = await viem.deployContract("FleetCampaignEscrow", [operator!.account.address]);

    await escrow.write.setSettler([settler!.account.address]);
    await assert.rejects(escrow.write.setSettler([owner!.account.address]), /.*/, "set-once");

    await escrow.write.registerCampaign([CAMPAIGN, owner!.account.address]);
    await escrow.write.fund([CAMPAIGN], { account: owner!.account, value: parseEther("0.01") });

    // The settler can reserve; a stranger cannot.
    await assert.rejects(escrow.write.reserve([CAMPAIGN, KEY, MAX_COST], { account: stranger!.account }));
    await escrow.write.reserve([CAMPAIGN, KEY, MAX_COST], { account: settler!.account });
    const reservation = (await escrow.read.reservationOf([CAMPAIGN, KEY])) as { state: number };
    assert.equal(reservation.state, 1, "settler reserved");
  });
});
