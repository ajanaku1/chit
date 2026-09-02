/**
 * Stage 1 on-chain campaign lifecycle.
 *
 * Drives the operator-side steps against the deployed contracts: register the
 * campaign in the escrow, create the fleet accounts through the factory, and
 * open the campaign's bounded session in the policy. Funding verification and
 * the buy itself live in `chain-buy.ts`. This is what the service calls at
 * create and activate once configured with the operator key and the deployed
 * addresses.
 */

import { parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

const ESCROW_ABI = parseAbi(["function registerCampaign(bytes32 campaign, address owner)"]);

const FACTORY_ABI = parseAbi([
  "function createFleet(bytes32 campaign, address policy, (address ownerAddress, bytes32 salt)[] inits) returns (address[])",
  "function accountAddress(bytes32 campaign, address policy, address ownerAddress, bytes32 salt) view returns (address)",
]);

const POLICY_ABI = parseAbi([
  "function openSession(bytes32 campaign, (uint256 chainId, address router, bytes4 selector, uint256 maxTradeValue, uint256 perAccountGas, uint256 totalGas, uint64 expiry, uint256 spentGas, bool paused, bool revoked, bool exists) session, address[] accounts)",
]);

export type FleetInit = { ownerAddress: Address; salt: Hex };

export type SessionParams = {
  chainId: bigint;
  router: Address;
  selector: Hex;
  maxTradeValue: bigint;
  perAccountGas: bigint;
  totalGas: bigint;
  expiry: bigint;
};

const walletCtx = (wallet: WalletClient) => ({ account: wallet.account ?? null, chain: wallet.chain ?? null });

/** Registers the campaign to its owner in the escrow (operator-only, set-once). */
export const registerCampaign = async (
  wallet: WalletClient,
  publicClient: PublicClient,
  escrow: Address,
  campaign: Hex,
  owner: Address,
): Promise<Hex> => {
  const tx = await wallet.writeContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "registerCampaign",
    args: [campaign, owner],
    ...walletCtx(wallet),
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  return tx;
};

/**
 * Creates the fleet's smart accounts through the factory and returns their
 * deterministic addresses. `inits` must be strictly increasing by owner address.
 */
export const createFleet = async (
  wallet: WalletClient,
  publicClient: PublicClient,
  factory: Address,
  policy: Address,
  campaign: Hex,
  inits: readonly FleetInit[],
): Promise<Address[]> => {
  const accounts: Address[] = [];
  for (const init of inits) {
    accounts.push(
      (await publicClient.readContract({
        address: factory,
        abi: FACTORY_ABI,
        functionName: "accountAddress",
        args: [campaign, policy, init.ownerAddress, init.salt],
      })) as Address,
    );
  }
  const tx = await wallet.writeContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: "createFleet",
    args: [campaign, policy, inits],
    ...walletCtx(wallet),
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  return accounts;
};

/** Opens the campaign's single bounded session over its accounts. */
export const openSession = async (
  wallet: WalletClient,
  publicClient: PublicClient,
  policy: Address,
  campaign: Hex,
  params: SessionParams,
  accounts: readonly Address[],
): Promise<Hex> => {
  const tx = await wallet.writeContract({
    address: policy,
    abi: POLICY_ABI,
    functionName: "openSession",
    args: [
      campaign,
      {
        chainId: params.chainId,
        router: params.router,
        selector: params.selector,
        maxTradeValue: params.maxTradeValue,
        perAccountGas: params.perAccountGas,
        totalGas: params.totalGas,
        expiry: params.expiry,
        spentGas: 0n,
        paused: false,
        revoked: false,
        exists: false,
      },
      accounts,
    ],
    ...walletCtx(wallet),
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  return tx;
};
