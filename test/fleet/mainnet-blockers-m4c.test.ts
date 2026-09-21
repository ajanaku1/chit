import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import type { FleetPool, PoolDraw } from "../../src/fleet/chain-pool.js";
import { DRAW_STATE } from "../../src/fleet/chain-pool.js";
import { GAS_HEADROOM, coarseCharge, createPoolService } from "../../src/fleet/pool-buy.js";
import { ledgerKey, sealDepositor } from "../../src/fleet/pool-ledger.js";
import { createMemoryStore } from "../../src/fleet/store.js";

/**
 * The verification addendum's 4.2: the write-then-wait ambiguity of M4 is not
 * limited to the batch and the buy. The same failure on fund(): the
 * transaction lands, the receipt wait gives up. Replaces finding_M4c (T024):
 * the draw's own state settles what happened, and the headroom is charged.
 */

const KEY = ledgerKey(`0x${"7".repeat(64)}`);
const ALICE = "0x00000000000000000000000000000000000a11ce" as Address;
const NOW = 1_700_000_000n;
const campaign = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const account = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;

const publicClient = { getBlock: async () => ({ timestamp: NOW }), getGasPrice: async () => 1_000_000_000n } as unknown as PublicClient;
const wallet = { account: { address: account(0xdead) }, chain: null } as unknown as WalletClient;

describe("M4: the same ambiguity on fund()", () => {
  it("fixed_M4c: a fund() that landed while its receipt wait failed is read from the draw, reported funded, and its headroom charged", async () => {
    const draw: PoolDraw = {
      campaign: campaign(1), amount: parseEther("0.01"), spent: 0n, reserved: 0n, principalOut: 0n,
      dueAt: NOW - 1_000n, ownerRef: sealDepositor(KEY, ALICE), state: DRAW_STATE.pending,
    };
    let fundCalls = 0;
    const pool = {
      address: account(0x901),
      draws: async () => [draw],
      drawOf: async (c: Hex) => (c === draw.campaign ? draw : undefined),
      queued: async () => [],
      nextNonce: async () => 3,
      signAndBroadcast: async (step: { nonce: number; functionName?: string; args?: readonly unknown[]; record: (h: Hex, n: number) => Promise<void> }) => {
        const hash = `0x${"e".repeat(64)}` as Hex;
        await step.record(hash, step.nonce);
        fundCalls += 1;
        // What the chain did: headroom left the pool and the draw is Funded.
        draw.spent += GAS_HEADROOM * BigInt((step.args![1] as readonly Address[]).length);
        draw.state = DRAW_STATE.funded;
        // What the adapter reports: the wait for the receipt gave up.
        return { status: "unknown", hash, nonce: step.nonce };
      },
      resolve: async (hash: Hex, nonce: number) => ({ status: "unknown", hash, nonce }),
    } as unknown as FleetPool;
    const store = createMemoryStore();
    const service = createPoolService(wallet, publicClient, pool, KEY, { store, delaySeconds: () => 120, random: () => 0.5 });
    const fleet = [1, 2, 3, 4, 5].map(account);

    const first = await service.sweep(async () => fleet);
    const second = await service.sweep(async () => fleet);

    assert.deepEqual(first.funded, [draw.campaign], "the draw is no longer Pending: it was funded, whatever the receipt wait said");
    assert.equal(draw.spent, GAS_HEADROOM * 5n, "0.001 ETH left the pool for the five accounts");
    assert.equal(fundCalls, 1, "the next sweep does not try again");
    assert.deepEqual(second.funded, []);
    assert.equal(await store.owedFor(ALICE), coarseCharge(GAS_HEADROOM * 5n).toString(), "and the headroom is charged to the depositor, once");
  });
});
