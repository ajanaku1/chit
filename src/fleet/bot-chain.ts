/**
 * The chain as the bot sees it: balances, a quote, a buy, a sell, a send.
 *
 * One port and one viem implementation. Every trade goes from the user's
 * testnet wallet straight to the Universal Router through the same v4
 * encoders the fleet uses; the bot signs with the user's playground key
 * because on testnet that key is the bot's to hold (docs/chit-bot.md). The
 * faucet is a separate key with test ETH that tops new wallets up.
 *
 * Tests hand the handlers a fake of this port; the fork test runs the real
 * one against the live venue.
 */

import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type PublicClient, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { decodeSlot0, liquiditySlot, poolIdFor, quoteExactIn, slot0Slot } from "./market.js";
import type { Address, Hex } from "./types.js";
import { PERMIT2, VENUE_POOL, encodeV4EthBuy, encodeV4TokenSell, minOutFor, sellApprovals } from "./v4-swap.js";

export type Landed = { hash: Hex; ok: boolean };

export type BotChain = {
  chainId: number;
  token: Address;
  tokenSymbol: string;
  router: Address;
  ethBalance(address: Address): Promise<bigint>;
  tokenBalance(address: Address): Promise<bigint>;
  /** Tokens out for ETH in, fee and price impact included; null when the pool has no price. */
  quoteBuy(ethIn: bigint): Promise<bigint | null>;
  /** ETH out for tokens in, fee and price impact included; null when the pool has no price. */
  quoteSell(tokensIn: bigint): Promise<bigint | null>;
  buy(privateKey: Hex, ethIn: bigint, minOut: bigint): Promise<Landed>;
  sell(privateKey: Hex, tokensIn: bigint, minOut: bigint): Promise<Landed>;
  send(privateKey: Hex, to: Address, wei: bigint): Promise<Landed>;
  /** From the faucet key. */
  faucet(to: Address, wei: bigint): Promise<Landed>;
  faucetBalance(): Promise<bigint>;
  /** What the pool holds, for /pool in the group. */
  poolNumbers(): Promise<{ address: Address; heldWei: bigint; totalDeposited: bigint; campaigns: bigint; paused: boolean } | null>;
};

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function symbol() view returns (string)",
]);
const PERMIT2_ABI = parseAbi(["function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]);
const POOL_MANAGER_ABI = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const POOL_ABI = parseAbi(["function totalDeposited() view returns (uint256)", "function campaignCount() view returns (uint256)", "function paused() view returns (bool)"]);

export const BUY_SLIPPAGE_BPS = 300;

export type BotChainConfig = {
  chainId: number;
  rpcUrl: string;
  token: Address;
  router: Address;
  poolManager: Address;
  pool?: Address;
  faucetKey?: Hex;
  /** A transport of the caller's own (a fork's in-process provider in tests); default is HTTP to rpcUrl. */
  transport?: Transport;
};

export const createBotChain = (config: BotChainConfig): BotChain => {
  const chain = defineChain({
    id: config.chainId,
    name: config.chainId === 4663 ? "Robinhood Chain" : "Robinhood Chain Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const transport = config.transport ?? http(config.rpcUrl, { retryCount: 3, retryDelay: 250, timeout: 20_000 });
  const publicClient = createPublicClient({ chain, transport }) as unknown as PublicClient;
  const walletFor = (key: Hex): WalletClient => createWalletClient({ account: privateKeyToAccount(key), chain, transport });
  let symbolCache: string | undefined;

  const land = async (send: () => Promise<Hex>): Promise<Landed> => {
    const hash = await send();
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return { hash, ok: receipt.status === "success" };
  };
  const poolState = async (): Promise<{ sqrtPriceX96: bigint; liquidity: bigint }> => {
    const id = poolIdFor(config.token);
    const [slot0, liq] = await Promise.all([
      publicClient.readContract({ address: config.poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [slot0Slot(id)] }),
      publicClient.readContract({ address: config.poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [liquiditySlot(id)] }),
    ]);
    return { sqrtPriceX96: decodeSlot0(slot0).sqrtPriceX96, liquidity: BigInt(liq) & ((1n << 128n) - 1n) };
  };

  return {
    chainId: config.chainId,
    token: config.token,
    get tokenSymbol() { return symbolCache ?? "FLEET"; },
    router: config.router,
    ethBalance: (address) => publicClient.getBalance({ address }),
    tokenBalance: (address) => publicClient.readContract({ address: config.token, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
    async quoteBuy(ethIn) {
      symbolCache ??= await publicClient.readContract({ address: config.token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "FLEET");
      const { sqrtPriceX96, liquidity } = await poolState();
      return sqrtPriceX96 === 0n ? null : quoteExactIn(ethIn, sqrtPriceX96, liquidity, true, VENUE_POOL.fee);
    },
    async quoteSell(tokensIn) {
      const { sqrtPriceX96, liquidity } = await poolState();
      return sqrtPriceX96 === 0n ? null : quoteExactIn(tokensIn, sqrtPriceX96, liquidity, false, VENUE_POOL.fee);
    },
    async buy(key, ethIn, minOut) {
      const wallet = walletFor(key);
      const block = await publicClient.getBlock();
      return land(() => wallet.sendTransaction({
        account: wallet.account!, chain, to: config.router, value: ethIn,
        data: encodeV4EthBuy({ token: config.token, amountIn: ethIn, minOut, deadline: block.timestamp + 600n }), gas: 600_000n,
      }));
    },
    async sell(key, tokensIn, minOut) {
      const wallet = walletFor(key);
      const owner = wallet.account!.address;
      const block = await publicClient.getBlock();
      // Approvals once: the token to Permit2, Permit2 to the router, both for more than this sale.
      const [erc20Allowance, permit] = await Promise.all([
        publicClient.readContract({ address: config.token, abi: ERC20_ABI, functionName: "allowance", args: [owner, PERMIT2] }),
        publicClient.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance", args: [owner, config.token, config.router] }),
      ]);
      const permitOk = permit[0] >= tokensIn && Number(permit[1]) > Number(block.timestamp) + 600;
      if (erc20Allowance < tokensIn || !permitOk) {
        const max = 2n ** 160n - 1n;
        for (const approval of sellApprovals(config.token, config.router, max, Number(block.timestamp) + 365 * 86_400)) {
          const r = await land(() => wallet.sendTransaction({ account: wallet.account!, chain, to: approval.to, data: approval.data }));
          if (!r.ok) return r;
        }
      }
      return land(() => wallet.sendTransaction({
        account: wallet.account!, chain, to: config.router,
        data: encodeV4TokenSell({ token: config.token, amountIn: tokensIn, minOut, deadline: block.timestamp + 600n }), gas: 600_000n,
      }));
    },
    async send(key, to, wei) {
      const wallet = walletFor(key);
      return land(() => wallet.sendTransaction({ account: wallet.account!, chain, to, value: wei }));
    },
    async faucet(to, wei) {
      if (!config.faucetKey) throw new Error("no faucet key");
      const wallet = walletFor(config.faucetKey);
      return land(() => wallet.sendTransaction({ account: wallet.account!, chain, to, value: wei }));
    },
    async faucetBalance() {
      if (!config.faucetKey) return 0n;
      return publicClient.getBalance({ address: privateKeyToAccount(config.faucetKey).address });
    },
    async poolNumbers() {
      if (!config.pool) return null;
      const [heldWei, totalDeposited, campaigns, paused] = await Promise.all([
        publicClient.getBalance({ address: config.pool }),
        publicClient.readContract({ address: config.pool, abi: POOL_ABI, functionName: "totalDeposited" }),
        publicClient.readContract({ address: config.pool, abi: POOL_ABI, functionName: "campaignCount" }),
        publicClient.readContract({ address: config.pool, abi: POOL_ABI, functionName: "paused" }),
      ]);
      return { address: config.pool, heldWei, totalDeposited, campaigns, paused };
    },
  };
};

export { minOutFor };
