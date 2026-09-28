/**
 * Selling a fleet's tokens through the operator (docs/design-sell.md), against
 * a scripted chain. What is pinned: a transfer counts only when the chain shows
 * it, from an enrolled account, to the operator, and only once ever; the payout
 * never goes to the depositor's own wallet; a sale sells inside the bound or
 * not at all, and after three misses sends the tokens to the payout wallet;
 * every send is recorded before it leaves; the payout waits 10 to 30 minutes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OWNER_GAS_WEI, advancePending, advanceSale, openSale, topUpOwners, type SellChain, type SellDeps } from "../../src/fleet/sell.js";
import { createMemoryStore } from "../../src/fleet/store.js";
import type { TokenRegistry } from "../../src/fleet/token-registry.js";
import type { WriteOutcome } from "../../src/fleet/chain-pool.js";
import type { Address, Hex } from "../../src/fleet/types.js";

const OPERATOR = `0x${"0e".repeat(20)}` as Address;
const ROUTER = `0x${"88".repeat(20)}` as Address;
const OWNER = `0x${"ab".repeat(20)}` as Address;
const PAYOUT = `0x${"ef".repeat(20)}` as Address;
const TOKEN = `0x${"cd".repeat(20)}` as Address;
const ACCOUNT = `0x${"a1".repeat(20)}` as Address;
const CAMPAIGN = `0x${"01".repeat(32)}` as Hex;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const registry: TokenRegistry = { chainId: 4663, tokens: [{
  token: TOKEN, symbol: "HEY", decimals: 18, poolId: hash(9), slippageBps: 400, enabled: true,
  poolKey: { currency0: "0x0000000000000000000000000000000000000000", currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: `0x${"44".repeat(20)}` },
}] };

type Sent = { to: Address; data?: Hex; value?: bigint; hash: Hex };

/** A chain that shows the transfers it is given, quotes `quote`, and answers each send with the next outcome. */
const chainOf = (over: { transfers?: Record<string, { from: Address; to: Address; amount: bigint; token?: Address }>; outcomes?: WriteOutcome["status"][]; quote?: bigint; received?: bigint; balances?: Record<string, bigint> } = {}) => {
  const sent: Sent[] = [];
  const recorded: Hex[] = [];
  const outcomes = [...(over.outcomes ?? [])];
  let n = 100;
  const chain: SellChain = {
    async transfersIn(h) {
      const t = over.transfers?.[h];
      return t ? { mined: true, transfers: [{ token: t.token ?? TOKEN, from: t.from, to: t.to, amount: t.amount }] } : { mined: false, transfers: [] };
    },
    async enrolled(_campaign, account) { return account.toLowerCase() === ACCOUNT.toLowerCase(); },
    async sellQuote() { return over.quote ?? 1_000n; },
    async send(step) {
      const h = hash(n++);
      await step.record(h, n);
      recorded.push(h);
      sent.push({ to: step.to, ...(step.data ? { data: step.data } : {}), ...(step.value !== undefined ? { value: step.value } : {}), hash: h });
      const status = outcomes.shift() ?? "mined";
      return status === "mined" ? { status, hash: h } : status === "reverted" ? { status, hash: h } : { status, hash: h, nonce: n };
    },
    async resolve(h) { return { status: "mined", hash: h }; },
    async ethReceived() { return over.received ?? 980n; },
    async balance(address) { return over.balances?.[address.toLowerCase()] ?? 0n; },
  };
  return { chain, sent, recorded };
};

const depsOf = (chain: SellChain, at = { t: 1_000_000 }): SellDeps => ({
  store: createMemoryStore(), operator: OPERATOR, router: ROUTER, registry, chain, now: () => at.t, random: () => 0.5,
});

const good = { [hash(1)]: { from: ACCOUNT, to: OPERATOR, amount: 5_000n } };
const request = (over: Partial<Parameters<typeof openSale>[1]> = {}) => ({ campaign: CAMPAIGN, owner: OWNER, token: TOKEN, payout: PAYOUT, transfers: [hash(1)], ...over });

describe("opening a sale", () => {
  it("counts a transfer the chain shows, from an enrolled account to the operator", async () => {
    const deps = depsOf(chainOf({ transfers: good }).chain);
    const sale = await openSale(deps, request());
    assert.equal(sale.amountIn, "5000");
    assert.equal(sale.state, "awaiting");
    assert.deepEqual(await deps.store.sales.get(sale.id), sale);
  });

  it("refuses the depositor's own wallet as the payout wallet, whatever its case", async () => {
    const deps = depsOf(chainOf({ transfers: good }).chain);
    await assert.rejects(openSale(deps, request({ payout: OWNER.toUpperCase().replace("0X", "0x") as Address })), /payout_is_main_wallet/);
  });

  it("counts nothing the chain does not show as ours: unmined, another token, not to the operator, not enrolled", async () => {
    const bad = {
      [hash(2)]: { from: ACCOUNT, to: OPERATOR, amount: 1n, token: `0x${"99".repeat(20)}` as Address },
      [hash(3)]: { from: ACCOUNT, to: PAYOUT, amount: 1n },
      [hash(4)]: { from: `0x${"bb".repeat(20)}` as Address, to: OPERATOR, amount: 1n },
    };
    const deps = depsOf(chainOf({ transfers: bad }).chain);
    for (const h of [hash(1), hash(2), hash(3), hash(4)]) {
      await assert.rejects(openSale(deps, request({ transfers: [h] })), /no_transfer_counted/, h);
    }
  });

  it("counts a transfer once ever: a second sale naming it is refused", async () => {
    const deps = depsOf(chainOf({ transfers: good }).chain);
    await openSale(deps, request());
    await assert.rejects(openSale(deps, request()), /no_transfer_counted/);
  });

  it("refuses a token the registry does not list", async () => {
    const deps = depsOf(chainOf({ transfers: good }).chain);
    await assert.rejects(openSale(deps, request({ token: `0x${"99".repeat(20)}` as Address })), /token_not_listed/);
  });
});

describe("advancing a sale", () => {
  it("approves exactly the amount, sells inside the bound, and owes what the operator received", async () => {
    const { chain, sent, recorded } = chainOf({ transfers: good, quote: 1_000n, received: 980n });
    const at = { t: 1_000_000 };
    const deps = depsOf(chain, at);
    const opened = await openSale(deps, request());
    const sold = await advanceSale(deps, opened);
    assert.equal(sold.state, "sold");
    assert.equal(sold.ethOut, "980");
    assert.equal(sent.length, 3, "two approvals and the swap");
    assert.equal(sent[2]!.to, ROUTER);
    assert.equal((await deps.store.sales.get(sold.id))?.saleTx, sent[2]!.hash, "the swap's hash was recorded before it left");
    assert.deepEqual(recorded, sent.map((s) => s.hash));
    assert.ok(sold.payoutDueAt! >= at.t + 10 * 60_000 && sold.payoutDueAt! <= at.t + 30 * 60_000, "the payout waits 10 to 30 minutes");
    assert.equal(await deps.store.sales.proceedsOwed(), "980");
  });

  it("pays the payout wallet only once the wait is over, and then owes nothing", async () => {
    const { chain, sent } = chainOf({ transfers: good });
    const at = { t: 1_000_000 };
    const deps = depsOf(chain, at);
    const sold = await advanceSale(deps, await openSale(deps, request()));
    const early = await advanceSale(deps, sold);
    assert.equal(early.state, "sold", "not before its time");
    at.t = sold.payoutDueAt!;
    const paid = await advanceSale(deps, early);
    assert.equal(paid.state, "paid");
    assert.deepEqual({ to: sent.at(-1)!.to, value: sent.at(-1)!.value }, { to: PAYOUT, value: 980n });
    assert.equal(await deps.store.sales.proceedsOwed(), "0");
  });

  it("after three swaps that do not fill, sends the tokens to the payout wallet instead", async () => {
    const { chain, sent } = chainOf({ transfers: good, outcomes: ["mined", "mined", "reverted", "mined", "mined", "reverted", "mined", "mined", "reverted", "mined"] });
    const deps = depsOf(chain);
    let sale = await openSale(deps, request());
    for (let i = 0; i < 3; i += 1) sale = await advanceSale(deps, sale);
    assert.equal(sale.state, "awaiting");
    assert.equal(sale.attempts, 3);
    sale = await advanceSale(deps, sale);
    assert.equal(sale.state, "returned");
    assert.equal(sent.at(-1)!.to, TOKEN, "a transfer on the token itself");
    assert.ok(sent.at(-1)!.data!.includes(PAYOUT.slice(2).toLowerCase()), "to the payout wallet");
    assert.equal(await deps.store.sales.proceedsOwed(), "0");
  });

  it("never sells with no quote: a zero quote is a miss, not a market order", async () => {
    const { chain, sent } = chainOf({ transfers: good, quote: 0n });
    const deps = depsOf(chain);
    const sale = await advanceSale(deps, await openSale(deps, request()));
    assert.equal(sale.attempts, 1);
    assert.equal(sent.length, 0);
  });

  it("resumes a swap whose outcome was never seen by its recorded hash, and never sends it twice", async () => {
    const { chain, sent } = chainOf({ transfers: good, outcomes: ["mined", "mined", "unknown"] });
    const deps = depsOf(chain);
    const pending = await advanceSale(deps, await openSale(deps, request()));
    assert.equal(pending.state, "awaiting");
    assert.ok(pending.saleTx, "the hash is kept");
    const resumed = await advanceSale(deps, pending);
    assert.equal(resumed.state, "sold", "the receipt decided it");
    assert.equal(sent.length, 3, "nothing sent again");
  });
});

describe("sweeping sales", () => {
  it("advances each pending sale once even when two sweeps run together", async () => {
    const { chain, sent } = chainOf({ transfers: good });
    const deps = depsOf(chain);
    await openSale(deps, request());
    await Promise.all([advancePending(deps), advancePending(deps)]);
    assert.equal(sent.filter((s) => s.to === ROUTER).length, 1, "one swap, not two");
    assert.equal((await deps.store.sales.pending())[0]?.state, "sold");
  });

  it("keeps sweeping past a sale that throws, and says so", async () => {
    const { chain } = chainOf({ transfers: good });
    const said: string[] = [];
    const deps: SellDeps = { ...depsOf(chain), alert: async (s) => { said.push(s); } };
    await openSale(deps, request());
    await deps.store.sales.put({ ...(await deps.store.sales.pending())[0]!, id: "broken", token: `0x${"99".repeat(20)}` as Address });
    const done = await advancePending(deps);
    assert.equal(done.length, 1, "the good sale still advanced");
    assert.match(said.join("\n"), /broken could not advance/);
  });
});

describe("what a sale owes", () => {
  it("is what the operator received, but never more than the quote the swap was sent against", async () => {
    const { chain } = chainOf({ transfers: good, quote: 1_000n, received: 5_000n });
    const deps = depsOf(chain);
    const sold = await advanceSale(deps, await openSale(deps, request()));
    assert.equal(sold.ethOut, "1000", "an unrelated inflow in the swap's block is not the depositor's");
  });
});

describe("gas for the owner keys", () => {
  it("tops each key up to what one transfer needs, and sends nothing to a key that already has it", async () => {
    const low = `0x${"c1".repeat(20)}` as Address;
    const full = `0x${"c2".repeat(20)}` as Address;
    const { chain, sent } = chainOf({ balances: { [low]: 5n, [full]: OWNER_GAS_WEI } });
    const topped = await topUpOwners(depsOf(chain), [low, full]);
    assert.deepEqual(topped, [low]);
    assert.deepEqual(sent.map((s) => ({ to: s.to, value: s.value })), [{ to: low, value: OWNER_GAS_WEI - 5n }]);
  });
});

describe("settling a swap whose block the RPC no longer keeps", () => {
  it("measures the swap at send time, inside the lock, when the chain can, and never asks for history", async () => {
    const { chain } = chainOf({ transfers: good, quote: 1_000n });
    let historical = 0;
    const deps = depsOf({
      ...chain,
      async ethReceived() { historical += 1; throw new Error("historical state is not available"); },
      async swap(step) { const outcome = await chain.send(step); return { outcome, received: 990n }; },
    });
    const sold = await advanceSale(deps, await openSale(deps, request()));
    assert.equal(sold.state, "sold");
    assert.equal(sold.ethOut, "990");
    assert.equal(historical, 0, "no read of an old block");
  });

  it("pays the guaranteed minimum and says so when a late swap's block is gone, rather than staying stuck", async () => {
    const said: string[] = [];
    const { chain } = chainOf({ transfers: good, quote: 1_000n, outcomes: ["mined", "mined", "unknown"] });
    const deps: SellDeps = { ...depsOf({ ...chain, async ethReceived() { throw new Error("historical state is not available"); } }), alert: async (s) => { said.push(s); } };
    const pending = await advanceSale(deps, await openSale(deps, request()));
    assert.equal(pending.state, "awaiting", "the swap's outcome was not seen at send time");
    const settled = await advanceSale(deps, pending);
    assert.equal(settled.state, "sold", "resolved later, it still settles");
    assert.equal(settled.ethOut, "960", "the least the swap could have returned: the quote less the 4% bound");
    assert.match(said.join("\n"), /minimum/, "and the difference is flagged for a person");
  });
});
