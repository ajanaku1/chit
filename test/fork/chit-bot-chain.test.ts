import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { custom, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createBotChain, minOutFor } from "../../src/fleet/bot-chain.js";
import { ROBINHOOD_TESTNET_ROUTER } from "../../src/fleet/deploy.js";
import { venuePoolKey } from "../../src/fleet/v4-swap.js";
import { connectRobinhoodFork } from "./robinhood-fork.js";

/** Verified live on 46630 (specs/001-fleet-mission/research.md, 2026-08-30). */
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const FULL_RANGE = { lower: -887_220, upper: 887_220 };
const isqrt = (n: bigint): bigint => { let x = n, y = (n + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
const SQRT_PRICE_1000 = isqrt(1000n * 2n ** 192n);

/**
 * The bot's chain adapter against the real router on a fork of 46630: a
 * playground wallet is faucet-funded, quotes, buys with a slippage guard,
 * sells half back through Permit2, and withdraws. What the handlers see
 * through the fake in test/fleet/chit-bot.test.ts, the real thing does here.
 */
describe("Chit Bot chain adapter (46630 fork)", () => {
  it("faucet, quote, buy, sell, send, all through the live venue", async () => {
    const { viem, provider } = await connectRobinhoodFork();
    const [deployer, faucetWallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    const token = await viem.deployContract("FleetVenueToken", [parseEther("1000000")]);
    const seeder = await viem.deployContract("FleetPoolSeeder", [POOL_MANAGER]);
    await token.write.approve([seeder.address, parseEther("1000000")]);
    await seeder.write.seed([venuePoolKey(token.address), SQRT_PRICE_1000, FULL_RANGE.lower, FULL_RANGE.upper, parseEther("0.3")], { value: parseEther("0.02") });
    void deployer;

    // The fork's second hardhat account is the faucet: its key is public, its ETH is fork ETH.
    const faucetKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
    assert.equal(privateKeyToAccount(faucetKey).address.toLowerCase(), faucetWallet!.account.address.toLowerCase());
    // The adapter as the bot builds it, over the fork's in-process provider instead of an HTTP url.
    const forked = createBotChain({
      chainId: 46630, rpcUrl: "fork", defaultToken: token.address, router: ROBINHOOD_TESTNET_ROUTER, poolManager: POOL_MANAGER, faucetKey,
      transport: custom(provider as { request: (args: { method: string; params?: unknown }) => Promise<unknown> }),
    });
    const userKey = `0x${"c0".repeat(32)}` as const;
    const user = privateKeyToAccount(userKey).address;

    assert.ok((await forked.faucetBalance()) > parseEther("1"));
    const topped = await forked.faucet(user, parseEther("0.02"));
    assert.equal(topped.ok, true);
    assert.equal(await forked.ethBalance(user), parseEther("0.02"));

    const info = await forked.tokenInfo(token.address);
    assert.equal(info.hasPool, true);
    assert.equal(info.symbol, "FLEET");
    assert.ok(info.perEth > parseEther("990") && info.perEth < parseEther("1010"), `about 1000 FLEET per ETH: ${info.perEth}`);
    // The seeder took liquidity L = 0.3e18 at sqrt(1000): the ETH side is L / sqrtP, about 0.0095 ETH of the 0.02 offered.
    assert.ok(info.poolEth > parseEther("0.0094") && info.poolEth < parseEther("0.0096"), `the position's ETH side: ${info.poolEth}`);
    const nowhere = await forked.tokenInfo(seeder.address);
    assert.equal(nowhere.hasPool, false, "a contract with no pool says so");

    const quote = await forked.quoteBuy(token.address, parseEther("0.001"));
    assert.ok(quote && quote > parseEther("0.9") && quote < parseEther("1.01"), `about 1 FLEET for 0.001 ETH at 1000/ETH: ${quote}`);
    const bought = await forked.buy(userKey, token.address, parseEther("0.001"), minOutFor(quote!, 300));
    assert.equal(bought.ok, true, "the buy landed through the router");
    const held = await forked.tokenBalance(token.address, user);
    assert.ok(held > 0n && held >= minOutFor(quote!, 300), "within the guard");
    assert.equal(held, quote, "the exact-in quote is the fill");

    const half = held / 2n;
    const sellQuote = await forked.quoteSell(token.address, half);
    assert.ok(sellQuote && sellQuote > 0n);
    const ethBefore = await forked.ethBalance(user);
    const sold = await forked.sell(userKey, token.address, half, minOutFor(sellQuote!, 300));
    assert.equal(sold.ok, true, "the sale landed (approvals then the router)");
    assert.equal(await forked.tokenBalance(token.address, user), held - half);
    const ethAfter = await forked.ethBalance(user);
    assert.ok(ethAfter > ethBefore, `ETH came back: ${ethAfter} after ${ethBefore}`);
    // The fork prices gas well above the live chain's 0.01 gwei, so the gas allowance is read, not assumed: three transactions, 300k gas in all.
    const gasAllowance = 300_000n * (await publicClient.getGasPrice());
    assert.ok(ethAfter - ethBefore >= minOutFor(sellQuote!, 300) - gasAllowance, `at least the guarded amount less gas: got ${ethAfter - ethBefore}, guarded ${minOutFor(sellQuote!, 300)}, gas allowance ${gasAllowance}`);

    // A second sale needs no approvals: only the swap itself is sent.
    const quarter = (held - half) / 2n;
    const again = await forked.sell(userKey, token.address, quarter, minOutFor((await forked.quoteSell(token.address, quarter))!, 300));
    assert.equal(again.ok, true);
    assert.equal(await forked.tokenBalance(token.address, user), held - half - quarter);

    const sent = await forked.send(userKey, faucetWallet!.account.address, parseEther("0.005"));
    assert.equal(sent.ok, true);
    console.log(`bot chain on the fork: quote ${quote}, held ${held}, sold ${half}, sent 0.005 back`);

    // The registry: the venue token is found on the venue's own key, and a launchpad token on its hooked key, from the chain's own record.
    const pools = await forked.newPools(400_000);
    const hooked = pools.filter((p) => p.hooks !== "0x0000000000000000000000000000000000000000");
    console.log(`new pools on the fork: ${pools.length}, hooked ${hooked.length}`);
    let candidate: { token: Address; poolEth: bigint; symbol: string } | undefined;
    for (const p of hooked.slice(0, 12)) {
      const i = await forked.tokenInfo(p.token);
      if (i.hasPool && i.hooked && i.poolEth >= parseEther("0.002")) { candidate = { token: p.token, poolEth: i.poolEth, symbol: i.symbol }; break; }
    }
    if (!candidate) { console.log("no hooked pool with liquidity on the fork right now; the hooked buy is not exercised"); return; }
    const hq = await forked.quoteBuy(candidate.token, parseEther("0.0005"));
    assert.ok(hq && hq > 0n, "a hooked pool quotes through its discovered key");
    // A hook takes its own fee on top of the quote: the guard is set wide for this probe, the point is the route.
    const hb = await forked.buy(userKey, candidate.token, parseEther("0.0005"), minOutFor(hq!, 2_000));
    const got = await forked.tokenBalance(candidate.token, user);
    console.log(`hooked pool ${candidate.symbol} (${candidate.token}, ${candidate.poolEth} wei ETH side): buy ${hb.ok ? "landed" : "reverted"}, got ${got}`);
    if (hb.ok) assert.ok(got >= minOutFor(hq!, 2_000), "the fill respects the guard");
  });
});
