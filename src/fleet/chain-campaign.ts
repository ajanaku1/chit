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

const READ_ABI = parseAbi([
  "function ownerOf(bytes32 campaign) view returns (address)",
  "function budget(bytes32 campaign) view returns (uint256 funded, uint256 reserved, uint256 spent, uint256 unused)",
  "function sessionOf(bytes32 campaign) view returns ((uint256 chainId, address router, bytes4 selector, uint256 maxTradeValue, uint256 perAccountGas, uint256 totalGas, uint64 expiry, uint256 spentGas, bool paused, bool revoked, bool exists))",
  "function isEnrolled(bytes32 campaign, address account) view returns (bool)",
  "function pause(bytes32 campaign)",
  "function resume(bytes32 campaign)",
  "function revoke(bytes32 campaign)",
]);

export type OnChainSession = {
  chainId: bigint; router: Address; selector: Hex; maxTradeValue: bigint; perAccountGas: bigint; totalGas: bigint;
  expiry: bigint; spentGas: bigint; paused: boolean; revoked: boolean;
};

export type OnChainCampaign = {
  owner: Address;
  budget: { funded: bigint; reserved: bigint; spent: bigint; unused: bigint };
  /** Absent until the fleet is activated and the session opened. */
  session?: OnChainSession;
};

/**
 * Everything the service needs to know about a campaign, read from the chain,
 * so a fresh instance can serve it. Undefined when the escrow has no such
 * campaign.
 */
export const readCampaign = async (
  publicClient: PublicClient,
  escrow: Address,
  policy: Address,
  campaign: Hex,
): Promise<OnChainCampaign | undefined> => {
  let owner: Address;
  try {
    owner = await publicClient.readContract({ address: escrow, abi: READ_ABI, functionName: "ownerOf", args: [campaign] });
  } catch {
    return undefined;
  }
  const [funded, reserved, spent, unused] = await publicClient.readContract({ address: escrow, abi: READ_ABI, functionName: "budget", args: [campaign] });
  const session = await publicClient.readContract({ address: policy, abi: READ_ABI, functionName: "sessionOf", args: [campaign] });
  return {
    owner,
    budget: { funded, reserved, spent, unused },
    ...(session.exists ? { session: { ...session } } : {}),
  };
};

export const isEnrolled = (publicClient: PublicClient, policy: Address, campaign: Hex, account: Address): Promise<boolean> =>
  publicClient.readContract({ address: policy, abi: READ_ABI, functionName: "isEnrolled", args: [campaign, account] });

/** Operator-side session control on-chain; the policy enforces it on every buy. */
export const setSessionState = async (
  wallet: WalletClient,
  publicClient: PublicClient,
  policy: Address,
  campaign: Hex,
  event: "pause" | "resume" | "revoke",
): Promise<Hex> => {
  const hash = await wallet.writeContract({ ...walletCtx(wallet), address: policy, abi: READ_ABI, functionName: event, args: [campaign] });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
};
