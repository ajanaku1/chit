import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, type Address, type Hex } from "viem";

import { runFleetBuy } from "../../src/fleet/chain-buy.js";
import { ROBINHOOD_TESTNET_ROUTER } from "../../src/fleet/deploy.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, encodeV4EthBuy, venuePoolKey } from "../../src/fleet/v4-swap.js";

/** Verified live on 46630 (specs/001-fleet-mission/research.md, 2026-08-30). */
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const FULL_RANGE = { lower: -887_220, upper: 887_220 };

const isqrt = (n: bigint): bigint => {
  let x = n, y = (n + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
};
/** sqrt(price) * 2^96 for a pool priced at 1 ETH = 1000 FLEET. */
const SQRT_PRICE_1000 = isqrt(1000n * 2n ** 192n);

/**
 * Venue done-check on a fork of Robinhood Chain testnet: seed a real Uniswap v4
 * ETH/FLEET pool through the live PoolManager, then have the operator sponsor
 * a bounded buy through the live Universal Router from a policy-gated fleet
 * account. The account ends holding FLEET; the escrow paid only the gas.
 */
describe("Fleet venue on Uniswap v4 (46630 fork)", () => {
  const CAMPAIGN = `0x${"a7".repeat(32)}` as Hex;

  it("seeds the pool and lands a sponsored ETH -> FLEET buy in a fleet account", async () => {
    const { viem } = await network.connect({ network: "robinhoodTestnetFork" });
    const [operator, owner] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    const token = await viem.deployContract("FleetVenueToken", [parseEther("1000000")]);
    const seeder = await viem.deployContract("FleetPoolSeeder", [POOL_MANAGER]);
    await token.write.approve([seeder.address, parseEther("1000000")]);
    const key = venuePoolKey(token.address);
    await seeder.write.seed([key, SQRT_PRICE_1000, FULL_RANGE.lower, FULL_RANGE.upper, parseEther("0.3")], { value: parseEther("0.02") });
    assert.ok(await token.read.balanceOf([POOL_MANAGER]) > 0n, "pool holds FLEET liquidity");

    const policy = await viem.deployContract("FleetSessionPolicy", [operator!.account.address]);
    const escrow = await viem.deployContract("FleetCampaignEscrow", [operator!.account.address]);
    // The policy enrols a fleet of five or more; one of them makes the buy.
    const fleet = [];
    for (let i = 0; i < 5; i += 1) {
      fleet.push(await viem.deployContract("FleetAccount", [owner!.account.address, operator!.account.address, policy.address, CAMPAIGN]));
    }
    const enrolled = fleet.map((a) => a.address).sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
    const account = fleet[0]!;
    const chainId = await publicClient.getChainId();
    await policy.write.openSession([
      CAMPAIGN,
      { chainId: BigInt(chainId), router: ROBINHOOD_TESTNET_ROUTER, selector: UNIVERSAL_ROUTER_EXECUTE_SELECTOR,
        maxTradeValue: parseEther("0.001"), perAccountGas: parseEther("0.01"), totalGas: parseEther("0.05"),
        expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400), spentGas: 0n, paused: false, revoked: false, exists: false },
      enrolled,
    ]);
    await escrow.write.registerCampaign([CAMPAIGN, owner!.account.address]);
    await escrow.write.fund([CAMPAIGN], { account: owner!.account, value: parseEther("0.1") });
    // Stage 1: the trade principal is the account's own ETH, not the escrow's.
    await owner!.sendTransaction({ to: account.address, value: parseEther("0.001") });

    const amountIn = parseEther("0.0005");
    const block = await publicClient.getBlock();
    const report = await runFleetBuy(operator!, publicClient, {
      escrow: escrow.address, campaign: CAMPAIGN,
      accounts: [{
        account: account.address, key: `0x${"01".repeat(32)}`, router: ROBINHOOD_TESTNET_ROUTER, value: amountIn,
        callData: encodeV4EthBuy({ token: token.address, amountIn, deadline: block.timestamp + 3600n }), maxCost: parseEther("0.01"),
      }],
    });

    assert.equal(report.results[0]?.status, "sponsored", `rejected: ${report.results[0]?.reason}`);
    const bought = await token.read.balanceOf([account.address]);
    assert.ok(bought > 0n, "fleet account holds FLEET after the buy");
    assert.ok(bought < amountIn * 1000n, "price roughly 1000 FLEET/ETH minus fee and slippage");
    assert.equal(await publicClient.getBalance({ address: account.address }), parseEther("0.001") - amountIn, "principal came from the account");
    assert.equal(report.budget.spent, report.results[0]?.gasCost, "escrow paid exactly the gas");
    assert.equal(report.budget.reserved, 0n);
  });
});
