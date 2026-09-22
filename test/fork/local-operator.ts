import type { network } from "hardhat";
import { createWalletClient, custom, parseEther, type Chain, type PrivateKeyAccount, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * An operator that signs for itself, on the local chain.
 *
 * The service's signed step signs before it broadcasts, so the hash is
 * recorded before the node sees the transaction (contracts/chain-adapter.md,
 * rule 1). The node's own accounts cannot do that: they sign by
 * `eth_signTransaction`, which Hardhat does not serve, and every signed step
 * handed one of them fails with "Method eth_signTransaction is not
 * supported". So a suite gives the service a local account, funded from the
 * node's first, and the node's accounts stay what they are good for: the
 * traders, and deploying.
 */
export const OPERATOR_KEY = `0x${"7".repeat(64)}` as const;

/** The node's provider, as `network.connect()` hands it out. */
type Provider = Awaited<ReturnType<typeof network.connect>>["provider"];

export const localOperator = async (
  funder: WalletClient,
  provider: Provider,
  chain: Chain | undefined,
  key: `0x${string}` = OPERATOR_KEY,
  float = parseEther("10"),
): Promise<WalletClient<Transport, Chain | undefined, PrivateKeyAccount>> => {
  const operator = createWalletClient({ account: privateKeyToAccount(key), chain, transport: custom(provider) });
  await funder.sendTransaction({ account: funder.account!, chain, to: operator.account.address, value: float });
  return operator;
};
