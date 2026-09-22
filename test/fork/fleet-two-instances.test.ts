import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { createWalletClient, custom, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createFleetPool } from "../../src/fleet/chain-pool.js";
import { ledgerKey } from "../../src/fleet/pool-ledger.js";
import { createPoolService } from "../../src/fleet/pool-buy.js";
import { TESTNET_CAPS } from "../../src/fleet/pool-caps.js";
import { HELD, type StorePort } from "../../src/fleet/store.js";
import { createNeonStore } from "../../src/fleet/store-neon.js";

/**
 * Two instances of the service, one operator account, a real node (T029).
 *
 * The unit test in test/fleet/operator-lock.test.ts drives a node that keeps
 * an account's nonce the way a node does. This is the same collision against
 * the real thing: two adapters over the same operator wallet, two services
 * over one store on a real Postgres, and the local chain's own account
 * nonces. Every signed step lands, none is refused, and the nonces the chain
 * saw are a sequence.
 *
 * The operator is a local account, not one of the node's: the signed step
 * signs before it broadcasts (the hash is recorded first), which a JSON-RPC
 * account cannot do. Found by this test: the pool suites still hand the
 * service the node's own accounts, and every signed step in them fails on
 * "eth_signTransaction is not supported".
 */
describe("Two instances on one operator account", () => {
  const OPERATOR_KEY = `0x${"7".repeat(64)}` as const;
  let viem: Awaited<ReturnType<typeof network.connect>>["viem"];
  let provider: Awaited<ReturnType<typeof network.connect>>["provider"];

  before(async () => {
    ({ viem, provider } = await network.connect({ network: "default" }));
  });

  it("withdrawals and a sweep from two instances at once are signed one nonce at a time", async () => {
    const [funder, alice, bob] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const operator = createWalletClient({ account: privateKeyToAccount(OPERATOR_KEY), chain: publicClient.chain, transport: custom(provider) });
    await funder!.sendTransaction({ to: operator.account.address, value: parseEther("1") });
    const contract = await viem.deployContract("FleetPool", [operator.account.address, operator.account.address, TESTNET_CAPS.depositor, TESTNET_CAPS.draw, TESTNET_CAPS.pool]);
    const key = ledgerKey(OPERATOR_KEY);

    // One store between the instances, on a real Postgres, so the lock is the row they would share on chit.tools.
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    const sql = { query: async (q: string, params?: unknown[]) => (await db.query(q, params)).rows as Record<string, unknown>[] };
    const store = createNeonStore(sql, { pollMs: 5 });
    await store.initialize();

    try {
      // Two adapters, as two warm functions have: each reads the chain's pending count for itself.
      const instance = () => createPoolService(operator, publicClient, createFleetPool(operator, publicClient, contract.address as Address), key, { store, delaySeconds: () => 90 });
      const [a, b] = [instance(), instance()];

      await contract.write.deposit({ account: alice!.account, value: parseEther("0.1") });
      await contract.write.deposit({ account: bob!.account, value: parseEther("0.1") });
      const before = await publicClient.getTransactionCount({ address: operator.account.address });

      // A draw opened by one instance and waited out, for the other's sweep to fund; and two withdrawals, one per instance.
      const campaign = `0x${"c".repeat(64)}` as const;
      await a.openDraw({ campaign, depositor: alice!.account.address, amount: parseEther("0.02").toString() });
      const test = await viem.getTestClient();
      await test.increaseTime({ seconds: 120 });
      await test.mine({ blocks: 1 });
      const payee = "0x00000000000000000000000000000000000f3e58" as Address;

      const [wa, wb, report] = await Promise.all([
        a.withdraw({ depositor: alice!.account.address, amount: parseEther("0.01").toString(), destination: payee }),
        b.withdraw({ depositor: bob!.account.address, amount: parseEther("0.02").toString(), destination: payee }),
        b.sweep(async () => [`0x${"1".repeat(40)}` as Address], { queueOwed: true }),
      ]);

      assert.equal(wa.unresolved, undefined, "alice's payout was seen mined");
      assert.equal(wb.unresolved, undefined, "bob's payout was seen mined");
      assert.equal(await publicClient.getBalance({ address: payee }), parseEther("0.03"), "both payouts landed");
      // The sweep funded the draw if it saw it due; the charges the withdrawals recorded are queued by this or the next sweep.
      const later = await b.sweep(async () => [`0x${"1".repeat(40)}` as Address], { queueOwed: true });
      assert.equal((report.funded.length + later.funded.length), 1, "the draw was funded exactly once across the two sweeps");
      assert.equal((report.queued ?? 0) + (later.queued ?? 0), 3, "two payouts and the funding's headroom: three charges queued, none twice");

      // What the chain saw: one nonce per signed step, in sequence, nothing refused and nothing stuck.
      const after = await publicClient.getTransactionCount({ address: operator.account.address });
      const pending = await publicClient.getTransactionCount({ address: operator.account.address, blockTag: "pending" });
      assert.equal(pending, after, "no transaction is waiting on a nonce gap");
      const steps = 1 /* openDraw */ + 2 /* payouts */ + 1 /* fund */ + (report.queued ? 1 : 0) + (later.queued ? 1 : 0);
      assert.equal(after - before, steps, "every signed step took one nonce");
      assert.deepEqual(await store.sentBatches(), [], "nothing is left sent under a hash that never mined");
    } finally {
      await db.close();
    }
  });

  it("without the lock, the same two withdrawals read one nonce from the node and one of them is refused: what the lock closes", async () => {
    const [funder, alice, bob] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const operator = createWalletClient({ account: privateKeyToAccount(`0x${"8".repeat(64)}`), chain: publicClient.chain, transport: custom(provider) });
    await funder!.sendTransaction({ to: operator.account.address, value: parseEther("1") });
    const contract = await viem.deployContract("FleetPool", [operator.account.address, operator.account.address, TESTNET_CAPS.depositor, TESTNET_CAPS.draw, TESTNET_CAPS.pool]);
    const key = ledgerKey(`0x${"8".repeat(64)}`);

    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    const sql = { query: async (q: string, params?: unknown[]) => (await db.query(q, params)).rows as Record<string, unknown>[] };
    const shared = createNeonStore(sql, { pollMs: 5 });
    await shared.initialize();
    // The store as it was: a lock that locks nothing.
    const store: StorePort = { ...shared, withLock: (_name, work) => work(HELD) };

    try {
      const instance = () => createPoolService(operator, publicClient, createFleetPool(operator, publicClient, contract.address as Address), key, { store, delaySeconds: () => 90 });
      const [a, b] = [instance(), instance()];
      await contract.write.deposit({ account: alice!.account, value: parseEther("0.1") });
      await contract.write.deposit({ account: bob!.account, value: parseEther("0.1") });
      const payee = "0x00000000000000000000000000000000000f3e58" as Address;

      const results = await Promise.all([
        a.withdraw({ depositor: alice!.account.address, amount: parseEther("0.01").toString(), destination: payee }),
        b.withdraw({ depositor: bob!.account.address, amount: parseEther("0.02").toString(), destination: payee }),
      ]);
      assert.equal(results.filter((r) => r.unresolved).length, 1, "one payout was refused by the node (nonce too low) and its charge waits on a hash that will never mine");
      assert.equal((await store.sentBatches()).length, 1, "the refused payout is left sent, for the next sweep to resolve as never-mined");
    } finally {
      await db.close();
    }
  });
});
