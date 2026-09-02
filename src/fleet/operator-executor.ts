/**
 * Stage 1 sponsored-buy executor (operator-executes model).
 *
 * The operator calls a fleet account's policy-gated `execute` directly, pays the
 * gas, and settles that gas against the campaign escrow: reserve the ceiling,
 * run the call, commit the actual gas cost. The trader's ETH budget reimburses
 * the operator (via the escrow's spent-withdrawal), so the fleet's gas never
 * comes from the trader's main wallet. No EntryPoint or paymaster is involved at
 * this stage; the 4337 paymaster path is the later decentralized model.
 */

import { parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

const ESCROW_ABI = parseAbi([
  "function reserve(bytes32 campaign, bytes32 key, uint256 amount)",
  "function commit(bytes32 campaign, bytes32 key, uint256 actual)",
  "function rollback(bytes32 campaign, bytes32 key)",
  "function budget(bytes32 campaign) view returns (uint256 funded, uint256 reserved, uint256 spent, uint256 unused)",
]);

const ACCOUNT_ABI = parseAbi(["function execute(address target, uint256 value, bytes data) returns (bytes)"]);

export type SponsoredBuy = {
  escrow: Address;
  account: Address;
  campaign: Hex;
  /** Escrow reservation key for this op (unique per account+buy). */
  key: Hex;
  /** The approved router/target the fleet account calls. */
  router: Address;
  /** Trade value forwarded by the account (Stage 1 does not sponsor this principal). */
  value: bigint;
  /** The approved-function calldata. */
  callData: Hex;
  /** Gas ceiling to reserve, in wei. */
  maxCost: bigint;
};

export type BuyResult = { txHash: Hex; actualGasCost: bigint };

/** Reads the on-chain campaign budget. Used for funding verification and reporting. */
export const readBudget = async (
  publicClient: PublicClient,
  escrow: Address,
  campaign: Hex,
): Promise<{ funded: bigint; reserved: bigint; spent: bigint; unused: bigint }> => {
  const [funded, reserved, spent, unused] = (await publicClient.readContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "budget",
    args: [campaign],
  })) as readonly [bigint, bigint, bigint, bigint];
  return { funded, reserved, spent, unused };
};

/**
 * Executes one sponsored buy and settles its gas against the escrow.
 * On execution failure the reservation is rolled back so nothing is charged.
 */
export const executeSponsoredBuy = async (
  wallet: WalletClient,
  publicClient: PublicClient,
  buy: SponsoredBuy,
): Promise<BuyResult> => {
  const account = wallet.account ?? null;
  const chain = wallet.chain ?? null;

  const reserveTx = await wallet.writeContract({
    address: buy.escrow,
    abi: ESCROW_ABI,
    functionName: "reserve",
    args: [buy.campaign, buy.key, buy.maxCost],
    account,
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: reserveTx });

  try {
    const executeTx = await wallet.writeContract({
      address: buy.account,
      abi: ACCOUNT_ABI,
      functionName: "execute",
      args: [buy.router, buy.value, buy.callData],
      account,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: executeTx });
    if (receipt.status !== "success") throw new Error("execute_reverted");

    // The gas the operator actually fronted; never charge more than reserved.
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    const charged = gas > buy.maxCost ? buy.maxCost : gas;

    const commitTx = await wallet.writeContract({
      address: buy.escrow,
      abi: ESCROW_ABI,
      functionName: "commit",
      args: [buy.campaign, buy.key, charged],
      account,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: commitTx });
    return { txHash: executeTx, actualGasCost: charged };
  } catch (error) {
    const rollbackTx = await wallet.writeContract({
      address: buy.escrow,
      abi: ESCROW_ABI,
      functionName: "rollback",
      args: [buy.campaign, buy.key],
      account,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: rollbackTx });
    throw error;
  }
};
