/**
 * What the mainnet bot reads and sends on a session account: who owns it,
 * the session it granted the bot's key, whether a call would pass, and the
 * `execute` itself, signed by the bot's own key (which pays the gas; the
 * account pays the trade with its own ETH). Nothing of the owner's is held.
 *
 * Sells add two reads and one send: whether the owner turned the sell flag
 * on for the bot's key (`sellAllowed`), whether a sale would pass right now
 * and why not if not (`canSell`: the two checks the contract makes at the
 * top of `sell` asked first, then the contract's own `canSell` view, so the
 * bot's refusal reads like the contract's and costs no gas), and `sell`
 * itself, one call on the account from the bot's key. The account writes
 * the router calldata, so the ETH lands in the account and nowhere else;
 * the Permit2 approvals live inside that one call, for the sale's amount
 * and this block, and are cleared before it returns. Nothing is approved
 * beforehand, nothing is left approved after, no allowance is ever read:
 * a sale is one send.
 */

import { type Address, type Hex, type PublicClient, type Transport, type WalletClient, createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodChain } from "./chain-def.js";
import { SESSION_ACCOUNT_ABI, decodeSessionView, encodeSell, encodeSessionExecute, type SessionSell, type SessionView } from "./session-keys.js";
import { NATIVE_ETH, venuePoolKey, type PoolKey } from "./v4-swap.js";

export type SessionChain = {
  chainId: number;
  /** The bot's signer: the key every owner grants a session to. */
  signer: Address;
  ownerOf(account: Address): Promise<Address | undefined>;
  sessionOf(account: Address): Promise<SessionView>;
  /** The contract's own answer: ok, or the reason it would refuse. */
  canExecute(account: Address, target: Address, selector: Hex, value: bigint): Promise<{ ok: boolean; why: string }>;
  /**
   * `execute(target, value, data)` on the account, from the bot's key; the hash once sent, the receipt's status once
   * landed. `receiptWaitMs` caps the wait for this one receipt below the chain's default (RECEIPT_WAIT_MS): a send with
   * less of the request's budget left waits that much and is reported as sent, not landed, when the receipt is slower;
   * zero or less waits for none.
   */
  execute(account: Address, target: Address, value: bigint, data: Hex, receiptWaitMs?: number): Promise<{ hash: Hex; landed: boolean }>;
  signerBalance(): Promise<bigint>;
  /** Whether the owner let the bot's key sell from this account (`sellAllowed(key)` on the account). */
  sellAllowed(account: Address): Promise<boolean>;
  /**
   * Whether `sell` would pass right now, and why not if not, in the
   * contract's words: the pool has to be an ETH pool of the token and the
   * floor above zero (what `sell` checks first), then `canSell(key, router)`
   * on the account (the flag, then the session and the router rule). The
   * pool key defaults to the venue's for the token, as `sell` does.
   */
  canSell(account: Address, router: Address, poolKey: PoolKey | undefined, amountIn: bigint, minOut: bigint, deadline?: bigint): Promise<{ ok: boolean; why: string }>;
  /** `sell(router, poolKey, amountIn, minOut, deadline)` on the account, from the bot's key: the sale as one call, the ETH into the account. */
  sell(account: Address, sale: SessionSell): Promise<{ hash: Hex; landed: boolean }>;
};

/** `receiptWaitMs`: how long one send waits for its receipt before answering with the hash alone; see RECEIPT_WAIT_MS. */
export type SessionChainConfig = { chainId: number; rpcUrl: string; signerKey: Hex; transport?: Transport; receiptWaitMs?: number };

/**
 * The webhook that runs these sends is a function the host stops at sixty
 * seconds (vercel.json, api/bot.js), and a send that outlives it is a trade
 * with no reply and a request Telegram delivers again. So one send waits
 * for its receipt well inside that budget, and the bot makes at most one
 * send per request on its own account; a receipt that takes longer is
 * reported as sent, not confirmed, with the explorer link. The mirrors a
 * leader's buy sets off in the same request are the exception, and they
 * are given only what is left of the request's budget: each waits for its
 * receipt at most that long (`receiptWaitMs` on `execute`), and none is
 * started once the budget is spent (bot-copy.ts, bot-session.ts).
 */
export const RECEIPT_WAIT_MS = 40_000;
const EXECUTE_GAS = 700_000n;
/** A sale is the swap with two approvals made and cleared around it; the fork test sends it with this much. */
export const SELL_GAS = 1_000_000n;

/**
 * The two checks `sell` makes before it asks the session (NotEthPool,
 * NoFloor), in the words the bot uses for them, so a refusal costs no gas
 * and reads the same whoever said it. Null when both pass. Shared with the
 * tests' fake chain so it refuses the way the real one does.
 */
export const sellPreflight = (token: Address, poolKey: PoolKey | undefined, minOut: bigint): string | null => {
  const key = poolKey ?? venuePoolKey(token);
  if (key.currency0 !== NATIVE_ETH || key.currency1 === NATIVE_ETH) return "not an ETH pool";
  if (key.currency1.toLowerCase() !== token.toLowerCase()) return "not this token's pool";
  if (minOut <= 0n) return "no floor";
  return null;
};

export const createSessionChain = (config: SessionChainConfig): SessionChain => {
  const chain = robinhoodChain(config.chainId, config.rpcUrl);
  const transport = config.transport ?? http(config.rpcUrl, { retryCount: 3, retryDelay: 250, timeout: 20_000 });
  const pub = createPublicClient({ chain, transport }) as unknown as PublicClient;
  const account = privateKeyToAccount(config.signerKey);
  const wallet: WalletClient = createWalletClient({ account, chain, transport });
  const receiptWaitMs = config.receiptWaitMs ?? RECEIPT_WAIT_MS;
  /** One send from the bot's key to the account, then the receipt; a wait that runs out, or none asked for, is a hash without a verdict. */
  const send = async (a: Address, data: Hex, gas: bigint, waitMs = receiptWaitMs): Promise<{ hash: Hex; landed: boolean }> => {
    const hash = await wallet.sendTransaction({ account, chain, to: a, data, gas });
    // viem reads a timeout of zero as no timeout at all, so no time left is no wait, said here rather than handed on.
    if (waitMs <= 0) return { hash, landed: false };
    try {
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: Math.min(waitMs, receiptWaitMs) });
      return { hash, landed: receipt.status === "success" };
    } catch {
      return { hash, landed: false };
    }
  };
  return {
    chainId: config.chainId,
    signer: account.address,
    ownerOf: (a) => pub.readContract({ address: a, abi: SESSION_ACCOUNT_ABI, functionName: "owner" }).catch(() => undefined),
    sessionOf: async (a) => decodeSessionView(await pub.readContract({ address: a, abi: SESSION_ACCOUNT_ABI, functionName: "sessionOf", args: [account.address] })),
    async canExecute(a, target, selector, value) {
      const [ok, why] = await pub.readContract({ address: a, abi: SESSION_ACCOUNT_ABI, functionName: "canExecute", args: [account.address, target, selector, value] });
      return { ok, why };
    },
    execute: (a, target, value, data, receiptWait) => send(a, encodeSessionExecute(target, value, data), EXECUTE_GAS, receiptWait),
    signerBalance: () => pub.getBalance({ address: account.address }),
    // An account deployed before the flag existed has no `sellAllowed`; the read fails and the answer is no.
    sellAllowed: (a) => pub.readContract({ address: a, abi: SESSION_ACCOUNT_ABI, functionName: "sellAllowed", args: [account.address] }).catch(() => false),
    async canSell(a, router, poolKey, _amountIn, minOut) {
      // The pool's token is the sale's token: `sell` reads it from the key it is handed.
      const token = poolKey?.currency1;
      const early = token ? sellPreflight(token, poolKey, minOut) : minOut <= 0n ? "no floor" : null;
      if (early) return { ok: false, why: early };
      // An account without `canSell` is one without `sell`: the answer is the contract's own words for the flag.
      const [ok, why] = await pub.readContract({ address: a, abi: SESSION_ACCOUNT_ABI, functionName: "canSell", args: [account.address, router] }).catch(() => [false, "sell not allowed"] as const);
      return { ok, why };
    },
    sell: (a, sale) => send(a, encodeSell(sale), SELL_GAS),
  };
};
