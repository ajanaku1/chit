import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseEther, type Address, type Hex } from "viem";

import { ROBINHOOD_TESTNET_ROUTER } from "../../src/fleet/deploy.js";
import {
  DEFAULT_SALT,
  PERMIT2,
  SESSION_ACCOUNT_ABI,
  SESSION_FACTORY_ABI,
  decodeSessionView,
  encodeSell,
  encodeSessionExecute,
  sessionState,
} from "../../src/fleet/session-keys.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, encodeV4EthBuy, encodeV4TokenSell, venuePoolKey } from "../../src/fleet/v4-swap.js";
import { connectRobinhoodFork } from "./robinhood-fork.js";

/** Verified live on 46630 (specs/001-fleet-mission/research.md, 2026-08-30). */
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const FULL_RANGE = { lower: -887_220, upper: 887_220 };
const isqrt = (n: bigint): bigint => { let x = n, y = (n + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
const SQRT_PRICE_1000 = isqrt(1000n * 2n ** 192n);
const PERMIT2_ALLOWANCE_ABI = parseAbi(["function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]);
const ROUTER_EXECUTE_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
/** The router's PERMIT2_TRANSFER_FROM command: move `amount` of `token` from the caller to `to`, the calldata a hostile key would write. */
const encodePermit2TransferFrom = (token: Address, to: Address, amount: bigint, deadline: bigint): Hex =>
  encodeFunctionData({ abi: ROUTER_EXECUTE_ABI, functionName: "execute", args: ["0x02", [encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint160" }], [token, to, amount])], deadline] });

/**
 * Session keys, the product, on a fork of 46630: a trader keeps the wallet,
 * funds a session account, and hands a bot's key a session that may only
 * call the Universal Router, for at most 0.001 ETH a trade and 0.003 in all,
 * for a day. The bot buys through the real Uniswap v4 router from its own
 * key; the tokens land in the account, not with the bot. Outside the rules
 * the bot is refused. With the owner's sell flag the bot sells part of the
 * position back through the same router with one `sell`, the account writing
 * the router calldata and making the Permit2 approvals for that call only,
 * the ETH landing in the account and nothing approved afterwards; without the
 * flag, under its floor, or while paused it cannot, and with the router's own
 * calldata through `execute` it can move no token, since no allowance stands.
 * After the owner's revoke it is refused for good; the owner takes the tokens
 * and the ETH back. Chit is nowhere in it.
 */
describe("Session keys on Uniswap v4 (46630 fork)", () => {
  it("a bot trades through a bounded key with a kill switch", async () => {
    const { viem } = await connectRobinhoodFork();
    const [deployer, owner, botWallet, stranger] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const bot = botWallet!.account;
    /** A send that must fail: either the node refuses it outright or it mines reverted. */
    const expectRevert = async (send: () => Promise<Hex>) => {
      let hash: Hex | undefined;
      try { hash = await send(); } catch { return; }
      const r = await publicClient.waitForTransactionReceipt({ hash });
      assert.notEqual(r.status, "success", "the call should have reverted");
    };

    // A venue: a real v4 pool, seeded.
    const token = await viem.deployContract("FleetVenueToken", [parseEther("1000000")]);
    const seeder = await viem.deployContract("FleetPoolSeeder", [POOL_MANAGER]);
    await token.write.approve([seeder.address, parseEther("1000000")]);
    await seeder.write.seed([venuePoolKey(token.address), SQRT_PRICE_1000, FULL_RANGE.lower, FULL_RANGE.upper, parseEther("0.3")], { value: parseEther("0.02") });

    // The owner: an account from the factory, funded from the wallet.
    const factory = await viem.deployContract("SessionAccountFactory");
    const account = await publicClient.readContract({ address: factory.address, abi: SESSION_FACTORY_ABI, functionName: "accountOf", args: [owner!.account.address, DEFAULT_SALT] });
    await owner!.writeContract({ address: factory.address, abi: SESSION_FACTORY_ABI, functionName: "createAccount", args: [owner!.account.address, DEFAULT_SALT] });
    assert.equal((await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "owner" })).toLowerCase(), owner!.account.address.toLowerCase());
    await owner!.sendTransaction({ to: account, value: parseEther("0.01") });

    const block = await publicClient.getBlock();
    const expiry = Number(block.timestamp) + 86_400;
    await owner!.writeContract({
      address: account, abi: SESSION_ACCOUNT_ABI, functionName: "grant",
      args: [bot.address, [{ target: ROBINHOOD_TESTNET_ROUTER, selector: UNIVERSAL_ROUTER_EXECUTE_SELECTOR }], parseEther("0.001"), parseEther("0.003"), expiry],
    });

    // The bot buys. Its key signs, the account's ETH pays, the account gets the tokens.
    const buy = (amountIn: bigint) => encodeV4EthBuy({ token: token.address, amountIn, deadline: block.timestamp + 3600n });
    const amount = parseEther("0.0005");
    const [ok, why] = await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "canExecute", args: [bot.address, ROBINHOOD_TESTNET_ROUTER, UNIVERSAL_ROUTER_EXECUTE_SELECTOR, amount] });
    assert.equal(ok, true, why);
    const botBefore = await publicClient.getBalance({ address: bot.address });
    // The bot's own key sends it, as any bot would: a plain transaction to the account.
    const hash = await botWallet!.sendTransaction({ to: account, data: encodeSessionExecute(ROBINHOOD_TESTNET_ROUTER, amount, buy(amount)), gas: 1_000_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", "the bot's buy landed");
    const bought = await token.read.balanceOf([account]);
    assert.ok(bought > 0n, "the account holds the tokens");
    assert.equal(await token.read.balanceOf([bot.address]), 0n, "the bot holds none");
    assert.equal(await publicClient.getBalance({ address: account }), parseEther("0.01") - amount, "the account's ETH paid the trade");
    assert.ok((await publicClient.getBalance({ address: bot.address })) < botBefore, "the bot paid its own gas");
    let view = decodeSessionView(await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "sessionOf", args: [bot.address] }) as never);
    assert.equal(view.spentValue, amount.toString());
    assert.equal(view.calls, 1);
    assert.equal(sessionState(view, Number(block.timestamp)), "active");

    // Outside the rules: the token itself, a bigger trade, a stranger.
    const refused = async (from: typeof botWallet, target: Address, value: bigint, data: Hex, reason: string) => {
      const can = await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "canExecute", args: [from!.account.address, target, data.slice(0, 10) as Hex, value] });
      assert.deepEqual(can, [false, reason], `${reason}: canExecute says so before any gas`);
      await expectRevert(() => from!.sendTransaction({ to: account, data: encodeSessionExecute(target, value, data), gas: 1_000_000n }));
    };
    await refused(botWallet, token.address, 0n, `0xa9059cbb${"00".repeat(64)}`, "rule not allowed");
    await refused(botWallet, ROBINHOOD_TESTNET_ROUTER, parseEther("0.002"), buy(parseEther("0.002")), "value over call");
    await refused(stranger, ROBINHOOD_TESTNET_ROUTER, amount, buy(amount), "unknown");

    // Selling. Without the flag the bot cannot sell; the owner flips it from the wallet.
    const sellAmount = bought / 2n;
    const sell = (from: typeof botWallet, amountIn: bigint, minOut: bigint) =>
      from!.sendTransaction({ to: account, data: encodeSell({ router: ROBINHOOD_TESTNET_ROUTER, token: token.address, amountIn, minOut, deadline: block.timestamp + 3600n }), gas: 1_000_000n });
    const permit2Allowance = () => publicClient.readContract({ address: PERMIT2, abi: PERMIT2_ALLOWANCE_ABI, functionName: "allowance", args: [account, token.address, ROBINHOOD_TESTNET_ROUTER] });
    assert.equal(await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "sellAllowed", args: [bot.address] }), false);
    assert.deepEqual(await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "canSell", args: [bot.address, ROBINHOOD_TESTNET_ROUTER] }), [false, "sell not allowed"]);
    await expectRevert(() => sell(botWallet, sellAmount, 1n));
    await owner!.writeContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "setSellAllowed", args: [bot.address, true] });
    assert.equal(await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "sellAllowed", args: [bot.address] }), true);
    assert.deepEqual(await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "canSell", args: [bot.address, ROBINHOOD_TESTNET_ROUTER] }), [true, ""]);
    // The router's own calldata through a plain execute moves nothing: no allowance stands, with or without the flag.
    await expectRevert(() => botWallet!.sendTransaction({ to: account, data: encodeSessionExecute(ROBINHOOD_TESTNET_ROUTER, 0n, encodePermit2TransferFrom(token.address, bot.address, bought, block.timestamp + 3600n)), gas: 1_000_000n }));
    await expectRevert(() => botWallet!.sendTransaction({ to: account, data: encodeSessionExecute(ROBINHOOD_TESTNET_ROUTER, 0n, encodeV4TokenSell({ token: token.address, amountIn: sellAmount, deadline: block.timestamp + 3600n })), gas: 1_000_000n }));
    assert.equal(await token.read.balanceOf([account]), bought, "nothing moved");
    // A floor the pool cannot meet is refused, and the sale unwinds whole.
    await expectRevert(() => sell(botWallet, sellAmount, parseEther("1")));
    assert.equal(await token.read.balanceOf([account]), bought);
    // The sale: the account writes the swap, the live Permit2 and router move the token, the ETH lands in the account, the caps do not move.
    const ethBeforeSell = await publicClient.getBalance({ address: account });
    const sellHash = await sell(botWallet, sellAmount, 1n);
    assert.equal((await publicClient.waitForTransactionReceipt({ hash: sellHash })).status, "success", "the bot's sell landed");
    const held = await token.read.balanceOf([account]);
    assert.equal(held, bought - sellAmount, "half the position left the account");
    const ethAfterSell = await publicClient.getBalance({ address: account });
    assert.ok(ethAfterSell > ethBeforeSell, "the ETH came back to the account, not to the bot");
    assert.equal(await token.read.balanceOf([bot.address]), 0n);
    assert.equal(await token.read.allowance([account, PERMIT2]), 0n, "nothing approved to Permit2 after the sale");
    const [p2Amount, p2Expiry] = await permit2Allowance();
    assert.equal(p2Amount, 0n, "nothing approved to the router after the sale");
    assert.ok(p2Expiry <= Number((await publicClient.getBlock()).timestamp), "and what was approved expired with the sale's block (Permit2 stores a zero expiry as that block)");
    view = decodeSessionView(await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "sessionOf", args: [bot.address] }) as never);
    assert.equal(view.spentValue, amount.toString(), "a sell spends none of the cap");
    assert.equal(view.calls, 2);
    // Paused, the flag is no help.
    await owner!.writeContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "pause", args: [bot.address] });
    await expectRevert(() => sell(botWallet, 1n, 1n));
    await owner!.writeContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "resume", args: [bot.address] });

    // The kill switch, from the wallet. Then the owner takes everything back.
    await owner!.writeContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "revoke", args: [bot.address] });
    await refused(botWallet, ROBINHOOD_TESTNET_ROUTER, amount, buy(amount), "revoked");
    await expectRevert(() => sell(botWallet, 1n, 1n));
    view = decodeSessionView(await publicClient.readContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "sessionOf", args: [bot.address] }) as never);
    assert.equal(sessionState(view, Number(block.timestamp)), "revoked");
    await owner!.writeContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "withdrawToken", args: [token.address, owner!.account.address, held] });
    await owner!.writeContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "withdraw", args: [owner!.account.address, ethAfterSell] });
    assert.equal(await token.read.balanceOf([owner!.account.address]), held);
    assert.equal(await publicClient.getBalance({ address: account }), 0n);
    console.log(`session key bought ${bought} FLEET for ${amount} wei through the live router, sold ${sellAmount} back for ${ethAfterSell - ethBeforeSell} wei into the account, then was revoked; the owner holds the rest`);
  });
});
