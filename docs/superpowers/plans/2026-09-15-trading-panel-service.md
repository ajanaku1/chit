# Trading panel, plan 1 of 3: the service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the fleet service five signed actions — `tokenQuote`, `order`, `trade`, `list`, `holdings` — so a browser can place a fleet buy as a seeded order and drive its slices to execution over time, with no state kept on the service.

**Architecture:** A pure planner (`order-plan.ts`) turns an order into a deterministic slice plan. A `MarketPort` (`market.ts`) wraps the read-only chain facts the panel needs: v4 pool price via PoolManager `extsload`, ERC20/ETH balances, and the escrow's `CampaignRegistered` events. `CampaignRouter` gains the five actions; `trade` executes only the due, still-pending slices through the existing pooled-buy path. Everything is injected through `RouterDeps`, so route tests use fakes and one fork test proves it on a live EVM.

**Tech Stack:** TypeScript (strict), viem, node:test, Hardhat fork of Robinhood testnet 46630 for the fork test.

**Spec:** `docs/superpowers/specs/2026-09-15-trading-panel-design.md`

## Global Constraints

- Test-first: commit each failing test before the code that makes it pass.
- At most 200 changed lines per commit (`git diff --cached --shortstat` before every commit).
- Never edit or delete an existing test. New tests go in new files: `test/fleet/order-plan.test.ts`, `test/fleet/market.test.ts`, `test/fleet/order-route.test.ts`, `test/fork/fleet-order.test.ts`.
- No new dependencies.
- No `Co-Authored-By`, `Claude-Session` or any Claude/Anthropic text in commit messages.
- Claims words: never "untraceable", "unlinkab…", "no trail"; "anonymous", "hidden trade", "mainnet" only beside a denial word.
- The browser never reads the chain directly; every fact here is served by the API. The service never returns the main wallet beside fleet activity.
- Commands: `npm run build:fleet && node --test dist-fleet/test/fleet/<file>.test.js` for a route test; `npm run build && node --test dist/test/fork/fleet-order.test.js` for the fork test (needs `npx hardhat node`? No: `network.connect({ network: "default" })` starts an in-process fork as the existing pool-fund test does).
- Existing action names are taken: `quote` is the CHIT fee quote. The token quote is `tokenQuote`.

---

### Task 1: The slice planner

**Files:**
- Create: `src/fleet/order-plan.ts`
- Test: `test/fleet/order-plan.test.ts`

**Interfaces:**
- Produces:
  - `export type Order = { id: Hex; campaign: string; token: Address; totalWei: Uint; wallets: Address[]; seed: Hex; windowMs: number; createdAt: string; owner: Address }`
  - `export type Slice = { index: number; wallet: Address; amountWei: Uint; dueAt: string }`
  - `export const orderId: (order: Omit<Order, "id">) => Hex` — keccak256 of the JSON of the fields in the order `campaign, token, totalWei, wallets, seed, windowMs, createdAt, owner`
  - `export const windowFor: (wallets: number) => number` — 5 min at 5 wallets, 30 min at 50, linear between, clamped
  - `export class PlanError extends Error { readonly code: string }`
  - `export const planSlices: (order: Omit<Order, "id">, capWei: Uint) => Slice[]`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { orderId, PlanError, planSlices, windowFor, type Order } from "../../src/fleet/order-plan.js";

const wallet = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;
const base: Omit<Order, "id"> = {
  campaign: "c-1",
  token: wallet(0x77),
  totalWei: "5000000000000000", // 0.005 ETH
  wallets: [1, 2, 3, 4, 5].map(wallet),
  seed: `0x${"ab".repeat(32)}`,
  windowMs: 5 * 60_000,
  createdAt: "2026-09-15T12:00:00.000Z",
  owner: wallet(0x99),
};
const CAP = "2000000000000000"; // 0.002 ETH per slice

test("slices sum to the total, one per wallet, each within the cap", () => {
  const slices = planSlices(base, CAP);
  assert.equal(slices.length, 5);
  assert.deepEqual(slices.map((s) => s.wallet), base.wallets);
  assert.equal(slices.reduce((sum, s) => sum + BigInt(s.amountWei), 0n).toString(), base.totalWei);
  for (const s of slices) assert.ok(BigInt(s.amountWei) <= BigInt(CAP), `slice ${s.index} over the cap`);
});

test("sizes vary around the average but never by more than 35%", () => {
  const average = BigInt(base.totalWei) / 5n;
  const sizes = planSlices(base, CAP).map((s) => BigInt(s.amountWei));
  assert.ok(new Set(sizes.map(String)).size > 1, "every slice is the same size");
  for (const size of sizes) {
    const diff = size > average ? size - average : average - size;
    assert.ok(diff * 100n <= average * 36n, `a slice drifts ${diff} from the average ${average}`);
  }
});

test("due times fall inside the window, in order", () => {
  const start = Date.parse(base.createdAt);
  const dues = planSlices(base, CAP).map((s) => Date.parse(s.dueAt));
  for (const due of dues) assert.ok(due >= start && due <= start + base.windowMs);
  assert.deepEqual(dues, [...dues].sort((a, b) => a - b));
});

test("the same order always plans the same slices; a different seed differs", () => {
  assert.deepEqual(planSlices(base, CAP), planSlices(base, CAP));
  const other = planSlices({ ...base, seed: `0x${"cd".repeat(32)}` }, CAP);
  assert.notDeepEqual(other.map((s) => s.amountWei), planSlices(base, CAP).map((s) => s.amountWei));
});

test("a total the cap cannot hold is refused, not silently shrunk", () => {
  assert.throws(() => planSlices({ ...base, totalWei: "20000000000000000" }, CAP), (e: unknown) => e instanceof PlanError && e.code === "over_cap");
  assert.throws(() => planSlices({ ...base, wallets: [] }, CAP), (e: unknown) => e instanceof PlanError && e.code === "no_wallets");
  assert.throws(() => planSlices({ ...base, totalWei: "0" }, CAP), (e: unknown) => e instanceof PlanError && e.code === "zero_total");
});

test("the window grows with the fleet, from five minutes to thirty", () => {
  assert.equal(windowFor(5), 5 * 60_000);
  assert.equal(windowFor(50), 30 * 60_000);
  assert.equal(windowFor(1), 5 * 60_000);
  assert.equal(windowFor(500), 30 * 60_000);
  assert.ok(windowFor(27) > 5 * 60_000 && windowFor(27) < 30 * 60_000);
});

test("the order id is a keccak of its fields, so a changed field is a different order", () => {
  const id = orderId(base);
  assert.match(id, /^0x[0-9a-f]{64}$/);
  assert.equal(orderId(base), id);
  assert.notEqual(orderId({ ...base, totalWei: "5000000000000001" }), id);
});
```

- [ ] **Step 2: Run it and confirm it fails; commit the red test.**

Run: `npm run build:fleet 2>&1 | tail -3` — expected: TypeScript fails because `order-plan.js` does not exist. Commit anyway:
`git add test/fleet/order-plan.test.ts && git commit -m "test(fleet): a seeded order plans the same slices every time, inside the cap and the window"`

- [ ] **Step 3: Write `src/fleet/order-plan.ts`**

```ts
/**
 * A fleet buy as an order: one token, a total, every wallet a slice.
 *
 * The plan is derived from the order's seed, so the browser that holds the
 * order and any service instance that receives it compute the same slices.
 * Sizes vary around the average and due times spread across a window the
 * trader does not choose, so no trader-specific rhythm is fingerprintable.
 */
import { keccak256, stringToHex, type Address, type Hex } from "viem";

import type { Uint } from "./types.js";

export type Order = {
  id: Hex;
  campaign: string;
  token: Address;
  totalWei: Uint;
  wallets: Address[];
  seed: Hex;
  windowMs: number;
  createdAt: string;
  owner: Address;
};

export type Slice = { index: number; wallet: Address; amountWei: Uint; dueAt: string };

export class PlanError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "PlanError";
    this.code = code;
  }
}

const MIN_WINDOW_MS = 5 * 60_000;
const MAX_WINDOW_MS = 30 * 60_000;
/** Each slice may sit this far from the average, as a share in basis points. */
const SPREAD_BPS = 3500n;

export const windowFor = (wallets: number): number => {
  const clamped = Math.min(50, Math.max(5, wallets));
  return Math.round(MIN_WINDOW_MS + ((clamped - 5) / 45) * (MAX_WINDOW_MS - MIN_WINDOW_MS));
};

export const orderId = (order: Omit<Order, "id">): Hex =>
  keccak256(
    stringToHex(
      JSON.stringify([order.campaign, order.token.toLowerCase(), order.totalWei, order.wallets.map((w) => w.toLowerCase()), order.seed, order.windowMs, order.createdAt, order.owner.toLowerCase()]),
    ),
  );

/** A stream of 32-byte words from the seed: word n is keccak(seed ‖ n). */
const draw = (seed: Hex, n: number): bigint => BigInt(keccak256(`${seed}${n.toString(16).padStart(8, "0")}` as Hex));

export const planSlices = (order: Omit<Order, "id">, capWei: Uint): Slice[] => {
  const total = BigInt(order.totalWei);
  const cap = BigInt(capWei);
  const count = order.wallets.length;
  if (count === 0) throw new PlanError("no_wallets");
  if (total <= 0n) throw new PlanError("zero_total");
  if (total > cap * BigInt(count)) throw new PlanError("over_cap");

  // Weights in [10000 - spread, 10000 + spread]; sizes follow the weights and
  // are then corrected so they sum to the total exactly.
  const weights = order.wallets.map((_, i) => 10_000n - SPREAD_BPS + (draw(order.seed, i) % (2n * SPREAD_BPS + 1n)));
  const weightSum = weights.reduce((a, b) => a + b, 0n);
  const sizes = weights.map((w) => (total * w) / weightSum);
  let remainder = total - sizes.reduce((a, b) => a + b, 0n);
  for (let i = 0; remainder > 0n; i = (i + 1) % count) {
    sizes[i] = sizes[i]! + 1n;
    remainder -= 1n;
  }
  // The correction is at most `count` wei, so the cap can only be crossed by
  // a total the check above already refused; clamp defensively anyway.
  for (let i = 0; i < count; i += 1) {
    if (sizes[i]! > cap) throw new PlanError("over_cap");
  }

  const start = Date.parse(order.createdAt);
  const dues = order.wallets.map((_, i) => start + Number(draw(order.seed, 1000 + i) % BigInt(order.windowMs + 1))).sort((a, b) => a - b);

  return order.wallets.map((wallet, index) => ({
    index,
    wallet,
    amountWei: sizes[index]!.toString(),
    dueAt: new Date(dues[index]!).toISOString(),
  }));
};
```

- [ ] **Step 4: Run the test; expect 7/7 pass.** `npm run build:fleet && node --test dist-fleet/test/fleet/order-plan.test.js`

- [ ] **Step 5: Commit.** `git add src/fleet/order-plan.ts && git commit -m "feat(fleet): plan a fleet buy's slices from the order's seed"`

---

### Task 2: The market port — pool price, balances, a wallet's fleets

**Files:**
- Create: `src/fleet/market.ts`
- Test: `test/fleet/market.test.ts` (pure parts only; the chain reads are proven in Task 7)

**Interfaces:**
- Produces:
  - `export type TokenQuote = { token: Address; symbol: string; decimals: number; hasPool: boolean; sqrtPriceX96: Uint; estimatedOut: Uint }`
  - `export type Holding = { wallet: Address; eth: Uint; tokens: Record<string, Uint> }`
  - `export type MarketPort = { tokenQuote(token: Address, amountInWei: Uint): Promise<TokenQuote>; holdings(wallets: readonly Address[], tokens: readonly Address[]): Promise<Holding[]>; campaignsOf(owner: Address): Promise<Hex[]> }`
  - `export const poolIdFor: (token: Address) => Hex` — keccak256 of the ABI-encoded venue PoolKey (currency0 = ETH, currency1 = token, fee 3000, spacing 60, no hooks)
  - `export const slot0Slot: (poolId: Hex) => Hex` — `keccak256(poolId ‖ POOLS_SLOT)` where `POOLS_SLOT = 6`, as v4-periphery's `StateLibrary`
  - `export const decodeSlot0: (word: Hex) => { sqrtPriceX96: bigint; tick: number }` — low 160 bits are sqrtPriceX96, next 24 bits the tick
  - `export const estimateOut: (amountIn: bigint, sqrtPriceX96: bigint) => bigint` — `amountIn * sqrtP² / 2^192` (ETH is currency0, so out is currency1)
  - `export const createMarket: (client: PublicClient, addresses: { poolManager: Address; escrow: Address; escrowFromBlock: bigint }) => MarketPort`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { decodeSlot0, estimateOut, poolIdFor, slot0Slot } from "../../src/fleet/market.js";
import { NATIVE_ETH, VENUE_POOL, venuePoolKey } from "../../src/fleet/v4-swap.js";

/** The seeded venue pool on 46630, from deployments/fleet-46630.json. */
const VENUE_TOKEN = "0x13283ab8e1f2bc4297e9ec6480c80c59674af554";
const VENUE_SQRT = 2505414483750479311864138015696n;

test("the pool id is the keccak of the venue key, with ETH as currency0", () => {
  const key = venuePoolKey(VENUE_TOKEN);
  assert.equal(key.currency0, NATIVE_ETH);
  assert.equal(key.fee, VENUE_POOL.fee);
  const id = poolIdFor(VENUE_TOKEN);
  assert.match(id, /^0x[0-9a-f]{64}$/);
  assert.notEqual(poolIdFor("0x0000000000000000000000000000000000000001"), id);
});

test("slot0 lives at keccak(poolId, 6), the StateLibrary layout", () => {
  const id = poolIdFor(VENUE_TOKEN);
  assert.match(slot0Slot(id), /^0x[0-9a-f]{64}$/);
  assert.notEqual(slot0Slot(id), id);
});

test("slot0 decodes the price from the low 160 bits and the tick above it", () => {
  const tick = 100n;
  const word = `0x${((tick << 160n) | VENUE_SQRT).toString(16).padStart(64, "0")}` as const;
  const decoded = decodeSlot0(word);
  assert.equal(decoded.sqrtPriceX96, VENUE_SQRT);
  assert.equal(decoded.tick, 100);
  const negative = `0x${(((1n << 24n) - 5n) << 160n | VENUE_SQRT).toString(16).padStart(64, "0")}` as const;
  assert.equal(decodeSlot0(negative).tick, -5);
});

test("an empty slot0 means no pool, and an estimate follows the square of the price", () => {
  assert.equal(decodeSlot0(`0x${"0".repeat(64)}`).sqrtPriceX96, 0n);
  const out = estimateOut(10n ** 15n, VENUE_SQRT);
  assert.ok(out > 0n);
  assert.equal(estimateOut(2n * 10n ** 15n, VENUE_SQRT), out * 2n);
  assert.equal(estimateOut(10n ** 15n, 0n), 0n);
});
```

- [ ] **Step 2: Build, confirm it fails on the missing module, commit red.** `git add test/fleet/market.test.ts && git commit -m "test(fleet): pool id, slot0 layout and price estimate for the venue pool"`

- [ ] **Step 3: Write `src/fleet/market.ts`**

```ts
/**
 * Read-only market facts for the trading panel, served by the API so the
 * browser never asks a public RPC about fleet wallets.
 *
 * The pool price is read straight from the PoolManager's storage: v4 exposes
 * `extsload`, and v4-periphery's StateLibrary fixes the pools mapping at slot 6
 * with slot0 as the first word of each pool's state.
 */
import { concatHex, encodeAbiParameters, keccak256, parseAbi, toHex, type Address, type Hex, type PublicClient } from "viem";

import type { Uint } from "./types.js";
import { venuePoolKey } from "./v4-swap.js";

export type TokenQuote = { token: Address; symbol: string; decimals: number; hasPool: boolean; sqrtPriceX96: Uint; estimatedOut: Uint };
export type Holding = { wallet: Address; eth: Uint; tokens: Record<string, Uint> };

export type MarketPort = {
  tokenQuote(token: Address, amountInWei: Uint): Promise<TokenQuote>;
  holdings(wallets: readonly Address[], tokens: readonly Address[]): Promise<Holding[]>;
  /** Campaign keys this owner registered on the escrow, oldest first. */
  campaignsOf(owner: Address): Promise<Hex[]>;
};

const POOLS_SLOT = 6n;
const POOL_KEY_ABI = [
  { type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" },
] as const;

export const poolIdFor = (token: Address): Hex => {
  const key = venuePoolKey(token);
  return keccak256(encodeAbiParameters(POOL_KEY_ABI, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
};

export const slot0Slot = (poolId: Hex): Hex => keccak256(concatHex([poolId, toHex(POOLS_SLOT, { size: 32 })]));

export const decodeSlot0 = (word: Hex): { sqrtPriceX96: bigint; tick: number } => {
  const value = BigInt(word);
  const sqrtPriceX96 = value & ((1n << 160n) - 1n);
  const rawTick = (value >> 160n) & ((1n << 24n) - 1n);
  const tick = rawTick >= 1n << 23n ? Number(rawTick - (1n << 24n)) : Number(rawTick);
  return { sqrtPriceX96, tick };
};

/** ETH is currency0, so amountOut ≈ amountIn · (sqrtP / 2^96)². Estimate only: no fee, no impact. */
export const estimateOut = (amountIn: bigint, sqrtPriceX96: bigint): bigint => (amountIn * sqrtPriceX96 * sqrtPriceX96) >> 192n;

const POOL_MANAGER_ABI = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const ESCROW_EVENTS = parseAbi(["event CampaignRegistered(bytes32 indexed campaign, address indexed owner)"]);

export const createMarket = (
  client: PublicClient,
  addresses: { poolManager: Address; escrow: Address; escrowFromBlock: bigint },
): MarketPort => ({
  async tokenQuote(token, amountInWei) {
    const [symbol, decimals, word] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
      client.readContract({ address: addresses.poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [slot0Slot(poolIdFor(token))] }),
    ]);
    const { sqrtPriceX96 } = decodeSlot0(word);
    return {
      token, symbol, decimals: Number(decimals), hasPool: sqrtPriceX96 > 0n,
      sqrtPriceX96: sqrtPriceX96.toString(),
      estimatedOut: estimateOut(BigInt(amountInWei), sqrtPriceX96).toString(),
    };
  },
  async holdings(wallets, tokens) {
    return Promise.all(wallets.map(async (wallet) => {
      const [eth, ...balances] = await Promise.all([
        client.getBalance({ address: wallet }),
        ...tokens.map((token) => client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] }).catch(() => 0n)),
      ]);
      const held: Record<string, Uint> = {};
      tokens.forEach((token, i) => { held[token.toLowerCase()] = (balances[i] ?? 0n).toString(); });
      return { wallet, eth: eth.toString(), tokens: held };
    }));
  },
  async campaignsOf(owner) {
    const logs = await client.getLogs({
      address: addresses.escrow, event: ESCROW_EVENTS[0], args: { owner }, fromBlock: addresses.escrowFromBlock, toBlock: "latest",
    });
    return logs.map((log) => log.args.campaign as Hex);
  },
});
```

- [ ] **Step 4: Build and run; expect 4/4.** `npm run build:fleet && node --test dist-fleet/test/fleet/market.test.js`

- [ ] **Step 5: Commit.** `git add src/fleet/market.ts && git commit -m "feat(fleet): market port — venue pool price from PoolManager storage, holdings, a wallet's campaigns"`

---

### Task 3: `tokenQuote` and `order` — signed reads that validate before anything is signed for real

**Files:**
- Modify: `src/fleet/campaign-routes.ts` (RouterDeps gets `market?: MarketPort`; dispatch gets the two actions; a new `#order` section near `#buy`)
- Test: `test/fleet/order-route.test.ts` (new; copy the `signed` helper, `policy`, `FakeChain` and `makeRouter` shapes from `test/fleet/buy-route.test.ts` — do not import from it)

**Interfaces:**
- Consumes: `planSlices`, `windowFor`, `orderId`, `PlanError` (Task 1); `MarketPort`, `TokenQuote` (Task 2); existing `#campaign`, `#session`, `#permitted`, `#syncEnrolled`, `#buyFromPool`, `#buyInMemory`.
- Produces: request/response shapes the browser relies on:
  - `tokenQuote` body `{ campaign, token, totalWei? }` → `{ ...TokenQuote, windowMs, capWei }`
  - `order` body `{ campaign, token, totalWei, wallets, seed, createdAt }` → `{ order: Order, slices: Slice[] }` or a `FleetValidationError` code: `invalid_token`, `no_pool`, `over_draw`, `over_cap`, `state_not_sponsorable:<state>`, `wallets_not_enrolled`

- [ ] **Step 1: Write the failing test.** Create `test/fleet/order-route.test.ts` with the fixture code from `buy-route.test.ts` (trader, serviceConfig, feeConfig, owner/salt helpers, TOKEN, ROUTER, policy(), FakeChain, `signed`) plus a fake market and a helper that creates + activates a campaign the way `buy-route.test.ts` does before its buys. Then:

```ts
class FakeMarket implements MarketPort {
  pools = new Map<string, bigint>([[TOKEN.toLowerCase(), 2505414483750479311864138015696n]]);
  async tokenQuote(token: Address, amountInWei: Uint) {
    const sqrt = this.pools.get(token.toLowerCase()) ?? 0n;
    return { token, symbol: sqrt ? "VEN" : "?", decimals: 18, hasPool: sqrt > 0n, sqrtPriceX96: sqrt.toString(), estimatedOut: ((BigInt(amountInWei) * sqrt * sqrt) >> 192n).toString() };
  }
  async holdings(wallets: readonly Address[]) { return wallets.map((wallet) => ({ wallet, eth: "0", tokens: {} })); }
  async campaignsOf() { return []; }
}

const SEED = `0x${"ab".repeat(32)}` as const;

test("tokenQuote says whether the token has a pool, and what the fleet may spend per slice", async () => {
  const { router, service, campaign, accounts } = await activeCampaign();
  const ok = await router.handle(await signed(service, "tokenQuote", { campaign, token: TOKEN, totalWei: "1000000000000000" }));
  assert.equal(ok.status, 200);
  const body = ok.body as Record<string, unknown>;
  assert.equal(body["hasPool"], true);
  assert.equal(body["symbol"], "VEN");
  assert.equal(body["capWei"], policy().maxTradeValue);
  assert.equal(body["windowMs"], 5 * 60_000);
  assert.ok(BigInt(String(body["estimatedOut"])) > 0n);
  const none = await router.handle(await signed(service, "tokenQuote", { campaign, token: owner(0x55), totalWei: "1" }));
  assert.equal((none.body as Record<string, unknown>)["hasPool"], false);
  assert.equal(accounts.length, 5);
});

test("order returns the plan without executing, and refuses what the fleet cannot do", async () => {
  const { router, service, campaign, accounts, chain } = await activeCampaign();
  const body = { campaign, token: TOKEN, totalWei: "1000000000000000", wallets: accounts, seed: SEED, createdAt: "2026-09-15T12:00:00.000Z" };
  const placed = await router.handle(await signed(service, "order", body));
  assert.equal(placed.status, 200);
  const result = placed.body as { order: { id: string; windowMs: number }; slices: { amountWei: string }[] };
  assert.match(result.order.id, /^0x[0-9a-f]{64}$/);
  assert.equal(result.slices.length, 5);
  assert.equal(chain.submissions.length, 0, "placing an order must not buy anything");

  const noPool = await router.handle(await signed(service, "order", { ...body, token: owner(0x55) }));
  assert.equal(noPool.status, 400);
  assert.equal((noPool.body as Record<string, unknown>)["code"], "no_pool");

  const overCap = await router.handle(await signed(service, "order", { ...body, totalWei: (BigInt(policy().maxTradeValue) * 5n + 1n).toString() }));
  assert.equal((overCap.body as Record<string, unknown>)["code"], "over_cap");

  const stranger = await router.handle(await signed(service, "order", { ...body, wallets: [owner(0xee)] }));
  assert.equal((stranger.body as Record<string, unknown>)["code"], "wallets_not_enrolled");
});
```

`activeCampaign()` must return `{ router, service, campaign, accounts, chain, market }` after create → confirmRecovery → fund → activate, exactly as `buy-route.test.ts` reaches an Active campaign (copy that sequence; pass `market: new FakeMarket()` in deps). `router.handle` is whatever public method `buy-route.test.ts` calls with a signed request; use the same one.

- [ ] **Step 2: Build, confirm the two tests fail (unknown action / missing dep), commit red.** `git add test/fleet/order-route.test.ts && git commit -m "test(fleet): tokenQuote and order validate a fleet buy before anything is signed"`

- [ ] **Step 3: Implement in `campaign-routes.ts`.**

Add to `RouterDeps` after `pool?`:
```ts
  /** Read-only market facts for the trading panel; absent means tokenQuote/order/holdings/list answer 503. */
  market?: MarketPort;
```
Import: `import { orderId, planSlices, PlanError, windowFor, type Order, type Slice } from "./order-plan.js";` and `import type { MarketPort } from "./market.js";`.

In `#dispatch`, after `if (action === "balance") return this.#balance(wallet);` add:
```ts
    if (action === "tokenQuote") return this.#tokenQuote(wallet, body);
    if (action === "order") return this.#order(wallet, body);
```
(They are signed reads: no idempotency key, no state change.)

Add the methods after `#buy`:
```ts
  #market(): MarketPort {
    const market = this.#deps.market;
    if (!market) throw new ServiceError("dependency_evidence_invalid", "market_unconfigured");
    return market;
  }

  /** The token's pool and price, with the per-slice cap and window this fleet would get. */
  async #tokenQuote(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    const token = String(body["token"] ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new FleetValidationError("invalid_token");
    const total = /^\d+$/.test(String(body["totalWei"] ?? "")) ? String(body["totalWei"]) : "0";
    const quote = await this.#market().tokenQuote(token as Address, total);
    return { status: 200, body: { ...quote, windowMs: windowFor(record.policy.accounts), capWei: record.policy.maxTradeValue } };
  }

  /** Validates an order and returns its plan. Nothing executes here. */
  async #order(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    const { order, slices } = await this.#validatedOrder(record, wallet as Address, body);
    return { status: 200, body: { order, slices } };
  }

  async #validatedOrder(record: CampaignRecord, owner: Address, body: Record<string, unknown>): Promise<{ order: Order; slices: Slice[] }> {
    if (!canSponsor(record.state)) throw new PolicyRejection(`state_not_sponsorable:${record.state}`);
    const token = String(body["token"] ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new FleetValidationError("invalid_token");
    const wallets = Array.isArray(body["wallets"]) ? (body["wallets"] as Address[]) : [];
    const seed = String(body["seed"] ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(seed)) throw new FleetValidationError("invalid_seed");
    const createdAt = String(body["createdAt"] ?? "");
    if (Number.isNaN(Date.parse(createdAt))) throw new FleetValidationError("invalid_created_at");
    const totalWei = String(body["totalWei"] ?? "");
    if (!/^\d+$/.test(totalWei)) throw new FleetValidationError("invalid_total");

    const enrolled = new Set((record.chainAccounts ?? this.#session(record).accounts).map((a) => a.toLowerCase()));
    if (wallets.length === 0 || wallets.some((w) => !enrolled.has(String(w).toLowerCase()))) throw new FleetValidationError("wallets_not_enrolled");

    const remaining = record.draw ? record.draw.remaining : this.#budget(record).unused;
    if (BigInt(totalWei) > BigInt(remaining)) throw new FleetValidationError("over_draw");

    const quote = await this.#market().tokenQuote(token as Address, totalWei);
    if (!quote.hasPool) throw new FleetValidationError("no_pool");

    const draft: Omit<Order, "id"> = { campaign: record.id, token: token as Address, totalWei, wallets, seed: seed as Hex, windowMs: Number(body["windowMs"] ?? windowFor(record.policy.accounts)), createdAt, owner };
    let slices: Slice[];
    try {
      slices = planSlices(draft, record.policy.maxTradeValue);
    } catch (error) {
      if (error instanceof PlanError) throw new FleetValidationError(error.code);
      throw error;
    }
    return { order: { ...draft, id: orderId(draft) }, slices };
  }
```
If `record.chainAccounts` does not exist on `CampaignRecord`, use whatever field `#syncEnrolled` fills with the fleet's enrolled accounts (read the type at the top of the file) and name it in your report. If `FleetValidationError` maps to HTTP 400 with `{ code }` in the existing error handler, nothing else is needed; confirm by reading `#handleError` or equivalent.

- [ ] **Step 4: Build and run; expect the two new tests to pass and `buy-route.test.js` unchanged.** `npm run build:fleet && node --test dist-fleet/test/fleet/order-route.test.js dist-fleet/test/fleet/buy-route.test.js`

- [ ] **Step 5: Commit (≤200 lines; split routes from test-fixture growth if needed).** `git add src/fleet/campaign-routes.ts && git commit -m "feat(fleet): tokenQuote and order — a fleet buy is validated and planned before it is signed"`

---

### Task 4: `trade` — execute the due, still-pending slices

**Files:**
- Modify: `src/fleet/campaign-routes.ts`
- Test: `test/fleet/order-route.test.ts` (append)

**Interfaces:**
- Consumes: `#validatedOrder` (Task 3), `#buyFromPool` / `#buyInMemory`, `#session`, `#now`.
- Produces: `trade` body `{ order: Order, pending: number[] }` → `{ executed: { index, wallet, amountWei, status, txHash?|userOpHash?, reason? }[], nextDueAt: string | null, draw? }`. Requires an idempotency key (it goes through `runIdempotent` like `buy`).

- [ ] **Step 1: Append the failing tests**

```ts
test("trade runs only the slices that are due and still pending, and reports the next due time", async () => {
  const now = { value: new Date("2026-09-15T12:00:00.000Z") };
  const { router, service, campaign, accounts, chain } = await activeCampaign({ now: () => now.value });
  const placed = await router.handle(await signed(service, "order", { campaign, token: TOKEN, totalWei: "1000000000000000", wallets: accounts, seed: SEED, createdAt: now.value.toISOString() }));
  const { order, slices } = placed.body as { order: Record<string, unknown>; slices: { dueAt: string }[] };
  const dues = slices.map((s) => Date.parse(s.dueAt)).sort((a, b) => a - b);

  // Just after the first due time: exactly the slices due by then run.
  now.value = new Date(dues[0]! + 1);
  const dueNow = dues.filter((d) => d <= now.value.getTime()).length;
  const first = await router.handle(await signed(service, "trade", { campaign, order, pending: [0, 1, 2, 3, 4] }), "key-1");
  assert.equal(first.status, 200);
  const r1 = first.body as { executed: { index: number; status: string }[]; nextDueAt: string | null };
  assert.equal(r1.executed.length, dueNow);
  assert.equal(chain.submissions.length, dueNow);
  assert.ok(r1.nextDueAt === null || Date.parse(r1.nextDueAt) > now.value.getTime());

  // Past the window, with the browser reporting what is still pending: the rest run once.
  now.value = new Date(dues[4]! + 1);
  const done = new Set(r1.executed.map((e) => e.index));
  const rest = await router.handle(await signed(service, "trade", { campaign, order, pending: [0, 1, 2, 3, 4].filter((i) => !done.has(i)) }), "key-2");
  const r2 = rest.body as { executed: { index: number }[]; nextDueAt: string | null };
  assert.equal(r2.executed.length + r1.executed.length, 5);
  assert.equal(r2.nextDueAt, null);
  assert.equal(chain.submissions.length, 5, "every slice bought exactly once");

  // A slice the browser already has is never re-run, even if asked twice in one instance.
  const again = await router.handle(await signed(service, "trade", { campaign, order, pending: [0] }), "key-3");
  assert.equal((again.body as { executed: unknown[] }).executed.length, 0);
  assert.equal(chain.submissions.length, 5);
});

test("trade refuses an order whose fields no longer hash to its id, or that another wallet placed", async () => {
  const now = new Date("2026-09-15T12:00:00.000Z");
  const { router, service, campaign, accounts } = await activeCampaign({ now: () => now });
  const placed = await router.handle(await signed(service, "order", { campaign, token: TOKEN, totalWei: "1000000000000000", wallets: accounts, seed: SEED, createdAt: now.toISOString() }));
  const { order } = placed.body as { order: Record<string, unknown> };
  const forged = await router.handle(await signed(service, "trade", { campaign, order: { ...order, totalWei: "9000000000000000" }, pending: [0] }), "key-9");
  assert.equal(forged.status, 400);
  assert.equal((forged.body as Record<string, unknown>)["code"], "order_tampered");
});
```

`activeCampaign(options)` must pass `options.now` into `RouterDeps.now`. `router.handle(request, idempotencyKey)` is the same call shape `buy-route.test.ts` uses for `buy`; match it.

- [ ] **Step 2: Build, confirm they fail (unknown action `trade`), commit red.** `git add test/fleet/order-route.test.ts && git commit -m "test(fleet): trade executes due pending slices once and refuses a tampered order"`

- [ ] **Step 3: Implement.** In the `runIdempotent` switch add `case "trade": return this.#trade(wallet, body);`. Add a per-instance guard field to the class: `readonly #executedSlices = new Set<string>();`. Then:

```ts
  /**
   * Executes the slices of a browser-held order that are due and that the
   * browser still reports pending. The plan is recomputed from the order, so
   * any instance agrees on it; the per-instance guard stops a double-poll from
   * running one slice twice, and the browser's pending list stops the rest.
   */
  async #trade(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    const given = asRecord(body["order"]);
    const { order, slices } = await this.#validatedOrder(record, wallet as Address, { ...given, campaign: record.id });
    if (String(given["id"] ?? "").toLowerCase() !== order.id.toLowerCase() || String(given["owner"] ?? "").toLowerCase() !== wallet.toLowerCase()) {
      throw new FleetValidationError("order_tampered");
    }
    const pending = new Set((Array.isArray(body["pending"]) ? (body["pending"] as unknown[]) : []).map(Number));
    const now = this.#now();
    const due = slices.filter((s) => pending.has(s.index) && Date.parse(s.dueAt) <= now.getTime() && !this.#executedSlices.has(`${order.id}|${s.index}`));
    for (const slice of due) this.#executedSlices.add(`${order.id}|${slice.index}`);

    const { submitter, chain } = this.#deps;
    if (!submitter && !chain) throw new ServiceError("dependency_evidence_invalid", "submitter_unconfigured");
    if (chain) await this.#syncEnrolled(record, chain, due.map((s) => s.wallet));
    const session = this.#session(record);
    const executed: Record<string, unknown>[] = [];
    for (const slice of due) {
      // One slice at a time: sizes differ per wallet, and the pooled path takes one value per call.
      const results = this.#deps.pool && record.draw
        ? await this.#buyFromPool(record, session, [slice.wallet], order.token, slice.amountWei, now, wallet)
        : chain
          ? await this.#buyOnChain(record, session, chain, [slice.wallet], order.token, slice.amountWei, now)
          : await this.#buyInMemory(record, session, submitter!, [slice.wallet], order.token, slice.amountWei, now);
      const result = results[0] ?? { status: "rejected", reason: "no_result" };
      if (result["status"] !== "sponsored") this.#executedSlices.delete(`${order.id}|${slice.index}`);
      executed.push({ index: slice.index, wallet: slice.wallet, amountWei: slice.amountWei, ...result });
    }
    const later = slices.filter((s) => pending.has(s.index) && !executed.some((e) => e["index"] === s.index)).map((s) => Date.parse(s.dueAt)).filter((t) => t > now.getTime());
    return { status: 200, body: { executed, nextDueAt: later.length ? new Date(Math.min(...later)).toISOString() : null, draw: record.draw } };
  }
```
A rejected slice is released from the guard so the browser may retry it on the next poll; a sponsored one stays guarded for this instance's life.

- [ ] **Step 4: Build and run; expect all order-route and buy-route tests to pass.**

- [ ] **Step 5: Commit.** `git add src/fleet/campaign-routes.ts && git commit -m "feat(fleet): trade — the due, still-pending slices of a browser-held order run once each"`

---

### Task 5: `list` and `holdings`

**Files:**
- Modify: `src/fleet/campaign-routes.ts`
- Test: `test/fleet/order-route.test.ts` (append)

**Interfaces:**
- Produces:
  - `list` body `{}` → `{ fleets: { campaign: string; state: string; remaining: Uint; accounts: number }[] }` — every campaign whose escrow owner is this wallet, from `market.campaignsOf(wallet)`, each restored through the existing `#restore(id, wallet)` (skip ones it cannot restore).
  - `holdings` body `{ campaign, tokens: Address[] }` → `{ holdings: Holding[] }` for the campaign's enrolled accounts.

- [ ] **Step 1: Append the failing tests**

```ts
test("list returns the fleets this wallet registered, and nothing for a stranger", async () => {
  const { router, service, campaign, market } = await activeCampaign();
  market.registered.set(trader.address.toLowerCase(), [campaignKey(campaign)]);
  const mine = await router.handle(await signed(service, "list", {}));
  assert.equal(mine.status, 200);
  const fleets = (mine.body as { fleets: { campaign: string; state: string }[] }).fleets;
  assert.equal(fleets.length, 1);
  assert.equal(fleets[0]!.campaign, campaign);
  assert.equal(fleets[0]!.state, "Active");
});

test("holdings reports each fleet wallet's ETH and the tokens the browser asks about", async () => {
  const { router, service, campaign, accounts } = await activeCampaign();
  const res = await router.handle(await signed(service, "holdings", { campaign, tokens: [TOKEN] }));
  assert.equal(res.status, 200);
  const holdings = (res.body as { holdings: { wallet: string; tokens: Record<string, string> }[] }).holdings;
  assert.equal(holdings.length, accounts.length);
  assert.ok(TOKEN.toLowerCase() in holdings[0]!.tokens);
});
```
Extend `FakeMarket` with `registered = new Map<string, Hex[]>()` and `campaignsOf(owner) { return this.registered.get(owner.toLowerCase()) ?? []; }`. `campaignKey` is exported from `src/fleet/chain-service.js`; if `list` maps keys back to ids differently in `#restore`, read `#restore` and `restoredRecord` to see what id `list` should hand it (a campaign key is `campaignKey(id)`; `#restore` takes the id — if there is no inverse, `list` returns the key as the id the way `#restore` expects, and the test asserts on that same value).

- [ ] **Step 2: Build, confirm failure, commit red.** `git add test/fleet/order-route.test.ts && git commit -m "test(fleet): list a wallet's fleets and read their holdings through the API"`

- [ ] **Step 3: Implement.** In `#dispatch` beside the other signed reads: `if (action === "list") return this.#list(wallet);` and `if (action === "holdings") return this.#holdings(wallet, body);`.

```ts
  /** The fleets this wallet registered on the escrow, in the state the chain gives them now. */
  async #list(wallet: string): Promise<RouterResult> {
    const keys = await this.#market().campaignsOf(wallet as Address);
    const fleets: Record<string, unknown>[] = [];
    for (const key of keys) {
      const id = this.#idForKey(key);
      const record = this.#campaigns.get(id) ?? (await this.#restore(id, wallet));
      if (!record) continue;
      await this.#syncDraw(record);
      fleets.push({ campaign: record.id, state: record.state, remaining: record.draw ? record.draw.remaining : this.#budget(record).unused, accounts: (record.chainAccounts ?? []).length });
    }
    return { status: 200, body: { fleets } };
  }

  async #holdings(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    const tokens = (Array.isArray(body["tokens"]) ? (body["tokens"] as string[]) : []).filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t)) as Address[];
    const accounts = record.chainAccounts ?? this.#session(record).accounts;
    return { status: 200, body: { holdings: await this.#market().holdings(accounts, tokens) } };
  }
```
`#idForKey`: read how `campaignKey(id)` derives the key. If ids are already the key (hex) or the key is `keccak256(id)` with the id recoverable from the record only, keep an in-memory `Map<key, id>` filled wherever records are created/restored, and fall back to the key itself as the id (the `#restore` path accepts it if `campaignKey` is idempotent on hex keys). State what you found in the report.

- [ ] **Step 4: Build and run; all order-route tests pass.**

- [ ] **Step 5: Commit.** `git add src/fleet/campaign-routes.ts && git commit -m "feat(fleet): list a wallet's fleets and read their holdings through the API"`

---

### Task 6: Wire the market into the runtime and expose the actions

**Files:**
- Modify: `src/fleet/service-runtime.ts`, `api/fleet/campaign.js`, `api/fleet/buy.js`
- Create: `api/fleet/trade.js`
- Test: `test/fleet/order-route.test.ts` (append one dispatch test using the runtime's allow-list if a unit seam exists; otherwise this task is covered by Task 7's fork test and the app tests in plan 2 — state which)

- [ ] **Step 1: Runtime.** In `service-runtime.ts` add beside `poolFromEnv`:

```ts
const marketFromEnv = (): MarketPort | undefined => {
  const key = operatorKeyFromEnv();
  if (!key) return undefined;
  const poolManager = process.env.FLEET_POOL_MANAGER_ADDRESS || DEPLOYED_46630.poolManager;
  const escrow = process.env.FLEET_ESCROW_ADDRESS || DEPLOYED_46630.escrow;
  if (!isAddress(poolManager) || !isAddress(escrow)) return undefined;
  const { publicClient } = clients(key);
  return createMarket(publicClient, { poolManager, escrow, escrowFromBlock: DEPLOYED_46630.escrowBlock });
};
```
Add `market: marketFromEnv(),` to the `deps` object. `DEPLOYED_46630` must gain `poolManager` (`deployments/fleet-46630.json` → `venue.poolManager` = `0x8366a39cc670b4001a1121b8f6a443a643e40951`) and `escrowBlock` (the block of `campaignEscrowTx`; read it once with `cast`/viem or the explorer and hardcode it with a comment naming the tx). Read how `DEPLOYED_46630` is built (from the JSON or a literal) and extend it the same way.

- [ ] **Step 2: API files.** `api/fleet/campaign.js` allow-list gains `"tokenQuote", "order", "list", "holdings"`. Create `api/fleet/trade.js`:
```js
import { handleFleetRequest } from "../../dist/src/fleet/service-runtime.js";

export function POST(request) {
  return handleFleetRequest(request, ["trade"]);
}
```
Check `vercel.json`/`scripts/serve-local.mjs` for how `api/fleet/*.js` are routed locally (the local server maps `/api/fleet/<name>`); if it needs a list, add `trade`.

- [ ] **Step 3: `npm run build && npm --prefix app run verify`** — both green (the app is untouched, this confirms nothing broke).

- [ ] **Step 4: Commit.** `git add src/fleet/service-runtime.ts api/fleet && git commit -m "feat(fleet): serve tokenQuote, order, trade, list and holdings; market wired from the deployment"`

---

### Task 7: Fork test — one order, five slices, two `trade` calls, every slice once

**Files:**
- Create: `test/fork/fleet-order.test.ts`
- Modify: `verify.sh` (add the `fleet-trade` gate after `pool-fund`)

- [ ] **Step 1: Write the test**, modelled on `test/fork/fleet-pool-fund.test.ts`: same `network.connect`, `travel`, and `setup()` that deploys the pool, seeds the venue token via the same path that test uses, funds a depositor, creates + activates a campaign with a draw, and travels past funding. Then:

```ts
  it("executes a seeded order over two polls, every slice exactly once", async () => {
    const s = await setup();
    const market = createMarket(s.publicClient, { poolManager: s.poolManager, escrow: s.escrow, escrowFromBlock: 0n });
    const router = new CampaignRouter({ ...s.deps, market, now: () => s.clock() });
    const quote = await router.handle(await s.signed("tokenQuote", { campaign: s.campaign, token: s.venueToken, totalWei: "1000000000000000" }));
    assert.equal((quote.body as { hasPool: boolean }).hasPool, true);

    const placed = await router.handle(await s.signed("order", { campaign: s.campaign, token: s.venueToken, totalWei: "1000000000000000", wallets: s.accounts, seed: `0x${"ab".repeat(32)}`, createdAt: s.clock().toISOString() }));
    const { order, slices } = placed.body as { order: Record<string, unknown>; slices: { index: number; dueAt: string }[] };

    await travel(Math.ceil((Date.parse(slices[2]!.dueAt) - s.clock().getTime()) / 1000) + 1);
    const first = await router.handle(await s.signed("trade", { campaign: s.campaign, order, pending: slices.map((x) => x.index) }), "fork-1");
    const done1 = (first.body as { executed: { index: number; status: string }[] }).executed;
    assert.ok(done1.length >= 3 && done1.every((e) => e.status === "sponsored"));

    await travel(31 * 60);
    const second = await router.handle(await s.signed("trade", { campaign: s.campaign, order, pending: slices.map((x) => x.index).filter((i) => !done1.some((e) => e.index === i)) }), "fork-2");
    const done2 = (second.body as { executed: { index: number }[] }).executed;
    assert.equal(done1.length + done2.length, 5);

    const held = await market.holdings(s.accounts, [s.venueToken]);
    for (const h of held) assert.ok(BigInt(h.tokens[s.venueToken.toLowerCase()]!) > 0n, `${h.wallet} bought nothing`);
    const fleets = await router.handle(await s.signed("list", {}));
    assert.equal((fleets.body as { fleets: unknown[] }).fleets.length, 1);
  });
```
`s.clock()` must be a Date derived from the fork's latest block timestamp (read `publicClient.getBlock()`), so `travel` and `now` agree. Everything else (`s.deps`, `s.signed`, `s.accounts`, `s.venueToken`, `s.poolManager`, `s.escrow`) comes from the same setup the pool-fund test builds; read that test and reuse its helpers by copying, not importing.

- [ ] **Step 2: Run it red** (`npm run build && node --test dist/test/fork/fleet-order.test.js`), commit the test.

- [ ] **Step 3: Make it pass.** Expect fixes in the market's `getLogs` range or the slot0 read against the local PoolManager. Fix at the cause.

- [ ] **Step 4: Gate.** In `verify.sh` after the `pool-fund` block:
```sh
checksh fleet-trade "A seeded fleet order runs over two polls, every slice once; quote, list and holdings answer" \
  'test -f test/fleet/order-plan.test.ts && test -f test/fleet/market.test.ts && test -f test/fleet/order-route.test.ts && test -f test/fork/fleet-order.test.ts && test -f api/fleet/trade.js && npm run build:fleet && node --test dist-fleet/test/fleet/order-plan.test.js dist-fleet/test/fleet/market.test.js dist-fleet/test/fleet/order-route.test.js && npm run build && node --test dist/test/fork/fleet-order.test.js'
```
Run `./verify.sh fleet-trade` → PASS. Also `./verify.sh fleet-buy pool-fund pool-balance fleet-acceptance` → PASS.

- [ ] **Step 5: Commit.** `git add test/fork/fleet-order.test.ts verify.sh && git commit -m "test(fork): a seeded fleet order runs over two polls, every slice once; fleet-trade gate"`

---

### Task 8: Log it

**Files:**
- Modify: `IMPLEMENTATION.md` (append)

- [ ] **Step 1: Append**

```markdown
## Trading panel, plan 1: fleet buys as browser-held orders (2026-09-15)

Design: `docs/superpowers/specs/2026-09-15-trading-panel-design.md`. The service
gains five signed actions. `tokenQuote` reads a token's venue pool price straight
from the PoolManager's storage (`extsload`, StateLibrary's slot 6) with its symbol
and decimals. `order` validates a fleet buy (token has a pool, total within the
fleet's remaining draw, every slice within the session's trade cap, wallets
enrolled) and returns a plan: one slice per wallet, sizes within ±35% of the
average, due times spread across a window that grows from five minutes at five
wallets to thirty at fifty, all derived from a seed the browser chose. `trade`
executes the due, still-pending slices of an order the browser holds and re-sends,
through the same pooled-buy path a plain buy uses, one slice at a time. `list`
returns the fleets an owner registered, from the escrow's own events; `holdings`
reads each fleet wallet's ETH and the tokens the browser asks about.

Two things the user approved were changed by the code. Sells are out: the on-chain
`FleetSessionPolicy` allows one router and one selector per fleet, and a sell needs
a token approval first, so selling waits for a policy change and a redeploy. And
orders live in the browser, not on the service: the fleet path keeps no state
between requests, so the order is signed once, kept by the browser, and driven by
the open page the way funding already is. Its plan is reproducible from the seed;
a per-instance guard and the browser's own pending list keep a slice from running
twice. The `fleet-trade` gate runs a five-slice order on a fork over two polls.
```

- [ ] **Step 2: Commit.** `git add IMPLEMENTATION.md && git commit -m "docs: log the trading panel's service plan"`

- [ ] **Step 3: Rebase on `origin/main`, re-run `npm --prefix app run verify`, `(cd landing && npm run verify)`, `./verify.sh fleet-acceptance fleet-buy pool-balance pool-fund fleet-trade`, and push when green** (the user has delegated shipping; no PR needed; no attribution).
