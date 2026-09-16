import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, formatEther, parseAbi, parseEther, type Address, type Hex } from "viem";

import { connectRobinhoodMainnetFork } from "./robinhood-fork.js";

/**
 * ChitBuyback against the real CHIT/ETH pool on a fork of Robinhood Chain
 * mainnet: fund it, let anyone call buyAndBurn, watch CHIT leave the supply.
 * The pool key and the hook's fee were read from the chain on 2026-09-16
 * (docs/chit-buyback.md); the numbers here are read again at test time.
 */

/** Verified on 4663 (docs/chit-buyback.md). */
const CHIT: Address = "0xd523a627030509021cc39b6d7c8543417d3e50d8";
const ROUTER: Address = "0x8876789976decbfcbbbe364623c63652db8c0904";
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const HOOK: Address = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
const POOL_FEE = 0;
const POOL_TICK_SPACING = 200;
const POOL_ID: Hex = "0x84a4f18cfab0b389a63c4d8a56d08f021a6fd5efb0b0b3617cfbbd6706f09f41";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function transfer(address, uint256) returns (bool)"]);
const BUYBACK_EVENTS = parseAbi([
  "event Funded(address indexed from, uint256 amount, uint256 balance)",
  "event BoughtAndBurned(address indexed caller, uint256 ethIn, uint256 tokensBought, uint256 tokensBurned, uint256 totalSpent, uint256 totalBurned)",
]);

/** The defaults proposed for the live contract: 1% of the balance per call, 0.002 to 0.1 ETH, once an hour, 5% under the zero-fee quote (the hook's 2% inside it). */
const PARAMS = { spendBps: 100, minSpend: parseEther("0.002"), maxSpend: parseEther("0.1"), interval: 3600, maxSlipBps: 500 } as const;

describe("ChitBuyback on the 4663 fork", () => {
  it("buys CHIT from the real pool and burns it, sized by the balance, once per interval, by anyone", async () => {
    const { viem, provider } = await connectRobinhoodMainnetFork();
    const [deployer, someone] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    // A fresh fork answers eth_call only after a block of its own.
    await provider.request({ method: "evm_mine", params: [] });

    const deployArgs = [CHIT, ROUTER, POOL_MANAGER, POOL_FEE, POOL_TICK_SPACING, HOOK, PARAMS.spendBps, PARAMS.minSpend, PARAMS.maxSpend, PARAMS.interval, PARAMS.maxSlipBps] as const;
    const buyback = await viem.deployContract("ChitBuyback", [...deployArgs]);
    assert.equal((await buyback.read.poolId()).toLowerCase(), POOL_ID, "the pool id is the one the chain initialised");
    const [sqrtP, liquidity] = await buyback.read.poolState();
    assert.ok(sqrtP > 0n && liquidity > 0n, "the pool has a price and liquidity");

    // The dev's seed: 1 ETH, by plain transfer.
    const seed = await deployer!.sendTransaction({ to: buyback.address, value: parseEther("1") });
    const seedReceipt = await publicClient.waitForTransactionReceipt({ hash: seed });
    const funded = seedReceipt.logs.map((l) => { try { return decodeEventLog({ abi: BUYBACK_EVENTS, data: l.data, topics: l.topics }); } catch { return undefined; } }).find((e) => e?.eventName === "Funded");
    assert.ok(funded, "Funded was emitted");
    assert.equal(await buyback.read.totalReceived(), parseEther("1"));
    assert.equal(await buyback.read.nextSpend(), parseEther("0.01"), "1% of 1 ETH");

    // The quote is the zero-fee fill; the hook takes its cut on top, inside the 5% the contract accepts.
    const quoted = await buyback.read.quote([parseEther("0.01")]);
    assert.ok(quoted > 0n);
    const supplyBefore = await publicClient.readContract({ address: CHIT, abi: ERC20, functionName: "totalSupply" });

    // Anyone calls it: the second account, not the deployer.
    const hash = await someone!.writeContract({ address: buyback.address, abi: buyback.abi, functionName: "buyAndBurn" });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", "the buy and burn landed");
    const burned = receipt.logs.map((l) => { try { return decodeEventLog({ abi: BUYBACK_EVENTS, data: l.data, topics: l.topics }); } catch { return undefined; } }).find((e) => e?.eventName === "BoughtAndBurned");
    assert.ok(burned && burned.eventName === "BoughtAndBurned");
    const { ethIn, tokensBought, tokensBurned, totalSpent, totalBurned } = burned.args;
    assert.equal(ethIn, parseEther("0.01"));
    assert.equal(tokensBurned, tokensBought, "everything bought is burned");
    assert.equal(totalSpent, parseEther("0.01"));
    assert.equal(totalBurned, tokensBought);
    const fee = 1 - Number(tokensBought) / Number(quoted);
    console.log(`bought ${formatEther(tokensBought)} CHIT for 0.01 ETH; quote ${formatEther(quoted)}; the hook took ${(fee * 100).toFixed(2)}%`);
    assert.ok(fee > 0.015 && fee < 0.03, `the hook's fee is about 2%, inside the guard: ${fee}`);
    assert.ok(tokensBought >= (quoted * 9500n) / 10000n, "within the 5% guard");
    const supplyAfter = await publicClient.readContract({ address: CHIT, abi: ERC20, functionName: "totalSupply" });
    assert.equal(supplyBefore - supplyAfter, tokensBurned, "the supply fell by exactly what was burned");
    assert.equal(await publicClient.readContract({ address: CHIT, abi: ERC20, functionName: "balanceOf", args: [buyback.address] }), 0n, "the contract keeps no token");
    assert.equal(await publicClient.getBalance({ address: buyback.address }), parseEther("0.99"));
    assert.equal(await buyback.read.buys(), 1n);

    // Too soon: the interval holds.
    await assert.rejects(someone!.writeContract({ address: buyback.address, abi: buyback.abi, functionName: "buyAndBurn" }), /TooSoon/);

    // An hour later: 1% of what is left, and CHIT sent here directly burns with it.
    await provider.request({ method: "evm_increaseTime", params: [PARAMS.interval] });
    await provider.request({ method: "evm_mine", params: [] });
    assert.equal(await buyback.read.nextSpend(), parseEther("0.0099"));
    const second = await someone!.writeContract({ address: buyback.address, abi: buyback.abi, functionName: "buyAndBurn" });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash: second })).status, "success");
    assert.equal(await buyback.read.totalSpent(), parseEther("0.0199"));
    assert.equal(await buyback.read.buys(), 2n);

    // The floor: a nearly empty contract spends minSpend, then the last of it, then nothing.
    const small = await viem.deployContract("ChitBuyback", [...deployArgs]);
    await deployer!.sendTransaction({ to: small.address, value: parseEther("0.003") });
    assert.equal(await small.read.nextSpend(), PARAMS.minSpend, "1% of 0.003 is under the floor, so the floor");
    const s1 = await someone!.writeContract({ address: small.address, abi: small.abi, functionName: "buyAndBurn" });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash: s1 })).status, "success");
    assert.equal(await small.read.nextSpend(), parseEther("0.001"), "less than the floor is left, so all of it");
    await provider.request({ method: "evm_increaseTime", params: [PARAMS.interval] });
    await provider.request({ method: "evm_mine", params: [] });
    const s2 = await someone!.writeContract({ address: small.address, abi: small.abi, functionName: "buyAndBurn" });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash: s2 })).status, "success");
    assert.equal(await publicClient.getBalance({ address: small.address }), 0n, "spent to the last wei");
    await provider.request({ method: "evm_increaseTime", params: [PARAMS.interval] });
    await provider.request({ method: "evm_mine", params: [] });
    await assert.rejects(someone!.writeContract({ address: small.address, abi: small.abi, functionName: "buyAndBurn" }), /NothingToSpend/);

    // The cap: a big deposit is spent 0.1 ETH at a time, not all at once.
    const big = await viem.deployContract("ChitBuyback", [...deployArgs]);
    await deployer!.sendTransaction({ to: big.address, value: parseEther("50") });
    assert.equal(await big.read.nextSpend(), PARAMS.maxSpend, "1% of 50 is 0.5, capped at 0.1");

    // The guard: a contract that accepts only 1% under the quote refuses every fill, because the hook takes 2%.
    const strict = await viem.deployContract("ChitBuyback", [CHIT, ROUTER, POOL_MANAGER, POOL_FEE, POOL_TICK_SPACING, HOOK, PARAMS.spendBps, PARAMS.minSpend, PARAMS.maxSpend, PARAMS.interval, 100]);
    await deployer!.sendTransaction({ to: strict.address, value: parseEther("1") });
    await assert.rejects(someone!.writeContract({ address: strict.address, abi: strict.abi, functionName: "buyAndBurn" }), /V4TooLittleReceived|TooLittleOut|revert/);
    assert.equal(await publicClient.getBalance({ address: strict.address }), parseEther("1"), "a refused fill spends nothing");

    // Nothing can take the ETH out: no such function exists, and a call with unknown data reverts.
    await assert.rejects(deployer!.sendTransaction({ to: buyback.address, data: encodeFunctionData({ abi: parseAbi(["function withdraw(uint256)"]), functionName: "withdraw", args: [1n] }) }));
    void encodeAbiParameters;
  });
});
