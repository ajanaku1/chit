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

import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, maxUint256, parseAbi, parseAbiItem, WaitForTransactionReceiptTimeoutError, type PublicClient, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { decodeSlot0, liquiditySlot, poolIdFor, quoteExactIn, slot0Slot } from "./market.js";
import type { Address, Hex } from "./types.js";
import { PERMIT2, VENUE_POOL, encodeV4EthBuy, encodeV4TokenSell, minOutFor, sellApprovals } from "./v4-swap.js";

/** `pending`: sent, but no receipt within the wait; the hash is real and the caller must not send again. */
export type Landed = { hash: Hex; ok: boolean; pending?: boolean };

/** Receipts are waited for this long before the reply says "still landing"; a Vercel function has sixty seconds in all. */
export const RECEIPT_WAIT_MS = 40_000;

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
  /** The fleet pool, when this deployment has one; null means no deposit button. */
  pool: Address | null;
  /** Whether a faucet key is configured. */
  hasFaucet: boolean;
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
  /**
   * ETH pools opened on the venue recently, newest first: the token, when,
   * and whether this bot can trade it (the venue's own key, no hook). Read
   * from the pool manager's Initialize events over the last `blocks`.
   */
  newPools(blocks: number): Promise<NewPool[]>;
};

export type NewPool = { token: Address; block: bigint; tradeable: boolean; fee: number; hooks: Address };

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const PERMIT2_ABI = parseAbi(["function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]);
const ERC20_APPROVE_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const POOL_MANAGER_ABI = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const INITIALIZE = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
/** One RPC log query covers at most this many blocks; a day on the chain is a few of these. */
const LOG_SPAN = 100_000n;
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
  let faucetQueue: Promise<void> = Promise.resolve();
  /** The new-pools scan is the same for every user; one result serves a minute. */
  let poolsCache: { at: number; blocks: number; pools: NewPool[] } | undefined;

  const land = async (send: () => Promise<Hex>): Promise<Landed> => {
    const hash = await send();
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS });
      return { hash, ok: receipt.status === "success" };
    } catch (error) {
      // The hash is not lost with the wait: the caller reports it and refuses to send again.
      if (error instanceof WaitForTransactionReceiptTimeoutError) return { hash, ok: false, pending: true };
      throw error;
    }
  };
  /**
   * A swap deadline from the wall clock, not the last block: an idle Orbit
   * chain's latest block can be minutes old, and the sequencer stamps new
   * blocks with the time of day.
   */
  const deadline = async (): Promise<bigint> => {
    const block = await publicClient.getBlock();
    return BigInt(Math.max(Number(block.timestamp), Math.floor(Date.now() / 1000))) + 600n;
  };
  const poolState = async (token: Address): Promise<{ sqrtPriceX96: bigint; liquidity: bigint }> => {
    const id = poolIdFor(token);
    const [slot0, liq] = await Promise.all([
      publicClient.readContract({ address: config.poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [slot0Slot(id)] }),
      publicClient.readContract({ address: config.poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [liquiditySlot(id)] }),
    ]);
    return { sqrtPriceX96: decodeSlot0(slot0).sqrtPriceX96, liquidity: BigInt(liq) & ((1n << 128n) - 1n) };
  };
  /** Symbol and decimals, remembered once read; a read that fails is not remembered, so a blip does not become "?" for the instance's life. */
  const metaOf = async (token: Address): Promise<{ symbol: string; decimals: number }> => {
    const key = token.toLowerCase();
    const cached = meta.get(key);
    if (cached) return cached;
    const [symbol, decimals] = await Promise.allSettled([
      publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
      publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    const m = {
      symbol: symbol.status === "fulfilled" ? String(symbol.value).slice(0, 12) : "?",
      decimals: decimals.status === "fulfilled" ? Number(decimals.value) : 18,
    };
    if (symbol.status === "fulfilled" && decimals.status === "fulfilled") meta.set(key, m);
    return m;
  };

  return {
    chainId: config.chainId,
    defaultToken: config.defaultToken,
    router: config.router,
    pool: config.pool ?? null,
    hasFaucet: Boolean(config.faucetKey),
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
      const until = await deadline();
      return land(() => wallet.sendTransaction({
        account: wallet.account!, chain, to: config.router, value: ethIn,
        data: encodeV4EthBuy({ token, amountIn: ethIn, minOut, deadline: until }), gas: 600_000n,
      }));
    },
    async sell(key, token, tokensIn, minOut) {
      const wallet = walletFor(key);
      const owner = wallet.account!.address;
      const until = await deadline();
      // Approvals once per token, each only when short: the token to Permit2
      // (uint256 max, which uint96-allowance tokens read as infinite), Permit2
      // to the router (uint160 max, a year).
      const [erc20Allowance, permit] = await Promise.all([
        publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, PERMIT2] }),
        publicClient.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance", args: [owner, token, config.router] }),
      ]);
      const permitOk = permit[0] >= tokensIn && BigInt(permit[1]) > until;
      const [, approvePermit] = sellApprovals(token, config.router, 2n ** 160n - 1n, Number(until) + 365 * 86_400);
      const needed = [
        ...(erc20Allowance < tokensIn ? [{ to: token, data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [PERMIT2, maxUint256] }) }] : []),
        ...(permitOk ? [] : [approvePermit!]),
      ];
      for (const approval of needed) {
        const r = await land(() => wallet.sendTransaction({ account: wallet.account!, chain, to: approval.to, data: approval.data }));
        if (!r.ok) return r;
      }
      return land(() => wallet.sendTransaction({
        account: wallet.account!, chain, to: config.router,
        data: encodeV4TokenSell({ token, amountIn: tokensIn, minOut, deadline: until }), gas: 600_000n,
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
      // One faucet send at a time on this instance, so two top-ups here never
      // race on the faucet key's nonce; across instances the handler's lock does it.
      const next = faucetQueue.then(() => land(() => wallet.sendTransaction({ account: wallet.account!, chain, to, value: wei })));
      faucetQueue = next.then(() => undefined, () => undefined);
      return next;
    },
    async faucetBalance() {
      if (!config.faucetKey) return 0n;
      return publicClient.getBalance({ address: privateKeyToAccount(config.faucetKey).address });
    },
    async newPools(blocks) {
      if (poolsCache && poolsCache.blocks === blocks && Date.now() - poolsCache.at < 60_000) return poolsCache.pools;
      const head = await publicClient.getBlockNumber();
      const from = head > BigInt(blocks) ? head - BigInt(blocks) : 0n;
      const found = new Map<string, NewPool>();
      for (let to = head; to > from; to -= LOG_SPAN) {
        const start = to - LOG_SPAN + 1n > from ? to - LOG_SPAN + 1n : from;
        const logs = await publicClient.getLogs({ address: config.poolManager, event: INITIALIZE, args: { currency0: NATIVE }, fromBlock: start, toBlock: to });
        for (const l of logs) {
          const token = l.args.currency1 as Address;
          const key = token.toLowerCase();
          if (found.has(key)) continue;
          const fee = Number(l.args.fee);
          const hooks = l.args.hooks as Address;
          const tradeable = fee === VENUE_POOL.fee && Number(l.args.tickSpacing) === VENUE_POOL.tickSpacing && hooks.toLowerCase() === VENUE_POOL.hooks;
          found.set(key, { token, block: l.blockNumber, tradeable, fee, hooks });
        }
      }
      const pools = [...found.values()].sort((a, b) => (a.block > b.block ? -1 : a.block < b.block ? 1 : 0));
      poolsCache = { at: Date.now(), blocks, pools };
      return pools;
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
