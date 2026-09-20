import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import type { FleetPool, PoolDraw } from "../../src/fleet/chain-pool.js";
import { DRAW_STATE } from "../../src/fleet/chain-pool.js";
import { GAS_HEADROOM, createPoolService } from "../../src/fleet/pool-buy.js";
import { ledgerKey, sealDepositor } from "../../src/fleet/pool-ledger.js";
import { createMemoryStore } from "../../src/fleet/store.js";

/**
 * The verification addendum's 4.2: the write-then-wait ambiguity of M4 is not
 * limited to the batch and the buy. This is the same failure on fund(): the
 * transaction lands, the receipt wait throws, and the headroom that left the
 * pool is never charged to anyone. Passes today; the fix flips it.
 */

const KEY = ledgerKey(`0x${"7".repeat(64)}`);
const ALICE = "0x00000000000000000000000000000000000a11ce" as Address;
const NOW = 1_700_000_000n;
const campaign = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const account = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;

const publicClient = { getBlock: async () => ({ timestamp: NOW }), getGasPrice: async () => 1_000_000_000n } as unknown as PublicClient;
const wallet = { account: { address: account(0xdead) }, chain: null } as unknown as WalletClient;

describe("M4: the same ambiguity on fund()", () => {
  it("finding_M4c: a fund() that landed while its receipt wait failed seeds the fleet and charges nobody, now or later", async () => {
    const draw: PoolDraw = {
      campaign: campaign(1), amount: parseEther("0.01"), spent: 0n, reserved: 0n, principalOut: 0n,
      dueAt: NOW - 1_000n, ownerRef: sealDepositor(KEY, ALICE), state: DRAW_STATE.pending,
    };
    let fundCalls = 0;
    const pool = {
      address: account(0x901),
      draws: async () => [draw],
      queued: async () => [],
      fund: async (_c: Hex, accounts: readonly Address[]) => {
        fundCalls += 1;
        // What the chain did: headroom left the pool and the draw is Funded.
        draw.spent += GAS_HEADROOM * BigInt(accounts.length);
        draw.state = DRAW_STATE.funded;
        // What chain-pool.ts write() then reports: the wait for the receipt gave up.
        throw new Error("WaitForTransactionReceiptTimeoutError: Timed out while waiting for transaction");
      },
    } as unknown as FleetPool;
    const store = createMemoryStore();
    const service = createPoolService(wallet, publicClient, pool, KEY, { store, delaySeconds: () => 120, random: () => 0.5 });
    const fleet = [1, 2, 3, 4, 5].map(account);

    const original = console.error;
    console.error = () => {};
    const first = await service.sweep(async () => fleet).finally(() => { console.error = original; });
    const second = await service.sweep(async () => fleet);

    assert.deepEqual(first.funded, [], "the sweep believes nothing was funded");
    assert.equal(draw.spent, GAS_HEADROOM * 5n, "0.001 ETH left the pool for the five accounts");
    assert.equal(fundCalls, 1, "the next sweep does not try again: the draw is no longer Pending");
    assert.deepEqual(second.funded, []);
    assert.equal(await store.owedFor(ALICE), "0", "and the headroom is never charged to the depositor");
  });
});
