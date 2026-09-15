import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, parseAbi, parseEther, parseEventLogs, toFunctionSelector, type Hex } from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import { createSponsorChain } from "../../src/fleet/sponsor-chain.js";
import { SponsorRouter } from "../../src/fleet/sponsor-routes.js";
import { SponsorService } from "../../src/fleet/sponsor-service.js";
import { MemorySponsorStore } from "../../src/fleet/sponsor-store.js";
import { ENTRYPOINT_V07, SIMPLE_ACCOUNT_FACTORY_ABI, SIMPLE_ACCOUNT_FACTORY_V07, simpleAccountInitCode } from "../../src/fleet/sponsored-op.js";
import { encodeExecuteCall } from "../../src/fleet/user-operation.js";
import type { Address, AuthEnvelope } from "../../src/fleet/types.js";
import { connectRobinhoodFork } from "./robinhood-fork.js";

const PROBE_ABI = parseAbi(["function ping(bytes32 note)", "function pings(address) view returns (uint256)"]);
const PING = toFunctionSelector("ping(bytes32)");

/**
 * The gas-sponsorship product, end to end, on a fork of 46630: a dapp
 * registers through the signed route, funds its budget from its own wallet,
 * a user with a smart account that holds no ETH gets an op sponsored through
 * the route with no login, signs it, and the route bundles it. The escrow is
 * charged the cost plus the paymaster's fee, the dashboard shows the op by
 * user hash, and an op outside the policy never gets a signature.
 */
describe("Gas sponsorship product (46630 fork)", () => {
  it("register, fund, sponsor, submit: the budget pays cost plus fee, the user pays nothing", async () => {
    const { viem } = await connectRobinhoodFork();
    const [operator, dapp] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    const probe = await viem.deployContract("FleetSponsorProbe");
    const escrow = await viem.deployContract("FleetCampaignEscrow", [operator!.account.address]);
    const FEE_BPS = 2000;
    const paymaster = await viem.deployContract("FleetPaymaster", [ENTRYPOINT_V07, operator!.account.address, escrow.address, FEE_BPS]);
    await escrow.write.setSettler([paymaster.address]);
    await paymaster.write.deposit({ value: parseEther("0.05") });

    const config = { origin: "https://chit.tools", chainId: 46630, maxTtlSeconds: 300 };
    const auth = new CampaignService(config);
    const chain = createSponsorChain(operator!, publicClient, { paymaster: paymaster.address, escrow: escrow.address });
    const service = new SponsorService({ store: new MemorySponsorStore(), chain });
    const router = new SponsorRouter({ auth, service });
    const signed = async (action: string, body: Record<string, unknown>) => {
      const hash = payloadHash(body);
      const challenge = auth.issueChallenge({ primaryWallet: dapp!.account.address, action, payloadHash: hash });
      const fields = { primaryWallet: dapp!.account.address, nonce: challenge.nonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt, action, payloadHash: hash };
      const envelope: AuthEnvelope = { ...fields, signature: await dapp!.signMessage({ message: challengeBytes(config, fields) }) };
      return router.handle({ action, body, auth: envelope });
    };

    // The sponsor's side, once.
    const info = (await router.handle({ action: "info" })).body as { feeBps: number; escrow: Address; paymaster: Address };
    assert.equal(info.feeBps, FEE_BPS, "the fee is read from the contract");
    const reg = await signed("register", {
      policy: { targets: [{ address: probe.address, selectors: [PING] }], maxCostPerOp: parseEther("0.001").toString(), maxPerUserPerDay: parseEther("0.003").toString(), maxPerSponsorPerDay: parseEther("0.01").toString() },
    });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    const { sponsor } = reg.body as { sponsor: Hex };
    assert.equal((await escrow.read.ownerOf([sponsor])).toLowerCase(), dapp!.account.address.toLowerCase(), "registered in the escrow to the dapp's wallet");
    await escrow.write.fund([sponsor], { account: dapp!.account, value: parseEther("0.01") });

    // The user's side: an account that has never existed, holding nothing.
    const owner = privateKeyToAccount(generatePrivateKey());
    const sender = await publicClient.readContract({ address: SIMPLE_ACCOUNT_FACTORY_V07, abi: SIMPLE_ACCOUNT_FACTORY_ABI, functionName: "getAddress", args: [owner.address, 0n] });
    assert.equal(await publicClient.getBalance({ address: sender }), 0n);
    const baseFee = (await publicClient.getBlock()).baseFeePerGas ?? (await publicClient.getGasPrice());
    const op = {
      sender, nonce: "0", initCode: simpleAccountInitCode(owner.address, 0n),
      callData: encodeExecuteCall(probe.address, "0", encodeFunctionData({ abi: PROBE_ABI, functionName: "ping", args: [`0x${"11".repeat(32)}`] })),
      callGasLimit: "150000", verificationGasLimit: "600000", preVerificationGas: "60000",
      maxFeePerGas: (baseFee * 4n).toString(), maxPriorityFeePerGas: "0",
    };
    const s = await router.handle({ action: "sponsor", body: { sponsor, op } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const sponsorship = s.body as { paymasterAndData: Hex; key: Hex; maxCost: string; maxCharged: string };
    assert.equal(BigInt(sponsorship.maxCharged), BigInt(sponsorship.maxCost) * 12n / 10n);

    // The dapp packs the op with the sponsorship, the user signs the EntryPoint's hash, the dapp sends it back.
    const packed = {
      sender, nonce: "0", initCode: op.initCode, callData: op.callData,
      accountGasLimits: `0x${(600000n).toString(16).padStart(32, "0")}${(150000n).toString(16).padStart(32, "0")}`,
      preVerificationGas: "60000",
      gasFees: `0x${"0".repeat(32)}${(baseFee * 4n).toString(16).padStart(32, "0")}`,
      paymasterAndData: sponsorship.paymasterAndData,
      signature: "0x",
    };
    const userOpHash = await publicClient.readContract({
      address: ENTRYPOINT_V07, abi: entryPoint07Abi, functionName: "getUserOpHash",
      args: [{ ...packed, nonce: 0n, preVerificationGas: 60000n, accountGasLimits: packed.accountGasLimits as Hex, gasFees: packed.gasFees as Hex, signature: "0x" as Hex }],
    });
    const signature = await owner.signMessage({ message: { raw: userOpHash } });
    const budgetBefore = await escrow.read.budget([sponsor]);
    const landed = await router.handle({ action: "submit", body: { op: { ...packed, signature } } });
    assert.equal(landed.status, 200, JSON.stringify(landed.body));
    const result = landed.body as { txHash: Hex; userOpHash: Hex; success: boolean; charged: string };
    assert.equal(result.success, true);
    assert.equal(result.userOpHash, userOpHash);

    // SC-001, SC-002: the call ran, the user still has nothing, the budget fell by cost plus fee.
    assert.equal(await probe.read.pings([sender]), 1n);
    assert.equal(await publicClient.getBalance({ address: sender }), 0n);
    const budgetAfter = await escrow.read.budget([sponsor]);
    const charged = budgetAfter[2] - budgetBefore[2];
    assert.equal(charged.toString(), result.charged, "the route reports what the escrow committed");
    assert.equal(budgetAfter[1], 0n, "nothing left reserved");
    assert.ok(charged < BigInt(sponsorship.maxCharged), "never the ceiling");
    const receipt = await publicClient.getTransactionReceipt({ hash: result.txHash });
    const [ev] = parseEventLogs({ abi: entryPoint07Abi, eventName: "UserOperationEvent", logs: receipt.logs });
    // postOp is handed a cost below the event's (no postOp gas, no penalty), and the fee is 20% on that figure.
    assert.ok(charged > 0n && charged <= (ev!.args.actualGasCost * 12n) / 10n, "cost plus 20%, on postOp's figure");
    const outlay = receipt.gasUsed * receipt.effectiveGasPrice;
    console.log(`sponsored through the route: bundler outlay ${outlay} wei, EntryPoint charge ${ev!.args.actualGasCost} wei, budget charged ${charged} wei with the ${FEE_BPS} bps fee: the budget covers ${Number((charged * 10_000n) / outlay) / 100}% of the outlay`);

    // The dashboard: by user hash, with the transaction, never the address.
    const status = (await signed("status", { sponsor })).body as { ops: Array<{ txHash: Hex; charged: string; userHash: Hex }>; budget: { spent: string } };
    assert.equal(status.ops[0]?.txHash, result.txHash);
    assert.equal(status.ops[0]?.charged, result.charged);
    assert.equal(status.budget.spent, budgetAfter[2].toString());
    assert.ok(!JSON.stringify(status).toLowerCase().includes(sender.toLowerCase()));

    // Outside the policy: refused before any signature, so nothing to submit and nothing reserved.
    const elsewhere = await router.handle({ action: "sponsor", body: { sponsor, op: { ...op, nonce: "1", callData: encodeExecuteCall(escrow.address, "0", "0x12345678") } } });
    assert.equal(elsewhere.status, 422);
    assert.equal((elsewhere.body as { reason: string }).reason, "target_not_allowed");
    assert.equal((await escrow.read.budget([sponsor]))[1], 0n);
  });
});
