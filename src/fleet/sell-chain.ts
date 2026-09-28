/**
 * The SellChain port on the real chain (docs/design-sell.md). Sends go through
 * the pool's record-before-send lifecycle under the same "operator" lock every
 * operator transaction takes, with the lease asked right before the broadcast,
 * so a sale's swap and a withdrawal's payout never race for one nonce.
 */
import { parseAbi, parseEventLogs, type PublicClient } from "viem";

import type { FleetPool } from "./chain-pool.js";
import type { MarketPort } from "./market.js";
import { LeaseLost } from "./pool-buy.js";
import type { SellChain, SendStep } from "./sell.js";
import type { Lease, StorePort } from "./store.js";
import type { Address, Hex } from "./types.js";

const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const POLICY = parseAbi(["function isEnrolled(bytes32 campaign, address account) view returns (bool)"]);
const ACCOUNT = parseAbi(["function owner() view returns (address)"]);

export type SellChainDeps = {
  publicClient: PublicClient;
  pool: FleetPool;
  store: StorePort;
  operator: Address;
  policy: Address;
  market: MarketPort;
};

/** One operator send at the pending nonce, broadcasting nothing once the lease is lost (pool-buy.ts's guard). */
const broadcast = async (pool: FleetPool, operator: Address, lease: Lease, step: SendStep) => {
  const nonce = await pool.nextNonce(operator);
  return pool.signAndBroadcast({
    to: step.to, nonce,
    ...(step.data ? { data: step.data } : {}),
    ...(step.value === undefined ? {} : { value: step.value }),
    record: async (hash, signedNonce) => {
      if (!(await lease.held())) throw new LeaseLost();
      await step.record(hash, signedNonce);
    },
  });
};

export const createSellChain = ({ publicClient, pool, store, operator, policy, market }: SellChainDeps): SellChain => ({
  async transfersIn(hash) {
    const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => undefined);
    if (!receipt || receipt.status !== "success") return { mined: false, transfers: [] };
    const logs = parseEventLogs({ abi: TRANSFER, logs: receipt.logs, eventName: "Transfer", strict: true });
    return { mined: true, transfers: logs.map((log) => ({ token: log.address as Address, from: log.args.from as Address, to: log.args.to as Address, amount: log.args.value })) };
  },

  enrolled: (campaign, account) => publicClient.readContract({ address: policy, abi: POLICY, functionName: "isEnrolled", args: [campaign, account] }),

  async sellQuote(token, amountIn, poolKey) {
    if (!market.sellQuote) throw new Error("market_cannot_quote_sells");
    return market.sellQuote(token, amountIn, poolKey);
  },

  send: (step) => store.withLock("operator", (lease) => broadcast(pool, operator, lease, step)),

  /**
   * The swap, measured where the answer is still readable: the operator's balance at latest just before the
   * broadcast and just after the receipt, inside the operator lock, so no other operator send falls between them.
   * A public RPC keeps minutes of old state; this needs none.
   */
  swap: (step) => store.withLock("operator", async (lease) => {
    const before = await publicClient.getBalance({ address: operator });
    const outcome = await broadcast(pool, operator, lease, step);
    if (outcome.status !== "mined") return { outcome };
    const [receipt, after] = await Promise.all([publicClient.getTransactionReceipt({ hash: outcome.hash }), publicClient.getBalance({ address: operator })]);
    return { outcome, received: after - before + receipt.gasUsed * receipt.effectiveGasPrice };
  }),

  resolve: (hash, nonce) => pool.resolve(hash, nonce, operator),

  balance: (address) => publicClient.getBalance({ address }),

  ownerOf: (account) => publicClient.readContract({ address: account, abi: ACCOUNT, functionName: "owner" }),

  /**
   * The operator's balance across the swap's block, with the swap's gas added
   * back. The operator lock keeps its own sends one at a time; an unrelated
   * inflow in the same block would be counted, so the payout is checked
   * against the sale's quote before it leaves (sell.ts, settleSwap).
   */
  async ethReceived(hash) {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    const [after, before] = await Promise.all([
      publicClient.getBalance({ address: operator, blockNumber: receipt.blockNumber }),
      publicClient.getBalance({ address: operator, blockNumber: receipt.blockNumber - 1n }),
    ]);
    return after - before + receipt.gasUsed * receipt.effectiveGasPrice;
  },
});
