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
      chainId: 46630, rpcUrl: "fork", token: token.address, router: ROBINHOOD_TESTNET_ROUTER, poolManager: POOL_MANAGER, faucetKey,
      transport: custom(provider as { request: (args: { method: string; params?: unknown }) => Promise<unknown> }),
    });
    const userKey = `0x${"c0".repeat(32)}` as const;
    const user = privateKeyToAccount(userKey).address;

    assert.ok((await forked.faucetBalance()) > parseEther("1"));
    const topped = await forked.faucet(user, parseEther("0.02"));
    assert.equal(topped.ok, true);
    assert.equal(await forked.ethBalance(user), parseEther("0.02"));

    const quote = await forked.quoteBuy(parseEther("0.001"));
    assert.ok(quote && quote > parseEther("0.9") && quote < parseEther("1.01"), `about 1 FLEET for 0.001 ETH at 1000/ETH: ${quote}`);
    const bought = await forked.buy(userKey, parseEther("0.001"), minOutFor(quote!, 300));
    assert.equal(bought.ok, true, "the buy landed through the router");
    const held = await forked.tokenBalance(user);
    assert.ok(held > 0n && held >= minOutFor(quote!, 300), "within the guard");

    const half = held / 2n;
    const sellQuote = await forked.quoteSell(half);
    assert.ok(sellQuote && sellQuote > 0n);
    const ethBefore = await forked.ethBalance(user);
    const sold = await forked.sell(userKey, half, minOutFor(sellQuote!, 300));
    assert.equal(sold.ok, true, "the sale landed (approvals then the router)");
    assert.equal(await forked.tokenBalance(user), held - half);
    assert.ok((await forked.ethBalance(user)) > ethBefore - parseEther("0.0005"), "ETH came back, minus gas for three transactions");

    const sent = await forked.send(userKey, faucetWallet!.account.address, parseEther("0.005"));
    assert.equal(sent.ok, true);
    console.log(`bot chain on the fork: quote ${quote}, held ${held}, sold ${half}, sent 0.005 back`);
  });
});
