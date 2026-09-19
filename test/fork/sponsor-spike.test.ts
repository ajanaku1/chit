import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, keccak256, parseAbi, parseEther, parseEventLogs, stringToHex, type Address, type Hex } from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  ENTRYPOINT_V07,
  SIMPLE_ACCOUNT_ABI,
  SIMPLE_ACCOUNT_FACTORY_ABI,
  SIMPLE_ACCOUNT_FACTORY_V07,
  buildSponsoredOp,
  simpleAccountInitCode,
  spikeGasPlan,
} from "../../src/fleet/sponsored-op.js";
import { connectRobinhoodFork } from "./robinhood-fork.js";

const PROBE_ABI = parseAbi(["function ping(bytes32 note)", "event Pinged(address indexed account, bytes32 note)"]);
const PAYMASTER_EVENTS = parseAbi(["event Sponsored(bytes32 indexed campaign, bytes32 indexed key, address indexed sender)"]);

/**
 * The gas-sponsorship spike (proposals/gas-sponsorship-2026-09-15, SC-001 to
 * SC-003) on a fork of Robinhood Chain testnet, against the real EntryPoint
 * v0.7 and the real SimpleAccount factory that are live there.
 *
 * A throwaway smart account that has never held ETH makes one call to a
 * sponsor's contract. The operator signs the sponsorship, the paymaster
 * reserves the ceiling in the sponsor's escrow budget, the account is
 * deployed and runs the call, and postOp commits the cost, all inside one
 * `handleOps` that the operator itself submits. Nothing here is a route or a
 * product; it settles the proposal's three open questions (sender type,
 * bundler, what the budget actually pays) with numbers.
 */
describe("Gas sponsorship spike (46630 fork)", () => {
  const SPONSOR = keccak256(stringToHex("sponsor:spike"));

  const setup = async () => {
    const { viem } = await connectRobinhoodFork();
    const [operator, sponsor] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const chainId = await publicClient.getChainId();

    // Deployed first: a read on a fresh fork runs against the fork block
    // itself, which EDR refuses as historical for this chain.
    const probe = await viem.deployContract("FleetSponsorProbe");

    // The sender type on 46630: a smart account from the canonical factory,
    // whose implementation is bound to the same EntryPoint the paymaster is.
    const implementation = await publicClient.readContract({
      address: SIMPLE_ACCOUNT_FACTORY_V07, abi: SIMPLE_ACCOUNT_FACTORY_ABI, functionName: "accountImplementation",
    });
    const boundEntryPoint = await publicClient.readContract({ address: implementation, abi: SIMPLE_ACCOUNT_ABI, functionName: "entryPoint" });
    assert.equal(boundEntryPoint.toLowerCase(), ENTRYPOINT_V07, "the live SimpleAccount factory serves EntryPoint v0.7 accounts");

    const escrow = await viem.deployContract("FleetCampaignEscrow", [operator!.account.address]);
    const paymaster = await viem.deployContract("FleetPaymaster", [ENTRYPOINT_V07, operator!.account.address, escrow.address, 0]);
    await escrow.write.setSettler([paymaster.address]);
    await escrow.write.registerCampaign([SPONSOR, sponsor!.account.address]);
    await escrow.write.fund([SPONSOR], { account: sponsor!.account, value: parseEther("0.01") });
    // The paymaster's EntryPoint deposit is the operator's float: it fronts
    // each op and is refunded from the reservation; the escrow repays it.
    await paymaster.write.deposit({ value: parseEther("0.05") });

    const block = await publicClient.getBlock();
    const baseFee = block.baseFeePerGas ?? (await publicClient.getGasPrice());
    const plan = spikeGasPlan(baseFee);
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const validUntil = Number(block.timestamp > nowSec ? block.timestamp : nowSec) + 600;

    /** A fresh owner key; the account it controls has never existed on chain. */
    const throwaway = async () => {
      const owner = privateKeyToAccount(generatePrivateKey());
      const salt = 0n;
      const sender = await publicClient.readContract({
        address: SIMPLE_ACCOUNT_FACTORY_V07, abi: SIMPLE_ACCOUNT_FACTORY_ABI, functionName: "getAddress", args: [owner.address, salt],
      });
      assert.equal(await publicClient.getBalance({ address: sender }), 0n, "the account holds no ETH");
      assert.equal(await publicClient.getCode({ address: sender }), undefined, "the account is not deployed yet");
      return { owner, sender, initCode: simpleAccountInitCode(owner.address, salt) };
    };

    const readBudget = async () => {
      const [funded, reserved, spent, unused] = await escrow.read.budget([SPONSOR]);
      return { funded, reserved, spent, unused };
    };
    const readDeposit = () => publicClient.readContract({ address: ENTRYPOINT_V07, abi: entryPoint07Abi, functionName: "balanceOf", args: [paymaster.address] });

    return { viem, operator: operator!, sponsor: sponsor!, publicClient, chainId, probe, escrow, paymaster, plan, validUntil, throwaway, readBudget, readDeposit };
  };

  it("a smart account with zero ETH makes a sponsored call; the sponsor's budget pays what the op cost", async () => {
    const { operator, publicClient, chainId, probe, escrow, paymaster, plan, validUntil, throwaway, readBudget, readDeposit } = await setup();
    const { owner, sender, initCode } = await throwaway();
    const key = keccak256(stringToHex(`spike:${sender}:0`));
    const note = keccak256(stringToHex("hello from an account with no eth"));

    const { op, maxCost } = await buildSponsoredOp({
      sender, initCode, nonce: 0n,
      target: probe.address, data: encodeFunctionData({ abi: PROBE_ABI, functionName: "ping", args: [note] }),
      plan, paymaster: paymaster.address, sponsor: SPONSOR, key, chainId, validUntil,
      signSponsorship: (digest) => operator.signMessage({ message: { raw: digest } }),
    });
    // The account's owner signs the EntryPoint's hash of the whole op (which
    // already carries the sponsorship); the sponsorship itself never depended
    // on this signature, so neither side can be forged from the other.
    const userOpHash = await publicClient.readContract({ address: ENTRYPOINT_V07, abi: entryPoint07Abi, functionName: "getUserOpHash", args: [op] });
    const signed = { ...op, signature: await owner.signMessage({ message: { raw: userOpHash } }) };

    const budgetBefore = await readBudget();
    const depositBefore = await readDeposit();
    const operatorBefore = await publicClient.getBalance({ address: operator.account.address });

    // The operator is the bundler: it submits handleOps itself and names
    // itself beneficiary, so the EntryPoint pays the op's gas back to it. The
    // outer transaction is priced as the op is, or the refund (at the op's
    // price) would not match what the bundler paid (at the node's default).
    const hash = await operator.writeContract({
      address: ENTRYPOINT_V07, abi: entryPoint07Abi, functionName: "handleOps", args: [[signed], operator.account.address],
      gas: 2_000_000n, maxFeePerGas: plan.maxFeePerGas, maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", "handleOps landed");

    const [opEvent] = parseEventLogs({ abi: entryPoint07Abi, eventName: "UserOperationEvent", logs: receipt.logs });
    assert.ok(opEvent, "the EntryPoint reported the op");
    assert.equal(opEvent.args.success, true, "the op succeeded");
    assert.equal(opEvent.args.userOpHash, userOpHash);
    assert.equal(opEvent.args.paymaster.toLowerCase(), paymaster.address.toLowerCase());

    // SC-001: the call ran from an account that held no ETH before and holds none after.
    const [pinged] = parseEventLogs({ abi: PROBE_ABI, eventName: "Pinged", logs: receipt.logs });
    assert.equal(pinged?.args.account.toLowerCase(), sender.toLowerCase(), "the probe saw the smart account");
    assert.equal(pinged?.args.note, note);
    assert.equal(await probe.read.pings([sender]), 1n);
    assert.equal(await publicClient.getBalance({ address: sender }), 0n, "the account still holds no ETH");
    assert.ok((await publicClient.getCode({ address: sender }))?.length, "the account was deployed by the same op");
    assert.equal((await publicClient.readContract({ address: sender, abi: SIMPLE_ACCOUNT_ABI, functionName: "owner" })).toLowerCase(), owner.address.toLowerCase());

    // SC-002: the budget fell by the op's cost, never by the reservation ceiling.
    const [sponsored] = parseEventLogs({ abi: PAYMASTER_EVENTS, eventName: "Sponsored", logs: receipt.logs });
    assert.equal(sponsored?.args.key, key, "the paymaster settled this op's reservation");
    const reservation = await escrow.read.reservationOf([SPONSOR, key]);
    assert.equal(reservation.state, 2, "Committed");
    assert.equal(reservation.amount, maxCost, "the ceiling reserved was the EntryPoint's prefund");
    const budgetAfter = await readBudget();
    assert.equal(budgetAfter.reserved, 0n, "nothing left reserved");
    const spent = budgetAfter.spent - budgetBefore.spent;
    assert.ok(spent > 0n, "the budget paid something");
    assert.ok(spent < maxCost, `the budget paid ${spent} wei, under the ${maxCost} wei ceiling`);
    assert.equal(budgetAfter.funded, budgetBefore.funded, "the sponsor's own funding is untouched");

    // The operator's real outlay is the outer transaction's gas. The
    // EntryPoint moves the op's cost from the paymaster's deposit to the
    // beneficiary, both the operator's, so that cancels; what the sponsor's
    // budget commits is what comes back. The rest is the operator's until a
    // fee covers it: postOp is handed a cost that predates its own gas and
    // the unused-gas penalty. Measured here, not assumed.
    const depositAfter = await readDeposit();
    const chargedToDeposit = depositBefore - depositAfter;
    assert.equal(chargedToDeposit, opEvent.args.actualGasCost, "the deposit paid exactly what the EntryPoint reported");
    assert.ok(spent <= chargedToDeposit, "the escrow commit never exceeds the EntryPoint's charge");
    const operatorAfter = await publicClient.getBalance({ address: operator.account.address });
    assert.equal(operatorBefore - operatorAfter, receipt.gasUsed * receipt.effectiveGasPrice - chargedToDeposit, "the beneficiary refund is the deposit charge");
    const outlay = receipt.gasUsed * receipt.effectiveGasPrice;
    const uncovered = outlay - spent;
    console.log(
      `first op (deploys the account): ${opEvent.args.actualGasUsed} gas by the EntryPoint's count, ${receipt.gasUsed} gas on the bundler's transaction at ${receipt.effectiveGasPrice} wei/gas; ` +
        `operator outlay ${outlay} wei, sponsor budget committed ${spent} wei, uncovered ${uncovered} wei (${Number((uncovered * 10_000n) / outlay) / 100}% of the outlay); ` +
        `deposit charged ${chargedToDeposit} wei and refunded to the beneficiary`,
    );

    // A second op from the now-existing account: the steady-state cost of a
    // sponsored call, without the deployment.
    const nonce = await publicClient.readContract({ address: ENTRYPOINT_V07, abi: entryPoint07Abi, functionName: "getNonce", args: [sender, 0n] });
    assert.equal(nonce, 1n, "the account's nonce advanced");
    const key2 = keccak256(stringToHex(`spike:${sender}:1`));
    const second = await buildSponsoredOp({
      sender, initCode: "0x", nonce,
      target: probe.address, data: encodeFunctionData({ abi: PROBE_ABI, functionName: "ping", args: [note] }),
      plan, paymaster: paymaster.address, sponsor: SPONSOR, key: key2, chainId, validUntil,
      signSponsorship: (digest) => operator.signMessage({ message: { raw: digest } }),
    });
    const hash2 = await publicClient.readContract({ address: ENTRYPOINT_V07, abi: entryPoint07Abi, functionName: "getUserOpHash", args: [second.op] });
    const signed2 = { ...second.op, signature: await owner.signMessage({ message: { raw: hash2 } }) };
    const depositMid = await readDeposit();
    const budgetMid = await readBudget();
    const receipt2 = await publicClient.waitForTransactionReceipt({
      hash: await operator.writeContract({
        address: ENTRYPOINT_V07, abi: entryPoint07Abi, functionName: "handleOps", args: [[signed2], operator.account.address],
        gas: 2_000_000n, maxFeePerGas: plan.maxFeePerGas, maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
      }),
    });
    const [opEvent2] = parseEventLogs({ abi: entryPoint07Abi, eventName: "UserOperationEvent", logs: receipt2.logs });
    assert.equal(opEvent2?.args.success, true, "the second op succeeded");
    assert.equal(await probe.read.pings([sender]), 2n);
    assert.equal(await publicClient.getBalance({ address: sender }), 0n, "still no ETH in the account");
    const spent2 = (await readBudget()).spent - budgetMid.spent;
    const charged2 = depositMid - (await readDeposit());
    assert.ok(spent2 > 0n && spent2 < second.maxCost);
    const outlay2 = receipt2.gasUsed * receipt2.effectiveGasPrice;
    console.log(
      `second op (account exists): ${opEvent2!.args.actualGasUsed} gas by the EntryPoint's count, ${receipt2.gasUsed} gas on the bundler's transaction at ${receipt2.effectiveGasPrice} wei/gas; ` +
        `operator outlay ${outlay2} wei, sponsor budget committed ${spent2} wei, uncovered ${outlay2 - spent2} wei (${Number(((outlay2 - spent2) * 10_000n) / outlay2) / 100}% of the outlay); ` +
        `deposit charged ${charged2} wei`,
    );
  });

  it("an op the operator did not sponsor is refused before the account exists or the budget moves", async () => {
    const { operator, sponsor, publicClient, chainId, probe, escrow, paymaster, plan, validUntil, throwaway, readBudget, readDeposit } = await setup();
    const { owner, sender, initCode } = await throwaway();
    const key = keccak256(stringToHex(`spike:${sender}:forged`));

    // Signed by the sponsor's wallet, not the operator: the policy check that
    // /api/sponsor would run never happened, and the chain must not trust it.
    const { op } = await buildSponsoredOp({
      sender, initCode, nonce: 0n,
      target: probe.address, data: encodeFunctionData({ abi: PROBE_ABI, functionName: "ping", args: [keccak256(stringToHex("forged"))] }),
      plan, paymaster: paymaster.address, sponsor: SPONSOR, key, chainId, validUntil,
      signSponsorship: (digest) => sponsor.signMessage({ message: { raw: digest } }),
    });
    const userOpHash = await publicClient.readContract({ address: ENTRYPOINT_V07, abi: entryPoint07Abi, functionName: "getUserOpHash", args: [op] });
    const signed = { ...op, signature: await owner.signMessage({ message: { raw: userOpHash } }) };

    const budgetBefore = await readBudget();
    const depositBefore = await readDeposit();
    await assert.rejects(
      operator.writeContract({
        address: ENTRYPOINT_V07, abi: entryPoint07Abi, functionName: "handleOps", args: [[signed], operator.account.address],
        gas: 2_000_000n, maxFeePerGas: plan.maxFeePerGas, maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
      }),
      /AA34|signature error|FailedOp/i,
      "the EntryPoint drops the op on the paymaster's signature failure",
    );
    assert.equal(await publicClient.getCode({ address: sender }), undefined, "the account was never deployed");
    assert.equal((await escrow.read.reservationOf([SPONSOR, key])).state, 0, "nothing reserved");
    assert.deepEqual(await readBudget(), budgetBefore, "the budget did not move");
    assert.equal(await readDeposit(), depositBefore, "the deposit did not move");
  });
});
