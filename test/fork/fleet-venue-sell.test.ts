import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther, type Address } from "viem";

import { ROBINHOOD_TESTNET_ROUTER } from "../../src/fleet/deploy.js";
import { encodeV4EthBuy, encodeV4TokenSell, estimateEthOut, sellApprovals, venuePoolKey } from "../../src/fleet/v4-swap.js";
import { connectRobinhoodFork } from "./robinhood-fork.js";

/** Verified live on 46630 (specs/001-fleet-mission/research.md, 2026-08-30). */
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const FULL_RANGE = { lower: -887_220, upper: 887_220 };
const isqrt = (n: bigint): bigint => { let x = n, y = (n + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
const SQRT_PRICE_1000 = isqrt(1000n * 2n ** 192n);

/**
 * The sell path on the real Uniswap v4 router, on a fork of 46630: a wallet
 * buys FLEET with ETH, approves Permit2 and the router once, and sells the
 * FLEET back for ETH. Round trip minus the pool fee, both ways through the
 * same encoder family. This is the primitive under the bot's Sell button
 * and under the pool's sell path.
 */
describe("Fleet venue sell on Uniswap v4 (46630 fork)", () => {
  it("buys FLEET, then sells it back for ETH through Permit2 and the router", async () => {
    const { viem } = await connectRobinhoodFork();
    const [deployer, trader] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    const token = await viem.deployContract("FleetVenueToken", [parseEther("1000000")]);
    const seeder = await viem.deployContract("FleetPoolSeeder", [POOL_MANAGER]);
    await token.write.approve([seeder.address, parseEther("1000000")]);
    await seeder.write.seed([venuePoolKey(token.address), SQRT_PRICE_1000, FULL_RANGE.lower, FULL_RANGE.upper, parseEther("0.3")], { value: parseEther("0.02") });
    void deployer;

    const block = await publicClient.getBlock();
    const deadline = block.timestamp + 3600n;
    const amountIn = parseEther("0.001");
    await trader!.sendTransaction({ to: ROBINHOOD_TESTNET_ROUTER, value: amountIn, data: encodeV4EthBuy({ token: token.address, amountIn, deadline }), gas: 600_000n });
    const bought = await token.read.balanceOf([trader!.account.address]);
    assert.ok(bought > 0n, "the trader holds FLEET");

    // The two approvals, once; then the sale.
    for (const approval of sellApprovals(token.address, ROBINHOOD_TESTNET_ROUTER, bought, Number(block.timestamp) + 86_400)) {
      await trader!.sendTransaction({ to: approval.to, data: approval.data });
    }
    const ethBefore = await publicClient.getBalance({ address: trader!.account.address });
    const hash = await trader!.sendTransaction({ to: ROBINHOOD_TESTNET_ROUTER, data: encodeV4TokenSell({ token: token.address, amountIn: bought, deadline }), gas: 600_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", "the sale landed");
    const ethAfter = await publicClient.getBalance({ address: trader!.account.address });
    const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice;
    const ethOut = ethAfter - ethBefore + gasPaid;
    assert.equal(await token.read.balanceOf([trader!.account.address]), 0n, "all the FLEET went back");
    assert.ok(ethOut > 0n, "ETH came out");
    // Two 0.3% fees and the price impact of a 0.001 ETH trade on a 0.02 ETH pool: back within a few percent.
    assert.ok(ethOut > (amountIn * 85n) / 100n && ethOut < amountIn, `round trip ${ethOut} wei of ${amountIn}`);
    const spot = estimateEthOut(bought, SQRT_PRICE_1000);
    console.log(`bought ${bought} FLEET for ${amountIn} wei, sold it all back for ${ethOut} wei (spot estimate ${spot})`);
    // The estimate is at the seed price; the buy moved the pool, so the fill lands above it. Same ballpark is the claim.
    assert.ok(spot > (ethOut * 8n) / 10n && spot < (ethOut * 12n) / 10n, `the spot estimate ${spot} is within 20% of the fill ${ethOut}`);
  });
});
