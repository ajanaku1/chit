/**
 * Gas sponsorship: the chain, as the sponsor service sees it.
 *
 * One port, one viem implementation. The service registers a sponsor's
 * budget in the escrow (operator-only), reads budgets and the paymaster's
 * float, signs sponsorships with the operator key, hashes ops through the
 * EntryPoint, and bundles them itself with `handleOps`, as the fleet does
 * (spec, Assumptions: no public bundler). Tests hand the service a fake of
 * this port; the fork test runs the real one against 46630's EntryPoint.
 */

import { parseAbi, parseEventLogs, type PublicClient, type WalletClient } from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";

import type { DigestSigner } from "./paymaster-data.js";
import type { EntryPointUserOp } from "./sponsored-op.js";
import type { Address, Hex } from "./types.js";
import { ENTRYPOINT_V07 } from "./user-operation.js";

export type EscrowBudget = { funded: bigint; reserved: bigint; spent: bigint; unused: bigint };

export type Landed = { txHash: Hex; userOpHash: Hex; success: boolean; actualGasCost: bigint; actualGasUsed: bigint };

export type SponsorChain = {
  chainId: number;
  entryPoint: Address;
  paymaster: Address;
  escrow: Address;
  operator: Address;
  /** The paymaster's fee, read from the contract so the service cannot drift from it. */
  feeBps(): Promise<number>;
  registerSponsor(id: Hex, owner: Address): Promise<Hex>;
  budgetOf(id: Hex): Promise<EscrowBudget>;
  /** What the escrow committed for one reservation key; zero while it is open. */
  committedOf(id: Hex, key: Hex): Promise<bigint>;
  paymasterDeposit(): Promise<bigint>;
  signSponsorship: DigestSigner;
  userOpHash(op: EntryPointUserOp): Promise<Hex>;
  /** The base fee the next block will charge, for the gas plan a dapp did not fill in. */
  baseFee(): Promise<bigint>;
  submit(op: EntryPointUserOp): Promise<Landed>;
};

const ESCROW_ABI = parseAbi([
  "function registerCampaign(bytes32 campaign, address owner)",
  "function budget(bytes32 campaign) view returns (uint256 funded, uint256 reserved, uint256 spent, uint256 unused)",
  "function reservationOf(bytes32 campaign, bytes32 key) view returns ((uint256 amount, uint256 committed, uint64 lockedUntil, uint8 state))",
]);
const PAYMASTER_ABI = parseAbi([
  "function feeBps() view returns (uint16)",
  "function getDeposit() view returns (uint256)",
]);

export const createSponsorChain = (
  wallet: WalletClient,
  publicClient: PublicClient,
  addresses: { paymaster: Address; escrow: Address; entryPoint?: Address },
): SponsorChain => {
  const account = wallet.account;
  if (!account) throw new Error("the sponsor chain needs the operator's wallet account");
  const entryPoint = addresses.entryPoint ?? ENTRYPOINT_V07;
  const ctx = { account, chain: wallet.chain ?? null };
  const wait = async (hash: Hex, what: string): Promise<Hex> => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`${what} reverted: ${hash}`);
    return hash;
  };
  let feeCache: number | undefined;

  return {
    chainId: wallet.chain?.id ?? 0,
    entryPoint,
    paymaster: addresses.paymaster,
    escrow: addresses.escrow,
    operator: account.address,

    async feeBps() {
      feeCache ??= Number(await publicClient.readContract({ address: addresses.paymaster, abi: PAYMASTER_ABI, functionName: "feeBps" }));
      return feeCache;
    },
    async registerSponsor(id, owner) {
      const hash = await wallet.writeContract({ ...ctx, address: addresses.escrow, abi: ESCROW_ABI, functionName: "registerCampaign", args: [id, owner] });
      return wait(hash, "registerCampaign");
    },
    async budgetOf(id) {
      const [funded, reserved, spent, unused] = await publicClient.readContract({ address: addresses.escrow, abi: ESCROW_ABI, functionName: "budget", args: [id] });
      return { funded, reserved, spent, unused };
    },
    async committedOf(id, key) {
      const r = await publicClient.readContract({ address: addresses.escrow, abi: ESCROW_ABI, functionName: "reservationOf", args: [id, key] });
      return r.state === 2 ? r.committed : 0n;
    },
    paymasterDeposit: () => publicClient.readContract({ address: addresses.paymaster, abi: PAYMASTER_ABI, functionName: "getDeposit" }),
    signSponsorship: (digest) => wallet.signMessage({ account, message: { raw: digest } }),
    userOpHash: (op) => publicClient.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: "getUserOpHash", args: [op] }),
    async baseFee() {
      const block = await publicClient.getBlock();
      return block.baseFeePerGas ?? (await publicClient.getGasPrice());
    },
    async submit(op) {
      // Priced like the op, so the EntryPoint's refund at the op's price matches what the bundler paid.
      const maxFeePerGas = BigInt(`0x${op.gasFees.slice(34)}`);
      const maxPriorityFeePerGas = BigInt(`0x${op.gasFees.slice(2, 34)}`);
      const hash = await wallet.writeContract({
        ...ctx, address: entryPoint, abi: entryPoint07Abi, functionName: "handleOps", args: [[op], account.address],
        gas: 2_000_000n, maxFeePerGas, maxPriorityFeePerGas,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== "success") throw new Error(`handleOps reverted: ${hash}`);
      const [event] = parseEventLogs({ abi: entryPoint07Abi, eventName: "UserOperationEvent", logs: receipt.logs });
      if (!event) throw new Error(`handleOps landed without a UserOperationEvent: ${hash}`);
      return {
        txHash: hash,
        userOpHash: event.args.userOpHash,
        success: event.args.success,
        actualGasCost: event.args.actualGasCost,
        actualGasUsed: event.args.actualGasUsed,
      };
    },
  };
};
