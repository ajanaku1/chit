/**
 * What the mainnet bot reads and sends on a session account: who owns it,
 * the session it granted the bot's key, whether a call would pass, and the
 * `execute` itself, signed by the bot's own key (which pays the gas; the
 * account pays the trade with its own ETH). Nothing of the owner's is held.
 *
 * Sells add three reads and one send: whether the owner turned the sell
 * flag on for the bot's key, whether the account's token is already
 * approved through Permit2 for the router, and `approveForSell`, the one-time
 * approval the account makes when it is not. The sale itself is an
 * ordinary `execute` with value zero. The approval the contract makes today
 * is unlimited and does not expire, so once a token is approved the bot's
 * key can sell it from the account for as long as the session is live; the
 * bot says so before the owner turns the flag on, and pause or revoke is
 * the off switch.
 */

import { type Address, type Hex, type PublicClient, type Transport, type WalletClient, createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SESSION_ACCOUNT_ABI, decodeSessionView, encodeApproveForSell, encodeSessionExecute, type SessionView } from "./session-keys.js";
import { PERMIT2 } from "./v4-swap.js";

export type SessionChain = {
  chainId: number;
  /** The bot's signer: the key every owner grants a session to. */
  signer: Address;
  ownerOf(account: Address): Promise<Address | undefined>;
  sessionOf(account: Address): Promise<SessionView>;
  /** The contract's own answer: ok, or the reason it would refuse. */
  canExecute(account: Address, target: Address, selector: Hex, value: bigint): Promise<{ ok: boolean; why: string }>;
  /** `execute(target, value, data)` on the account, from the bot's key; the hash once sent, the receipt's status once landed. */
  execute(account: Address, target: Address, value: bigint, data: Hex): Promise<{ hash: Hex; landed: boolean }>;
  signerBalance(): Promise<bigint>;
  /** Whether the owner let the bot's key sell from this account (`sellAllowed(key)` on the account). */
  sellAllowed(account: Address): Promise<boolean>;
  /** `approveForSell(token, spender)` on the account, from the bot's key: the token to Permit2, Permit2 to the spender, once. */
  approveForSell(account: Address, token: Address, spender: Address): Promise<{ hash: Hex; landed: boolean }>;
  /** Both halves of the approval are in place: the token allows Permit2 and Permit2 allows the spender for it. */
  tokenAllowanceReady(account: Address, token: Address, spender: Address): Promise<boolean>;
};

/** `receiptWaitMs`: how long one send waits for its receipt before answering with the hash alone; see RECEIPT_WAIT_MS. */
export type SessionChainConfig = { chainId: number; rpcUrl: string; signerKey: Hex; transport?: Transport; receiptWaitMs?: number };

/**
 * The webhook that runs these sends is a function the host stops at sixty
 * seconds (vercel.json, api/bot.js), and a send that outlives it is a trade
 * with no reply and a request Telegram delivers again. So one send waits
 * for its receipt well inside that budget, and the bot makes at most one
 * send per request; a receipt that takes longer is reported as sent, not
 * confirmed, with the explorer link.
 */
export const RECEIPT_WAIT_MS = 40_000;
const EXECUTE_GAS = 700_000n;
const APPROVE_GAS = 200_000n;
const ERC20_ALLOWANCE_ABI = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);
const PERMIT2_ALLOWANCE_ABI = parseAbi(["function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]);

export const createSessionChain = (config: SessionChainConfig): SessionChain => {
  const chain = defineChain({
    id: config.chainId,
    name: config.chainId === 4663 ? "Robinhood Chain" : "Robinhood Chain Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const transport = config.transport ?? http(config.rpcUrl, { retryCount: 3, retryDelay: 250, timeout: 20_000 });
  const pub = createPublicClient({ chain, transport }) as unknown as PublicClient;
  const account = privateKeyToAccount(config.signerKey);
  const wallet: WalletClient = createWalletClient({ account, chain, transport });
  const receiptWaitMs = config.receiptWaitMs ?? RECEIPT_WAIT_MS;
  /** One send from the bot's key to the account, then the receipt; a wait that runs out is a hash without a verdict. */
  const send = async (a: Address, data: Hex, gas: bigint): Promise<{ hash: Hex; landed: boolean }> => {
    const hash = await wallet.sendTransaction({ account, chain, to: a, data, gas });
    try {
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: receiptWaitMs });
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
    execute: (a, target, value, data) => send(a, encodeSessionExecute(target, value, data), EXECUTE_GAS),
    signerBalance: () => pub.getBalance({ address: account.address }),
    // A contract deployed before the flag existed has no `sellAllowed`; the read fails and the answer is no.
    sellAllowed: (a) => pub.readContract({ address: a, abi: SESSION_ACCOUNT_ABI, functionName: "sellAllowed", args: [account.address] }).catch(() => false),
    approveForSell: (a, token, spender) => send(a, encodeApproveForSell(token, spender), APPROVE_GAS),
    async tokenAllowanceReady(a, token, spender) {
      const [erc20, permit] = await Promise.all([
        pub.readContract({ address: token, abi: ERC20_ALLOWANCE_ABI, functionName: "allowance", args: [a, PERMIT2] }).catch(() => 0n),
        pub.readContract({ address: PERMIT2, abi: PERMIT2_ALLOWANCE_ABI, functionName: "allowance", args: [a, token, spender] }).catch(() => [0n, 0, 0] as const),
      ]);
      return erc20 > 0n && permit[0] > 0n;
    },
  };
};
