/**
 * The bot's sends on a session account, against a scripted RPC: one
 * `execute` is one raw transaction from the bot's key, then one wait for
 * its receipt, no longer than the chain's RECEIPT_WAIT_MS; a shorter wait
 * asked for by the caller (a mirror with little of the request's budget
 * left) is honoured, and no time left is no receipt asked for at all, the
 * hash handed back as sent, not landed. viem would read a timeout of zero
 * as no timeout, which is the one thing a request near its cut-off cannot
 * afford, so the chain says it here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, custom, type Hex, parseEther } from "viem";
import { RECEIPT_WAIT_MS, createSessionChain } from "../../src/fleet/bot-session-chain.js";

const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address;
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
/** A throwaway key for the test's signer; nothing is sent anywhere. */
const KEY = ("0x" + "11".repeat(32)) as Hex;
const HASH = ("0x" + "ab".repeat(32)) as Hex;

/** A node that takes every send and answers the receipt after `receiptAfter` polls, or never when undefined. */
const fakeNode = (receiptAfter: number | undefined) => {
  const methods: string[] = [];
  let polls = 0, sentAt = 0;
  const block = { number: "0x10", hash: "0x" + "cc".repeat(32), parentHash: "0x" + "dd".repeat(32), timestamp: "0x1", baseFeePerGas: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: "0x" + "00".repeat(20), transactions: [], nonce: "0x0", difficulty: "0x0", extraData: "0x", logsBloom: "0x" + "00".repeat(256), mixHash: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), sha3Uncles: "0x" + "00".repeat(32), size: "0x0", stateRoot: "0x" + "00".repeat(32), totalDifficulty: "0x0", transactionsRoot: "0x" + "00".repeat(32), uncles: [] };
  const transport = custom({
    async request({ method }: { method: string; params?: unknown }) {
      methods.push(method);
      switch (method) {
        case "eth_chainId": return "0x1237";
        case "eth_getTransactionCount": return "0x0";
        case "eth_getBlockByNumber": return block;
        case "eth_blockNumber": return "0x10";
        case "eth_maxPriorityFeePerGas": return "0x1";
        case "eth_gasPrice": return "0x2";
        case "eth_estimateGas": return "0xaae60";
        case "eth_sendRawTransaction": sentAt = Date.now(); return HASH;
        case "eth_getTransactionReceipt":
          polls += 1;
          return receiptAfter !== undefined && polls >= receiptAfter ? { transactionHash: HASH, status: "0x1", blockNumber: "0x10", blockHash: block.hash, transactionIndex: "0x0", from: "0x" + "00".repeat(20), to: ACCOUNT, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [], logsBloom: "0x" + "00".repeat(256), type: "0x2" } : null;
        case "eth_getTransactionByHash": return null;
        default: throw new Error(`unscripted rpc: ${method}`);
      }
    },
  });
  return { transport, methods, receiptPolls: () => polls, sinceSend: () => Date.now() - sentAt };
};

const chainOn = (node: ReturnType<typeof fakeNode>, receiptWaitMs?: number) =>
  createSessionChain({ chainId: 4663, rpcUrl: "http://fake", signerKey: KEY, transport: node.transport, ...(receiptWaitMs !== undefined ? { receiptWaitMs } : {}) });

test("execute is one raw transaction from the bot's key, then the receipt: landed once the receipt says so", async () => {
  const node = fakeNode(1);
  const chain = chainOn(node, 2_000);
  const r = await chain.execute(ACCOUNT, ROUTER, parseEther("0.01"), "0x3593564c");
  assert.equal(r.hash, HASH);
  assert.equal(r.landed, true);
  assert.equal(node.methods.filter((m) => m === "eth_sendRawTransaction").length, 1, "one send");
  assert.ok(node.receiptPolls() >= 1, "the receipt was asked for");
  assert.equal(RECEIPT_WAIT_MS, 40_000, "the default wait fits api/bot.js's sixty seconds with the reply");
});

test("a receipt slower than the wait is a hash without a verdict: sent, not landed, and the wait is the caller's when it asks for a shorter one", async () => {
  const node = fakeNode(undefined);
  const chain = chainOn(node, 2_000);
  const r = await chain.execute(ACCOUNT, ROUTER, parseEther("0.01"), "0x3593564c", 300);
  const waited = node.sinceSend();
  assert.deepEqual(r, { hash: HASH, landed: false });
  // A timer can fire a millisecond early; the bound is the order of magnitude, not the exact tick.
  assert.ok(waited >= 280 && waited < 1_500, `the caller's 300 ms bounded the wait, not the chain's 2 s: ${waited} ms after the send`);
  assert.ok(node.receiptPolls() >= 1, "the receipt was asked for while there was time");
  // The caller cannot ask for more than the chain gives.
  const long = fakeNode(undefined);
  await chainOn(long, 300).execute(ACCOUNT, ROUTER, parseEther("0.01"), "0x3593564c", 60_000);
  const ceiling = long.sinceSend();
  assert.ok(ceiling >= 280 && ceiling < 1_500, `the chain's own wait is the ceiling: ${ceiling} ms after the send`);
});

test("no time left is no receipt asked for at all: the send goes out and comes back as sent, so a request at its cut-off still records and tells", async () => {
  const node = fakeNode(1);
  const chain = chainOn(node, 2_000);
  const r = await chain.execute(ACCOUNT, ROUTER, parseEther("0.01"), "0x3593564c", 0);
  assert.deepEqual(r, { hash: HASH, landed: false });
  assert.equal(node.methods.filter((m) => m === "eth_sendRawTransaction").length, 1, "the send itself went out");
  assert.equal(node.receiptPolls(), 0, "and the receipt was never asked for, which viem's zero would have waited for without end");
  const negative = fakeNode(1);
  assert.deepEqual(await chainOn(negative, 2_000).execute(ACCOUNT, ROUTER, parseEther("0.01"), "0x3593564c", -5), { hash: HASH, landed: false });
  assert.equal(negative.receiptPolls(), 0);
});
