import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createPublicClient, http } from "viem";

import { BLOCK_TIME_MS, chainName, robinhoodChain } from "../../src/fleet/chain-def.js";

/**
 * One definition of the chain, for every client in the service (T041's other
 * half). A chain that does not state its block time makes viem poll a receipt
 * every four seconds, because that is its default for a chain it knows nothing
 * about, and Robinhood Chain seals a block in about a quarter of a second: a
 * write that landed at once was still waited on for four. `fixed_M3c` holds
 * that for the fleet service; every other client of the same chain had its own
 * `defineChain` and its own four seconds. They share this one now.
 */

const fleet = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), "src", "fleet");
const polling = (chainId: number): number =>
  createPublicClient({ chain: robinhoodChain(chainId, "http://127.0.0.1:1"), transport: http("http://127.0.0.1:1") }).pollingInterval;

describe("the chain every fleet client builds on", () => {
  it("states its block time, so a receipt is polled twice a second on either chain", () => {
    assert.ok(BLOCK_TIME_MS <= 1_000, "Robinhood Chain seals a block well inside a second");
    assert.equal(polling(46630), BLOCK_TIME_MS * 2);
    assert.equal(polling(4663), BLOCK_TIME_MS * 2);
    assert.equal(robinhoodChain(46630, "http://rpc.example").rpcUrls.default.http[0], "http://rpc.example");
  });

  it("names the chain it is, and says so plainly for one it does not know", () => {
    assert.equal(chainName(4663), "Robinhood Chain");
    assert.equal(chainName(46630), "Robinhood Chain Testnet");
    assert.equal(chainName(31337), "chain 31337");
    // A testnet client that calls itself "Robinhood Chain" reads as mainnet in
    // a log and in a wallet's prompt; bot-link-runtime.ts did exactly that.
    assert.notEqual(chainName(46630), chainName(4663));
  });

  it("is the only chain definition in the service: nothing else calls defineChain", async () => {
    const offenders: string[] = [];
    for (const name of (await readdir(fleet)).filter((f) => f.endsWith(".ts") && f !== "chain-def.ts")) {
      if (/defineChain\(/.test(await readFile(join(fleet, name), "utf8"))) offenders.push(name);
    }
    assert.deepEqual(offenders, [], "a chain defined here again is a chain without a block time again");
  });
});
