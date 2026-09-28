/**
 * The SellChain adapter (docs/design-sell.md) against a fake node. What is
 * pinned: transfers come from the receipt's own Transfer logs and a failed or
 * missing receipt counts for nothing; every send takes the operator lock and
 * broadcasts nothing once the lease is gone; the ETH a swap brought is the
 * balance across its block with its own gas added back.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, pad, toEventSelector, type PublicClient } from "viem";

import type { FleetPool, SignedStep } from "../../src/fleet/chain-pool.js";
import { createSellChain } from "../../src/fleet/sell-chain.js";
import { createMemoryStore, type StorePort } from "../../src/fleet/store.js";
import type { Address, Hex } from "../../src/fleet/types.js";

const OPERATOR = `0x${"0e".repeat(20)}` as Address;
const TOKEN = `0x${"cd".repeat(20)}` as Address;
const ACCOUNT = `0x${"a1".repeat(20)}` as Address;
const H = `0x${"11".repeat(32)}` as Hex;
const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");

const transferLog = (from: Address, to: Address, value: bigint) => ({
  address: TOKEN, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: encodeAbiParameters([{ type: "uint256" }], [value]),
  blockNumber: 10n, transactionHash: H, logIndex: 0, blockHash: H, transactionIndex: 0, removed: false,
});

const clientOf = (receipt: Record<string, unknown> | undefined, balances: Record<string, bigint> = {}) => ({
  getTransactionReceipt: async () => { if (!receipt) throw new Error("not found"); return receipt; },
  getBalance: async ({ blockNumber }: { blockNumber: bigint }) => balances[String(blockNumber)] ?? 0n,
  readContract: async () => true,
}) as unknown as PublicClient;

const poolOf = (sent: SignedStep[]): FleetPool => ({
  nextNonce: async () => 7,
  signAndBroadcast: async (step: SignedStep) => { await step.record(H, step.nonce); sent.push(step); return { status: "mined", hash: H }; },
  resolve: async () => ({ status: "mined", hash: H }),
}) as unknown as FleetPool;

const adapter = (client: PublicClient, sent: SignedStep[] = [], store: StorePort = createMemoryStore()) =>
  createSellChain({ publicClient: client, pool: poolOf(sent), store, operator: OPERATOR, policy: `0x${"99".repeat(20)}` as Address, market: { tokenQuote: async () => { throw new Error("unused"); }, holdings: async () => [], campaignsOf: async () => [] } });

describe("the sale's chain adapter", () => {
  it("reads transfers from the receipt's Transfer logs", async () => {
    const chain = adapter(clientOf({ status: "success", logs: [transferLog(ACCOUNT, OPERATOR, 5_000n)] }));
    const seen = await chain.transfersIn(H);
    assert.equal(seen.mined, true);
    assert.deepEqual(seen.transfers.map((t) => ({ ...t, token: t.token.toLowerCase(), from: t.from.toLowerCase(), to: t.to.toLowerCase() })), [{ token: TOKEN, from: ACCOUNT, to: OPERATOR, amount: 5_000n }]);
  });

  it("counts nothing from a reverted or missing receipt", async () => {
    assert.deepEqual(await adapter(clientOf({ status: "reverted", logs: [transferLog(ACCOUNT, OPERATOR, 5_000n)] })).transfersIn(H), { mined: false, transfers: [] });
    assert.deepEqual(await adapter(clientOf(undefined)).transfersIn(H), { mined: false, transfers: [] });
  });

  it("sends under the operator lock, at the pending nonce, with the call's data", async () => {
    const sent: SignedStep[] = [];
    const recorded: [Hex, number][] = [];
    const outcome = await adapter(clientOf(undefined), sent).send({ to: TOKEN, data: "0x1234", record: async (h, n) => { recorded.push([h, n]); } });
    assert.equal(outcome.status, "mined");
    assert.deepEqual({ to: sent[0]!.to, data: sent[0]!.data, nonce: sent[0]!.nonce }, { to: TOKEN, data: "0x1234", nonce: 7 });
    assert.deepEqual(recorded, [[H, 7]]);
  });

  it("broadcasts nothing once the operator lease is lost", async () => {
    const store = createMemoryStore();
    const lost: StorePort = { ...store, withLock: (_name, work) => work({ renew: async () => undefined, held: async () => false }) };
    const recorded: Hex[] = [];
    await assert.rejects(adapter(clientOf(undefined), [], lost).send({ to: TOKEN, record: async (h) => { recorded.push(h); } }), /OperatorLockLost/);
    assert.deepEqual(recorded, [], "the step's own record never ran");
  });

  it("owes the ETH the swap brought: the balance across its block with its gas added back", async () => {
    const client = clientOf({ status: "success", logs: [], blockNumber: 100n, gasUsed: 200_000n, effectiveGasPrice: 10n }, { "99": 1_000_000n, "100": 1_500_000n });
    assert.equal(await adapter(client).ethReceived(H), 500_000n + 2_000_000n);
  });
});

describe("measuring a swap at send time", () => {
  it("is the balance just after the receipt less just before the broadcast, gas added back, with no old block read", async () => {
    const reads: (bigint | undefined)[] = [];
    let balance = 1_000_000n;
    const client = {
      getBalance: async ({ blockNumber }: { blockNumber?: bigint }) => { reads.push(blockNumber); return balance; },
      getTransactionReceipt: async () => ({ status: "success", gasUsed: 200_000n, effectiveGasPrice: 10n, blockNumber: 100n, logs: [] }),
      readContract: async () => true,
    } as unknown as PublicClient;
    const pool = {
      nextNonce: async () => 7,
      signAndBroadcast: async (step: SignedStep) => { await step.record(H, step.nonce); balance += 500_000n - 2_000_000n; return { status: "mined", hash: H }; },
      resolve: async () => ({ status: "mined", hash: H }),
    } as unknown as FleetPool;
    const chain = createSellChain({ publicClient: client, pool, store: createMemoryStore(), operator: OPERATOR, policy: `0x${"99".repeat(20)}` as Address, market: { tokenQuote: async () => { throw new Error("unused"); }, holdings: async () => [], campaignsOf: async () => [] } });
    const { outcome, received } = await chain.swap!({ to: TOKEN, data: "0x12", record: async () => undefined });
    assert.equal(outcome.status, "mined");
    assert.equal(received, 500_000n, "the 500,000 the swap brought, its 2,000,000 of gas added back");
    assert.deepEqual(reads, [undefined, undefined], "both reads at latest");
  });
});
