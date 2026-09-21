import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import { createFleetPool } from "../../src/fleet/chain-pool.js";

/**
 * The signed step (specs/003-mainnet-beta/contracts/chain-adapter.md), against
 * scripted clients: the hash is recorded before the node sees the
 * transaction, a record that throws broadcasts nothing, a failure after the
 * signature is `unknown` and never a throw, and `resolve` reads the receipt
 * or the nonce and guesses nothing.
 */

const POOL = `0x${"9".repeat(40)}` as Address;
const OPERATOR = `0x${"a".repeat(40)}` as Address;
const RAW = `0x${"f00d".repeat(8)}` as Hex;
const HASH = keccak256(RAW);

type Script = { send?: () => Promise<Hex>; receipt?: (hash: Hex) => Promise<{ status: string }>; get?: (hash: Hex) => Promise<{ status: string }>; count?: number };
const clients = (s: Script) => {
  const log: string[] = [];
  const wallet = {
    account: { address: OPERATOR }, chain: null,
    prepareTransactionRequest: async (request: Record<string, unknown>) => { log.push(`prepare nonce=${request["nonce"]} to=${request["to"]}`); return request; },
    signTransaction: async () => { log.push("sign"); return RAW; },
    sendRawTransaction: async () => { log.push("broadcast"); return s.send ? s.send() : HASH; },
  } as unknown as WalletClient;
  const publicClient = {
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => { log.push("wait"); return s.receipt ? s.receipt(hash) : { status: "success" }; },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => { if (!s.get) throw new Error("TransactionReceiptNotFoundError"); return s.get(hash); },
    getTransactionCount: async ({ blockTag }: { blockTag: string }) => { log.push(`count:${blockTag}`); return s.count ?? 7; },
  } as unknown as PublicClient;
  return { pool: createFleetPool(wallet, publicClient, POOL), log };
};

describe("signAndBroadcast", () => {
  it("records the hash of the signed transaction before broadcasting it, and reports mined", async () => {
    const { pool, log } = clients({});
    const recorded: [Hex, number][] = [];
    const outcome = await pool.signAndBroadcast({ nonce: 7, functionName: "closeDraw", args: [`0x${"1".repeat(64)}`], record: async (hash, nonce) => { log.push("record"); recorded.push([hash, nonce]); } });
    assert.deepEqual(outcome, { status: "mined", hash: HASH });
    assert.deepEqual(recorded, [[HASH, 7]], "the hash is the signature's, known before any node saw it");
    assert.deepEqual(log, [`prepare nonce=7 to=${POOL}`, "sign", "record", "broadcast", "wait"]);
  });

  it("a plain transfer goes to its payee, not the pool", async () => {
    const { pool, log } = clients({});
    await pool.signAndBroadcast({ nonce: 1, to: `0x${"b".repeat(40)}`, value: 5n, record: async () => {} });
    assert.equal(log[0], `prepare nonce=1 to=0x${"b".repeat(40)}`);
  });

  it("a record that throws broadcasts nothing", async () => {
    const { pool, log } = clients({});
    await assert.rejects(pool.signAndBroadcast({ nonce: 7, functionName: "closeDraw", args: [`0x${"1".repeat(64)}`], record: async () => { throw new Error("store down"); } }), /store down/);
    assert.ok(!log.includes("broadcast"), log.join(","));
  });

  it("a broadcast that fails, or a receipt wait that fails, is unknown with the hash and nonce, never a throw", async () => {
    const dropped = clients({ send: async () => { throw new Error("HttpRequestError"); } });
    assert.deepEqual(await dropped.pool.signAndBroadcast({ nonce: 7, functionName: "closeDraw", args: [`0x${"1".repeat(64)}`], record: async () => {} }), { status: "unknown", hash: HASH, nonce: 7 });
    const timedOut = clients({ receipt: async () => { throw new Error("WaitForTransactionReceiptTimeoutError"); } });
    assert.deepEqual(await timedOut.pool.signAndBroadcast({ nonce: 7, functionName: "closeDraw", args: [`0x${"1".repeat(64)}`], record: async () => {} }), { status: "unknown", hash: HASH, nonce: 7 });
  });

  it("a receipt that reverted is reverted", async () => {
    const { pool } = clients({ receipt: async () => ({ status: "reverted" }) });
    assert.deepEqual(await pool.signAndBroadcast({ nonce: 7, functionName: "closeDraw", args: [`0x${"1".repeat(64)}`], record: async () => {} }), { status: "reverted", hash: HASH });
  });
});

describe("resolve and nextNonce", () => {
  it("a receipt decides mined or reverted, and the nonce is never asked", async () => {
    const mined = clients({ get: async () => ({ status: "success" }) });
    assert.deepEqual(await mined.pool.resolve(HASH, 7, OPERATOR), { status: "mined", hash: HASH });
    const reverted = clients({ get: async () => ({ status: "reverted" }) });
    assert.deepEqual(await reverted.pool.resolve(HASH, 7, OPERATOR), { status: "reverted", hash: HASH });
    assert.ok(!mined.log.some((l) => l.startsWith("count")));
  });

  it("no receipt: the nonce past this one is never-mined, the nonce at it is still unknown", async () => {
    const passed = clients({ count: 8 });
    assert.deepEqual(await passed.pool.resolve(HASH, 7, OPERATOR), { status: "never-mined", hash: HASH, nonce: 7 });
    assert.deepEqual(passed.log, ["count:latest"], "the mined count, not the pending one: a pending transaction is still a transaction");
    const pending = clients({ count: 7 });
    assert.deepEqual(await pending.pool.resolve(HASH, 7, OPERATOR), { status: "unknown", hash: HASH, nonce: 7 });
  });

  it("nextNonce reads the pending count", async () => {
    const { pool, log } = clients({ count: 12 });
    assert.equal(await pool.nextNonce(OPERATOR), 12);
    assert.deepEqual(log, ["count:pending"]);
  });
});
