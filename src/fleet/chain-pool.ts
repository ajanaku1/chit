/**
 * Stage 2 viem adapter for the FleetPool contract.
 *
 * Everything chain-specific for the pool lives here: the ABI, wei, and the
 * split between depositor-keyed and campaign-keyed calls. Callers speak wire
 * types and never see a ciphertext they did not seal themselves.
 */

import { encodeFunctionData, keccak256, parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import type { DrawView, LedgerInputs, QueuedView } from "./pool-ledger.js";
import { createPoolReads, type PoolReadCache } from "./pool-reads.js";

const POOL_ABI = parseAbi([
  "function deposit() payable",
  "function requestExit()",
  "function executeExit()",
  "function setPaused(bool paused_)",
  "function queueSpendBatch(bytes[] encDepositors, uint256[] amounts, uint64[] dueAts) returns (uint256[])",
  "function postQueued(bytes32 id, address depositor)",
  "function postQueuedBatch(bytes32[] ids, address[] depositors) returns (uint8[])",
  "function donate() payable",
  "function claimOperator(uint256 amount)",
  "function openDraw(bytes32 campaign, uint256 amount, uint64 dueAt, bytes ownerRef)",
  "function topUpDraw(bytes32 campaign, uint256 amount)",
  "function fund(bytes32 campaign, address[] accounts)",
  "function fundPrincipal(bytes32 campaign, address account, uint256 principal, uint256 gasCeiling)",
  "function fundAndExecute(bytes32 campaign, address account, uint256 principal, uint256 gasCeiling, address target, bytes data) returns (bytes)",
  "function commit(bytes32 campaign, uint256 actual)",
  "function rollback(bytes32 campaign, uint256 principalReturned) payable",
  "function closeDraw(bytes32 campaign)",
  "function depositorOf(address depositor) view returns (uint256 deposited, uint256 spent, uint64 exitRequestedAt, uint256 exitAmount)",
  "function drawOf(bytes32 campaign) view returns ((uint256 amount, uint256 spent, uint256 reserved, uint256 principalOut, uint64 dueAt, bytes ownerRef, uint8 state))",
  "function headroom(address depositor) view returns (uint256 perDepositor, uint256 perPool)",
  "function claimable() view returns (uint256)",
  "function totalPosted() view returns (uint256)",
  "function everDeposited() view returns (uint256)",
  "function exitsPaid() view returns (uint256)",
  "function donated() view returns (uint256)",
  "function paused() view returns (bool)",
  "function DEPOSITOR_CAP() view returns (uint256)",
  "function DRAW_CAP() view returns (uint256)",
  "function POOL_CAP() view returns (uint256)",
  "function totalDeposited() view returns (uint256)",
  "function campaignCount() view returns (uint256)",
  "function campaignAt(uint256 index) view returns (bytes32)",
  "function queuedSpendCount() view returns (uint256)",
  "function queuedSpendAt(uint256 index) view returns (bytes32 id, (bytes encDepositor, uint256 amount, uint64 dueAt, uint64 queuedAt, bool posted) entry)",
]);

export const DRAW_STATE = { none: 0, pending: 1, funded: 2, closed: 3 } as const;

export type PoolDraw = DrawView & {
  campaign: Hex;
  spent: bigint;
  reserved: bigint;
  principalOut: bigint;
  dueAt: bigint;
};

/** `id` is the contract's hash for the entry, never its position. */
export type PoolQueued = QueuedView & { id: Hex; dueAt: bigint; queuedAt: bigint };

export type DepositorRecord = {
  deposited: bigint;
  spent: bigint;
  exitRequestedAt: bigint;
  exitAmount: bigint;
};

/**
 * What a signed step came to. `unknown` is a transaction that was signed and
 * recorded and whose fate this process could not see (the broadcast or the
 * receipt wait failed); it is resolved later by its hash, never guessed.
 * `never-mined` is `resolve`'s answer when no receipt exists and the account's
 * nonce has moved past the one it was signed with: nothing happened, and the
 * work it carried may be done again.
 */
export type WriteOutcome =
  | { status: "mined"; hash: Hex }
  /** `reason` is the contract's own error when something named it; a receipt alone names nothing. */
  | { status: "reverted"; hash: Hex; reason?: string }
  | { status: "unknown"; hash: Hex; nonce: number }
  | { status: "never-mined"; hash: Hex; nonce: number };

/**
 * One money-moving write (specs/003-mainnet-beta/contracts/chain-adapter.md).
 * Either a function of the pool or, for a withdrawal payout, a plain transfer
 * to `to`. `record` runs with the hash after signing and before broadcast and
 * must persist it durably; if it throws, nothing is broadcast.
 */
export type SignedStep = {
  nonce: number;
  value?: bigint;
  gas?: bigint;
  record: (hash: Hex, nonce: number) => Promise<void>;
} & ({ functionName: string; args: readonly unknown[]; to?: undefined } | { to: Address; functionName?: undefined; args?: undefined });

export type FleetPool = {
  readonly address: Address;
  /** The nonce a signed step will use: the pending count, so a step queued behind another lands after it. */
  nextNonce(from: Address): Promise<number>;
  /** Sign, persist the hash, broadcast, wait: mined, reverted or unknown, and never a throw to mean "nothing happened". */
  signAndBroadcast(step: SignedStep): Promise<WriteOutcome>;
  /** A write whose outcome was never observed: a receipt decides; no receipt once the nonce has passed decides never-mined; else still unknown. */
  resolve(hash: Hex, nonce: number, from: Address): Promise<WriteOutcome>;
  depositorOf(depositor: Address): Promise<DepositorRecord>;
  headroom(depositor: Address): Promise<{ perDepositor: bigint; perPool: bigint }>;
  /** The pool's caps, immutable since deployment; read once and kept. */
  caps(): Promise<{ depositor: bigint; draw: bigint; pool: bigint }>;
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
  /** Funds the principal and runs the buy in one transaction; reverts whole if the buy does. */
  fundAndExecute(campaign: Hex, account: Address, principal: bigint, gasCeiling: bigint, target: Address, data: Hex, gas?: bigint): Promise<Hex>;
  commit(campaign: Hex, actual: bigint): Promise<Hex>;
  rollback(campaign: Hex, principalReturned: bigint): Promise<Hex>;
  closeDraw(campaign: Hex): Promise<Hex>;
  /** One transaction for a sweep's worth of charges; each entry on its own timer. */
  queueSpendBatch(encDepositors: readonly Hex[], amounts: readonly bigint[], dueAts: readonly bigint[]): Promise<Hex>;
  postQueued(id: Hex, depositor: Address): Promise<Hex>;
  /** Many postings in one transaction; the contract reports per entry and reverts for none of them. */
  postQueuedBatch(ids: readonly Hex[], depositors: readonly Address[]): Promise<Hex>;
  /** ETH to the pool crediting nobody: how a short pool is made whole, paused or not. */
  donate(amount: bigint): Promise<Hex>;
  claimable(): Promise<bigint>;
  claimOperator(amount: bigint): Promise<Hex>;
};

const ctx = (wallet: WalletClient) => ({ account: wallet.account ?? null, chain: wallet.chain ?? null });

let capsCache: Promise<{ depositor: bigint; draw: bigint; pool: bigint }> | undefined;

export const createFleetPool = (
  wallet: WalletClient,
  publicClient: PublicClient,
  address: Address,
  /** `cache` is where the queue's mark is kept between instances; this instance's memory when absent. */
  options: { cache?: PoolReadCache } = {},
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

  // The two lists only grow. They are read in pool-reads.ts: through Multicall3,
  // so the round trips do not grow with them, and the queue from a mark, so
  // charges whose window has closed are not read again.
  const reads = createPoolReads(publicClient, address, options);
  const allDraws = (): Promise<PoolDraw[]> => reads.draws();
  const allQueued = (): Promise<PoolQueued[]> => reads.queued();

  /**
   * The lifecycle every caller that moves money goes through. The hash is
   * known from the signature alone, so it is recorded before the node ever
   * sees the transaction: a process that dies between the two leaves a row
   * that says "sent" and a hash to resolve, never a transaction the store
   * has no name for. A failure after the broadcast is `unknown`, because the
   * transaction may well be in a block by the time the error reaches here.
   */
  const signAndBroadcast = async (step: SignedStep): Promise<WriteOutcome> => {
    const request = await wallet.prepareTransactionRequest({
      ...ctx(wallet),
      to: step.to ?? address,
      ...(step.to ? {} : { data: encodeFunctionData({ abi: POOL_ABI, functionName: step.functionName, args: step.args } as never) }),
      ...(step.value === undefined ? {} : { value: step.value }),
      ...(step.gas === undefined ? {} : { gas: step.gas }),
      nonce: step.nonce,
    } as never);
    const serialized = await wallet.signTransaction(request as never);
    const hash = keccak256(serialized);
    await step.record(hash, step.nonce);
    try {
      await wallet.sendRawTransaction({ serializedTransaction: serialized });
    } catch {
      return { status: "unknown", hash, nonce: step.nonce };
    }
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return { status: receipt.status === "success" ? "mined" : "reverted", hash };
    } catch {
      return { status: "unknown", hash, nonce: step.nonce };
    }
  };

  const resolve = async (hash: Hex, nonce: number, from: Address): Promise<WriteOutcome> => {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      return { status: receipt.status === "success" ? "mined" : "reverted", hash };
    } catch {
      // No receipt. Mined or not is decided by the account's nonce, never by the error.
    }
    const count = await publicClient.getTransactionCount({ address: from, blockTag: "latest" });
    return count > nonce ? { status: "never-mined", hash, nonce } : { status: "unknown", hash, nonce };
  };

  return {
    address,
    nextNonce: (from) => publicClient.getTransactionCount({ address: from, blockTag: "pending" }),
    signAndBroadcast,
    resolve,

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
    caps: () => (capsCache ??= Promise.all([read<bigint>("DEPOSITOR_CAP"), read<bigint>("DRAW_CAP"), read<bigint>("POOL_CAP")])
      .then(([depositor, draw, pool]) => ({ depositor, draw, pool }))
      .catch((error: unknown) => { capsCache = undefined; throw error; })),
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
    fundAndExecute: async (campaign, account, principal, gasCeiling, target, data, gas) => {
      const hash = await wallet.writeContract({
        ...ctx(wallet), address, abi: POOL_ABI, functionName: "fundAndExecute",
        args: [campaign, account, principal, gasCeiling, target, data],
        ...(gas === undefined ? {} : { gas }),
      } as never);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`fundAndExecute reverted: ${hash}`);
      return hash;
    },
    commit: (campaign, actual) => write("commit", [campaign, actual]),
    rollback: (campaign, principalReturned) =>
      write("rollback", [campaign, principalReturned], principalReturned),
    closeDraw: (campaign) => write("closeDraw", [campaign]),
    queueSpendBatch: (encDepositors, amounts, dueAts) => write("queueSpendBatch", [encDepositors, amounts, dueAts]),
    postQueued: (id, depositor) => write("postQueued", [id, depositor]),
    postQueuedBatch: (ids, depositors) => write("postQueuedBatch", [ids, depositors]),
    donate: (amount) => write("donate", [], amount),
    claimable: () => read<bigint>("claimable"),
    claimOperator: (amount) => write("claimOperator", [amount]),
  };
};
