/**
 * The chain as the bot sees it: tokens, balances, quotes, a buy, a sell, a send.
 *
 * One port and one viem implementation. Every trade goes from the user's
 * testnet wallet straight to the Universal Router through the same v4
 * encoders the fleet uses; the bot signs with the user's playground key
 * because on testnet that key is the bot's to hold (docs/chit-bot.md). The
 * faucet is a separate key with test ETH that tops new wallets up.
 *
 * Any token with an ETH pool on the venue is tradeable: `tokenInfo` reads
 * the pool's price and liquidity and says whether there is one. Tests hand
 * the handlers a fake of this port; the fork test runs the real one against
 * the live venue.
 */

import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, type PublicClient, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { decodeSlot0, liquiditySlot, poolIdFor, quoteExactIn, slot0Slot } from "./market.js";
import type { Address, Hex } from "./types.js";
import { PERMIT2, VENUE_POOL, encodeV4EthBuy, encodeV4TokenSell, minOutFor, sellApprovals } from "./v4-swap.js";

export type Landed = { hash: Hex; ok: boolean };

export type TokenInfo = {
  address: Address;
  symbol: string;
  decimals: number;
  /** False when the venue has no ETH pool for it; nothing below is meaningful then. */
  hasPool: boolean;
  /** Tokens (base units) one ETH buys at spot. */
  perEth: bigint;
  /** ETH the pool holds on its ETH side at the current price, roughly. */
  poolEth: bigint;
};

export type BotChain = {
  chainId: number;
  /** The venue token: what a fresh wallet sees first. */
  defaultToken: Address;
  router: Address;
  ethBalance(address: Address): Promise<bigint>;
  tokenBalance(token: Address, address: Address): Promise<bigint>;
  tokenInfo(token: Address): Promise<TokenInfo>;
  /** Tokens out for ETH in, fee and price impact included; null when the pool has no price. */
  quoteBuy(token: Address, ethIn: bigint): Promise<bigint | null>;
  /** ETH out for tokens in, fee and price impact included; null when the pool has no price. */
  quoteSell(token: Address, tokensIn: bigint): Promise<bigint | null>;
  buy(privateKey: Hex, token: Address, ethIn: bigint, minOut: bigint): Promise<Landed>;
  sell(privateKey: Hex, token: Address, tokensIn: bigint, minOut: bigint): Promise<Landed>;
  send(privateKey: Hex, to: Address, wei: bigint): Promise<Landed>;
  /** A deposit into the fleet pool, one of its published sizes, from the wallet. Null pool means no fleet product here. */
  deposit(privateKey: Hex, wei: bigint): Promise<Landed>;
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
  "function decimals() view returns (uint8)",
]);
const PERMIT2_ABI = parseAbi(["function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]);
const POOL_MANAGER_ABI = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const POOL_ABI = parseAbi(["function deposit() payable", "function totalDeposited() view returns (uint256)", "function campaignCount() view returns (uint256)", "function paused() view returns (bool)"]);

export type BotChainConfig = {
  chainId: number;
  rpcUrl: string;
  defaultToken: Address;
  router: Address;
  poolManager: Address;
  pool?: Address;
  faucetKey?: Hex;
  /** A transport of the caller's own (a fork's in-process provider in tests); default is HTTP to rpcUrl. */
  transport?: Transport;
};

const Q96 = 1n << 96n;

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
  const meta = new Map<string, { symbol: string; decimals: number }>();

  const land = async (send: () => Promise<Hex>): Promise<Landed> => {
    const hash = await send();
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return { hash, ok: receipt.status === "success" };
  };
  const poolState = async (token: Address): Promise<{ sqrtPriceX96: bigint; liquidity: bigint }> => {
    const id = poolIdFor(token);
    const [slot0, liq] = await Promise.all([
      publicClient.readContract({ address: config.poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [slot0Slot(id)] }),
      publicClient.readContract({ address: config.poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [liquiditySlot(id)] }),
    ]);
    return { sqrtPriceX96: decodeSlot0(slot0).sqrtPriceX96, liquidity: BigInt(liq) & ((1n << 128n) - 1n) };
  };
  const metaOf = async (token: Address): Promise<{ symbol: string; decimals: number }> => {
    const key = token.toLowerCase();
    let m = meta.get(key);
    if (!m) {
      const [symbol, decimals] = await Promise.all([
        publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"),
        publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
      ]);
      m = { symbol: String(symbol).slice(0, 12), decimals: Number(decimals) };
      meta.set(key, m);
    }
    return m;
  };

  return {
    chainId: config.chainId,
    defaultToken: config.defaultToken,
    router: config.router,
    ethBalance: (address) => publicClient.getBalance({ address }),
    tokenBalance: (token, address) => publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }).catch(() => 0n),
    async tokenInfo(token) {
      const [m, state] = await Promise.all([metaOf(token), poolState(token)]);
      const hasPool = state.sqrtPriceX96 > 0n && state.liquidity > 0n;
      return {
        address: token, symbol: m.symbol, decimals: m.decimals, hasPool,
        // price² = sqrtP² / Q96²: tokens per wei; times 1e18 for tokens per ETH.
        perEth: hasPool ? (state.sqrtPriceX96 * state.sqrtPriceX96 * (10n ** 18n)) / (Q96 * Q96) : 0n,
        // A full-range position's ETH side is L / sqrtP.
        poolEth: hasPool ? (state.liquidity * Q96) / state.sqrtPriceX96 : 0n,
      };
    },
    async quoteBuy(token, ethIn) {
      const { sqrtPriceX96, liquidity } = await poolState(token);
      return sqrtPriceX96 === 0n || liquidity === 0n ? null : quoteExactIn(ethIn, sqrtPriceX96, liquidity, true, VENUE_POOL.fee);
    },
    async quoteSell(token, tokensIn) {
      const { sqrtPriceX96, liquidity } = await poolState(token);
      return sqrtPriceX96 === 0n || liquidity === 0n ? null : quoteExactIn(tokensIn, sqrtPriceX96, liquidity, false, VENUE_POOL.fee);
    },
    async buy(key, token, ethIn, minOut) {
      const wallet = walletFor(key);
      const block = await publicClient.getBlock();
      return land(() => wallet.sendTransaction({
        account: wallet.account!, chain, to: config.router, value: ethIn,
        data: encodeV4EthBuy({ token, amountIn: ethIn, minOut, deadline: block.timestamp + 600n }), gas: 600_000n,
      }));
    },
    async sell(key, token, tokensIn, minOut) {
      const wallet = walletFor(key);
      const owner = wallet.account!.address;
      const block = await publicClient.getBlock();
      // Approvals once per token: the token to Permit2, Permit2 to the router, both for more than this sale.
      const [erc20Allowance, permit] = await Promise.all([
        publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, PERMIT2] }),
        publicClient.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance", args: [owner, token, config.router] }),
      ]);
      const permitOk = permit[0] >= tokensIn && Number(permit[1]) > Number(block.timestamp) + 600;
      if (erc20Allowance < tokensIn || !permitOk) {
        const max = 2n ** 160n - 1n;
        for (const approval of sellApprovals(token, config.router, max, Number(block.timestamp) + 365 * 86_400)) {
          const r = await land(() => wallet.sendTransaction({ account: wallet.account!, chain, to: approval.to, data: approval.data }));
          if (!r.ok) return r;
        }
      }
      return land(() => wallet.sendTransaction({
        account: wallet.account!, chain, to: config.router,
        data: encodeV4TokenSell({ token, amountIn: tokensIn, minOut, deadline: block.timestamp + 600n }), gas: 600_000n,
      }));
    },
    async send(key, to, wei) {
      const wallet = walletFor(key);
      return land(() => wallet.sendTransaction({ account: wallet.account!, chain, to, value: wei }));
    },
    async deposit(key, wei) {
      if (!config.pool) throw new Error("no pool on this bot");
      const wallet = walletFor(key);
      const data = encodeFunctionData({ abi: POOL_ABI, functionName: "deposit" });
      return land(() => wallet.sendTransaction({ account: wallet.account!, chain, to: config.pool!, value: wei, data, gas: 200_000n }));
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
