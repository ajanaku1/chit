import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { decodeEventLog, formatEther, parseAbi, parseEther, type Address, type Hex } from "viem";

import { quoteExactIn } from "../../src/fleet/market.js";
import { createPoolRegistry } from "../../src/fleet/pool-registry.js";
import { LIQUIDITY_MULTIPLE, leastOut, readTokenRegistry, type RegistryEntry } from "../../src/fleet/token-registry.js";
import { encodeV4EthBuy } from "../../src/fleet/v4-swap.js";
import { connectRobinhoodMainnetFork } from "./robinhood-fork.js";

/**
 * FR-012 and FR-013 for every entry in deployments/token-registry-4663.json,
 * on a fork of Robinhood Chain mainnet (T074, T075): the pool the entry pins
 * has a price and liquidity, its ETH side is at least fifty times the draw
 * cap, a transfer of the token arrives whole and comes back whole from and
 * to fresh accounts (ordinary transfer, no holder restriction), and a buy
 * through the Universal Router in exactly that pool lands inside the entry's
 * bound of the local quote. The numbers are printed so the registry's
 * `checks` can be written from them, with the date.
 *
 * Disabled entries are measured too, and only reported: what the fork says
 * about a candidate is what decides whether it is enabled.
 */

const ROUTER: Address = "0x8876789976decbfcbbbe364623c63652db8c0904";
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const DRAW_CAP = parseEther("0.05");
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address, uint256) returns (bool)"]);
const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const Q96 = 2n ** 96n;

describe("the token registry on the 4663 fork", () => {
  it("every entry: the pinned pool is live and deep enough, the token transfers whole, and a buy lands inside the bound", async () => {
    const registry = readTokenRegistry(JSON.parse(await readFile(new URL("../../deployments/token-registry-4663.json", import.meta.url), "utf8")), 4663);
    assert.ok(registry.tokens.length > 0, "the registry names at least one token");

    const { viem, provider } = await connectRobinhoodMainnetFork();
    const [buyer, fresh, other] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    await provider.request({ method: "evm_mine", params: [] });
    const pools = createPoolRegistry(publicClient, POOL_MANAGER, { chainId: 4663 });

    for (const entry of registry.tokens) await measure(entry);

    async function measure(entry: RegistryEntry) {
      const tag = `${entry.symbol}${entry.enabled ? "" : " (disabled)"}`;
      // The pool, by its key and nothing else.
      const state = await pools.state(entry.poolKey);
      assert.ok(state.sqrtPriceX96 > 0n && state.liquidity > 0n, `${tag}: the pinned pool has a price and liquidity`);
      const ethSide = (state.liquidity * Q96) / state.sqrtPriceX96;
      const multiple = Number(ethSide) / Number(DRAW_CAP);
      console.log(`${tag}: pool ${entry.poolId} ETH side ${formatEther(ethSide)} ETH, ${multiple.toFixed(1)}× the draw cap`);
      if (entry.enabled) assert.ok(ethSide >= DRAW_CAP * LIQUIDITY_MULTIPLE, `${tag}: at least ${LIQUIDITY_MULTIPLE}× the draw cap`);

      // Ordinary transfer, no holder restriction: the PoolManager holds the token; a fresh account gets exactly what was sent and can send it on and back.
      await provider.request({ method: "hardhat_impersonateAccount", params: [POOL_MANAGER] });
      await provider.request({ method: "hardhat_setBalance", params: [POOL_MANAGER, "0x1000000000000000000"] });
      const amount = 1000n * 10n ** BigInt(entry.decimals);
      const held = await publicClient.readContract({ address: entry.token, abi: ERC20, functionName: "balanceOf", args: [POOL_MANAGER] });
      assert.ok(held >= amount, `${tag}: the PoolManager holds at least ${amount} to lend the check`);
      const hop = async (from: Address, to: Address, how: "impersonated" | "signer") => {
        const before = await publicClient.readContract({ address: entry.token, abi: ERC20, functionName: "balanceOf", args: [to] });
        const hash = how === "impersonated"
          ? await provider.request({ method: "eth_sendTransaction", params: [{ from, to: entry.token, data: encodeTransfer(to, amount), gas: "0x30000" }] }) as Hex
          : await (from.toLowerCase() === fresh!.account.address.toLowerCase() ? fresh! : other!).writeContract({ address: entry.token, abi: ERC20, functionName: "transfer", args: [to, amount] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        assert.equal(receipt.status, "success", `${tag}: transfer ${from.slice(0, 8)} → ${to.slice(0, 8)} was not refused`);
        const after = await publicClient.readContract({ address: entry.token, abi: ERC20, functionName: "balanceOf", args: [to] });
        assert.equal(after - before, amount, `${tag}: the whole amount arrived, no fee taken`);
      };
      await hop(POOL_MANAGER, fresh!.account.address, "impersonated");
      await hop(fresh!.account.address, other!.account.address, "signer");
      await hop(other!.account.address, fresh!.account.address, "signer");
      console.log(`${tag}: ordinary transfer, no holder restriction: 1000 tokens went PoolManager → fresh → other → fresh, whole each time`);

      // The buy, through the Universal Router in exactly this pool, against the local quote (fee in, hook not).
      const amountIn = DRAW_CAP;
      const quoted = quoteExactIn(amountIn, state.sqrtPriceX96, state.liquidity, true, entry.poolKey.fee);
      const floor = leastOut(quoted, entry.slippageBps);
      const data = encodeV4EthBuy({ token: entry.token, amountIn, minOut: floor, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), poolKey: entry.poolKey });
      const before = await publicClient.readContract({ address: entry.token, abi: ERC20, functionName: "balanceOf", args: [buyer!.account.address] });
      const hash = await buyer!.sendTransaction({ to: ROUTER, data, value: amountIn, gas: 1_500_000n });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success", `${tag}: the buy landed at the floor of ${entry.slippageBps} bps`);
      const got = (await publicClient.readContract({ address: entry.token, abi: ERC20, functionName: "balanceOf", args: [buyer!.account.address] })) - before;
      const under = 1 - Number(got) / Number(quoted);
      const transfers = receipt.logs.filter((l) => l.address.toLowerCase() === entry.token).map((l) => { try { return decodeEventLog({ abi: TRANSFER, data: l.data, topics: l.topics }); } catch { return undefined; } }).filter(Boolean).length;
      console.log(`${tag}: ${formatEther(amountIn)} ETH bought ${formatEther(got)} for a quote of ${formatEther(quoted)}: ${(under * 100).toFixed(2)}% under, bound ${entry.slippageBps} bps, ${transfers} token transfer(s) in the receipt`);
      assert.ok(got >= floor, `${tag}: at least the floor arrived`);
      // A bound wider than the default must be earned: the fill has to fall outside 100 bps for it to be justified.
      if (entry.slippageBps > 100) assert.ok(under * 10_000 > 100, `${tag}: a bound of ${entry.slippageBps} bps is recorded only because 100 would refuse this fill`);
    }
  });
});

const encodeTransfer = (to: Address, amount: bigint): Hex => `0xa9059cbb${to.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}` as Hex;
