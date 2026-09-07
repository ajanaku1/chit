/**
 * Stage 2 viem adapter for the FleetPool contract.
 *
 * Everything chain-specific for the pool lives here: the ABI, wei, and the
 * split between depositor-keyed and campaign-keyed calls. Callers speak wire
 * types and never see a ciphertext they did not seal themselves.
 */

import { parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import type { DrawView, LedgerInputs, QueuedView } from "./pool-ledger.js";

const POOL_ABI = parseAbi([
  "function deposit() payable",
  "function requestExit()",
  "function executeExit()",
  "function setPaused(bool paused_)",
  "function queueSpend(bytes encDepositor, uint256 amount, uint64 dueAt) returns (uint256)",
  "function postQueued(uint256 id, address depositor)",
  "function claimOperator(uint256 amount)",
  "function openDraw(bytes32 campaign, uint256 amount, uint64 dueAt, bytes ownerRef)",
  "function topUpDraw(bytes32 campaign, uint256 amount)",
  "function fund(bytes32 campaign, address[] accounts)",
  "function fundPrincipal(bytes32 campaign, address account, uint256 principal, uint256 gasCeiling)",
  "function commit(bytes32 campaign, uint256 actual)",
  "function rollback(bytes32 campaign, uint256 principalReturned) payable",
  "function closeDraw(bytes32 campaign)",
  "function depositorOf(address depositor) view returns (uint256 deposited, uint256 spent, uint64 exitRequestedAt, uint256 exitAmount)",
  "function drawOf(bytes32 campaign) view returns ((uint256 amount, uint256 spent, uint256 reserved, uint256 principalOut, uint64 dueAt, bytes ownerRef, uint8 state))",
  "function headroom(address depositor) view returns (uint256 perDepositor, uint256 perPool)",
  "function claimable() view returns (uint256)",
  "function paused() view returns (bool)",
  "function totalDeposited() view returns (uint256)",
  "function campaignCount() view returns (uint256)",
  "function campaignAt(uint256 index) view returns (bytes32)",
  "function queuedSpendCount() view returns (uint256)",
  "function queuedSpendAt(uint256 index) view returns ((bytes encDepositor, uint256 amount, uint64 dueAt, uint64 queuedAt, bool posted))",
]);

export const DRAW_STATE = { none: 0, pending: 1, funded: 2, closed: 3 } as const;

export type PoolDraw = DrawView & {
  campaign: Hex;
  spent: bigint;
  reserved: bigint;
  principalOut: bigint;
  dueAt: bigint;
};

export type PoolQueued = QueuedView & { id: bigint; dueAt: bigint; queuedAt: bigint };

export type DepositorRecord = {
  deposited: bigint;
  spent: bigint;
  exitRequestedAt: bigint;
  exitAmount: bigint;
};

export type FleetPool = {
  readonly address: Address;
  depositorOf(depositor: Address): Promise<DepositorRecord>;
  headroom(depositor: Address): Promise<{ perDepositor: bigint; perPool: bigint }>;
  paused(): Promise<boolean>;
  draws(): Promise<PoolDraw[]>;
  drawOf(campaign: Hex): Promise<PoolDraw | undefined>;
  queued(): Promise<PoolQueued[]>;
  /** Everything `availableBalance` needs, in one read pass. */
  ledgerInputs(depositor: Address): Promise<LedgerInputs>;
  openDraw(campaign: Hex, amount: bigint, dueAt: bigint, ownerRef: Hex): Promise<Hex>;
  topUpDraw(campaign: Hex, amount: bigint): Promise<Hex>;
  fund(campaign: Hex, accounts: readonly Address[]): Promise<Hex>;
  fundPrincipal(campaign: Hex, account: Address, principal: bigint, gasCeiling: bigint): Promise<Hex>;
  commit(campaign: Hex, actual: bigint): Promise<Hex>;
  rollback(campaign: Hex, principalReturned: bigint): Promise<Hex>;
  closeDraw(campaign: Hex): Promise<Hex>;
  queueSpend(encDepositor: Hex, amount: bigint, dueAt: bigint): Promise<Hex>;
  postQueued(id: bigint, depositor: Address): Promise<Hex>;
  claimable(): Promise<bigint>;
  claimOperator(amount: bigint): Promise<Hex>;
};

const ctx = (wallet: WalletClient) => ({ account: wallet.account ?? null, chain: wallet.chain ?? null });

export const createFleetPool = (
  wallet: WalletClient,
  publicClient: PublicClient,
  address: Address,
): FleetPool => {
  // viem infers a union of exact argument tuples per function name; the calls
  // below are checked against the ABI at the call site instead.
  const read = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
    publicClient.readContract({ address, abi: POOL_ABI, functionName, args } as never) as Promise<T>;

  const write = async (functionName: string, args: readonly unknown[], value?: bigint): Promise<Hex> => {
    const hash = await wallet.writeContract({
      ...ctx(wallet),
      address,
      abi: POOL_ABI,
      functionName,
      args,
      ...(value === undefined ? {} : { value }),
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  };

  const drawAt = async (campaign: Hex): Promise<PoolDraw | undefined> => {
    const raw = await read<{
      amount: bigint; spent: bigint; reserved: bigint; principalOut: bigint;
      dueAt: bigint; ownerRef: Hex; state: number;
    }>("drawOf", [campaign]);
    if (raw.state === DRAW_STATE.none) return undefined;
    return { campaign, ...raw };
  };

  const allDraws = async (): Promise<PoolDraw[]> => {
    const count = await read<bigint>("campaignCount");
    const draws: PoolDraw[] = [];
    for (let i = 0n; i < count; i += 1n) {
      const campaign = await read<Hex>("campaignAt", [i]);
      const draw = await drawAt(campaign);
      if (draw) draws.push(draw);
    }
    return draws;
  };

  const allQueued = async (): Promise<PoolQueued[]> => {
    const count = await read<bigint>("queuedSpendCount");
    const entries: PoolQueued[] = [];
    for (let i = 0n; i < count; i += 1n) {
      const raw = await read<{
        encDepositor: Hex; amount: bigint; dueAt: bigint; queuedAt: bigint; posted: boolean;
      }>("queuedSpendAt", [i]);
      entries.push({ id: i, ...raw });
    }
    return entries;
  };

  return {
    address,

    async depositorOf(depositor) {
      const [deposited, spent, exitRequestedAt, exitAmount] = await read<
        readonly [bigint, bigint, bigint, bigint]
      >("depositorOf", [depositor]);
      return { deposited, spent, exitRequestedAt, exitAmount };
    },

    async headroom(depositor) {
      const [perDepositor, perPool] = await read<readonly [bigint, bigint]>("headroom", [depositor]);
      return { perDepositor, perPool };
    },

    paused: () => read<boolean>("paused"),
    draws: allDraws,
    drawOf: drawAt,
    queued: allQueued,

    async ledgerInputs(depositor) {
      const [record, queued, draws] = await Promise.all([
        this.depositorOf(depositor),
        allQueued(),
        allDraws(),
      ]);
      return { deposited: record.deposited, spent: record.spent, queued, draws };
    },

    openDraw: (campaign, amount, dueAt, ownerRef) =>
      write("openDraw", [campaign, amount, dueAt, ownerRef]),
    topUpDraw: (campaign, amount) => write("topUpDraw", [campaign, amount]),
    fund: (campaign, accounts) => write("fund", [campaign, accounts]),
    fundPrincipal: (campaign, account, principal, gasCeiling) =>
      write("fundPrincipal", [campaign, account, principal, gasCeiling]),
    commit: (campaign, actual) => write("commit", [campaign, actual]),
    rollback: (campaign, principalReturned) =>
      write("rollback", [campaign, principalReturned], principalReturned),
    closeDraw: (campaign) => write("closeDraw", [campaign]),
    queueSpend: (encDepositor, amount, dueAt) => write("queueSpend", [encDepositor, amount, dueAt]),
    postQueued: (id, depositor) => write("postQueued", [id, depositor]),
    claimable: () => read<bigint>("claimable"),
    claimOperator: (amount) => write("claimOperator", [amount]),
  };
};
