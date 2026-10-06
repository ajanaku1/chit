/**
 * The sale's ports on the real chain and service (sell-flow.ts). The backup is
 * unlocked with the main wallet's signature, exactly as the fleet page proves
 * it at setup; each owner key signs its own `withdrawToken` in this browser and
 * never leaves it.
 */
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { SIGN_IS_FREE, chainIdDecimal, chainTarget, walletProvider, withWalletPrompt } from "./page-shared.js";
import { RecoverFlowError, type RecoverPorts } from "./recover-eth-flow.js";
import { SellFlowError, type SellFlowPorts } from "./sell-flow.js";
import { signedFleetApi } from "./signed-request.js";
import { recoverVault, type VaultContext } from "./vault.js";

const ACCOUNT_ABI = parseAbi(["function owner() view returns (address)", "function withdrawToken(address token, address to, uint256 amount)", "function withdrawEth(address to, uint256 amount)"]);
const ERC20_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

const vaultContext = (wallet: Hex): VaultContext => ({
  origin: window.location.origin,
  primaryChainId: chainIdDecimal(),
  primaryWallet: wallet,
  signMessage: async (message) => {
    const eth = walletProvider();
    if (!eth) throw new SellFlowError("wallet_unavailable");
    return (await withWalletPrompt(`Check your wallet: sign to open your backup. ${SIGN_IS_FREE}`, () =>
      eth.request({ method: "personal_sign", params: [message, wallet] }),
    )) as Hex;
  },
});

const chainOf = () => defineChain({ id: chainTarget.chainId, name: chainTarget.chainName, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [...chainTarget.rpcUrls] } } });

export const chainSellPorts = (wallet: Hex): SellFlowPorts => {
  const rpc = chainTarget.rpcUrls[0];
  const chain = chainOf();
  const client = createPublicClient({ chain, transport: http(rpc) });
  return {
    recover: async (envelopeJson) => (await recoverVault(vaultContext(wallet), envelopeJson)).accounts,
    api: (action, body) => signedFleetApi(wallet, action, body),
    ownerOf: (account) => client.readContract({ address: account, abi: ACCOUNT_ABI, functionName: "owner" }),
    tokenBalance: (token, account) => client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [account] }),
    async withdraw(privateKey, account, token, to, amount) {
      const owner = createWalletClient({ account: privateKeyToAccount(privateKey), chain, transport: http(rpc) });
      const hash = await owner.writeContract({ address: account, abi: ACCOUNT_ABI, functionName: "withdrawToken", args: [token, to, amount] });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new SellFlowError("transfer_failed");
      return hash;
    },
  };
};

/** The recovery's ports (recover-eth-flow.ts): the same backup, the same owner keys, `withdrawEth` instead of `withdrawToken`. */
export const chainRecoverPorts = (wallet: Hex): RecoverPorts => {
  const rpc = chainTarget.rpcUrls[0];
  const chain = chainOf();
  const client = createPublicClient({ chain, transport: http(rpc) });
  return {
    recover: async (envelopeJson) => (await recoverVault(vaultContext(wallet), envelopeJson)).accounts,
    api: (action, body) => signedFleetApi(wallet, action, body),
    ownerOf: (account) => client.readContract({ address: account, abi: ACCOUNT_ABI, functionName: "owner" }),
    ethBalance: (account) => client.getBalance({ address: account }),
    async withdrawEth(privateKey, account, to, amount) {
      const owner = createWalletClient({ account: privateKeyToAccount(privateKey), chain, transport: http(rpc) });
      const hash = await owner.writeContract({ address: account, abi: ACCOUNT_ABI, functionName: "withdrawEth", args: [to, amount] });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new RecoverFlowError("transfer_failed");
      return hash;
    },
  };
};
