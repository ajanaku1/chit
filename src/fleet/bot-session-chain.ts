/**
 * What the mainnet bot reads and sends on a session account: who owns it,
 * the session it granted the bot's key, whether a call would pass, and the
 * `execute` itself, signed by the bot's own key (which pays the gas; the
 * account pays the trade with its own ETH). Nothing of the owner's is held.
 */

import { type Address, type Hex, type PublicClient, type Transport, type WalletClient, createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SESSION_ACCOUNT_ABI, decodeSessionView, encodeSessionExecute, type SessionView } from "./session-keys.js";

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
};

export type SessionChainConfig = { chainId: number; rpcUrl: string; signerKey: Hex; transport?: Transport };

const RECEIPT_WAIT_MS = 90_000;
const EXECUTE_GAS = 700_000n;

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
  return {
    chainId: config.chainId,
    signer: account.address,
    ownerOf: (a) => pub.readContract({ address: a, abi: SESSION_ACCOUNT_ABI, functionName: "owner" }).catch(() => undefined),
    sessionOf: async (a) => decodeSessionView(await pub.readContract({ address: a, abi: SESSION_ACCOUNT_ABI, functionName: "sessionOf", args: [account.address] })),
    async canExecute(a, target, selector, value) {
      const [ok, why] = await pub.readContract({ address: a, abi: SESSION_ACCOUNT_ABI, functionName: "canExecute", args: [account.address, target, selector, value] });
      return { ok, why };
    },
    async execute(a, target, value, data) {
      const hash = await wallet.sendTransaction({ account, chain, to: a, data: encodeSessionExecute(target, value, data), gas: EXECUTE_GAS });
      try {
        const receipt = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS });
        return { hash, landed: receipt.status === "success" };
      } catch {
        return { hash, landed: false };
      }
    },
    signerBalance: () => pub.getBalance({ address: account.address }),
  };
};
