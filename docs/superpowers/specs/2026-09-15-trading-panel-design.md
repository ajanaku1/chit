# Trading panel and Control Room, step 1: fleet buys as orders (approved design)

Approved in dialogue on 2026-09-15. The user chose the shape (fleet buy: one token, all
wallets; Chit decides the stagger; paste-an-address token choice; a fleet list) and then
delegated the rest to the technical lead. Two of the user's choices are amended here for
reasons found in the code, and both amendments are called out.

## Why

The Control Room can pause, resume, revoke, close and top up one fleet, and its "Run one
buy per wallet" button sends a placeholder token (`0x0`) and value `0`. The swap machinery
underneath is real: `src/fleet/v4-swap.ts` encodes an exact-in ETH → token swap through one
Uniswap v4 pool, gas sponsored by the operator, token paid from the fleet wallet's own ETH.
Nothing lets a trader choose a token or an amount, spread buys over time, see progress, or
switch between fleets. This step turns that plumbing into a trading panel.

## Facts that bind the design

1. **One approved operation per fleet, enforced on chain.** `FleetSessionPolicy.check` allows
   one router and one selector per campaign, and `FleetAccountFactory.execute` calls it on
   every call. A sell needs the fleet wallet to call `approve` on the token first; the policy
   refuses that target. **Amendment 1: sells are out of this step.** They need a policy
   contract change (a second approved operation, or Permit2 pre-approval at account
   creation), a redeploy, and the user's go. Recorded under "Later".
2. **The service holds no state between requests.** Campaign records are an in-memory map
   restored from chain; draws, funding and reservations are read from the pool and escrow
   contracts; there is no database in the fleet path. **Amendment 2: orders are not stored on
   the service.** The trader signs an order once; the browser keeps it; the open page drives
   execution, exactly as it drives funding today ("the trader's open page is what funds a
   fleet"). The slice plan is derived from a seed inside the order, so any instance
   reproduces it, and each slice's reservation key is checked on chain, so no slice runs twice.
3. **One request, bounded time.** Vercel functions must answer within the request. A request
   executes only the slices that are due, never the whole order.
4. **Trades are public; the funding link is private.** The browser never asks a public or
   wallet RPC anything about fleet wallets. Every fleet read goes through Chit's signed API,
   and the operator already holds the wallet → fleet mapping. The panel never shows the main
   wallet beside fleet activity.

## Settled decisions

- **A trade is a fleet buy:** one token, a total in ETH, every wallet in the fleet buys a slice.
- **Chit decides the stagger.** Sizes vary around the average and due times spread over a
  window the trader does not tune. No trader-specific rhythm to fingerprint.
- **Token by address.** The trader pastes an address; the service confirms an ETH pool
  exists and quotes it before anything is signed.
- **Fleet list and switcher** on the Control Room and the Trade page, from the escrow's
  `CampaignRegistered(campaign, owner)` events, read by the service.
- **No sells, charts, P&L, limit or copy trading, scheduling** in this step.

## The order

An order is a signed JSON object the browser stores and re-sends:

```
{ id, campaign, token, totalWei, wallets: [..], seed, windowMs, createdAt, owner }
```

- `id` is the keccak of the fields; `seed` is 32 random bytes from the browser.
- **Plan** (`src/fleet/order-plan.ts`, pure): `planSlices(order, capWei)` returns one slice
  per wallet: `{ index, wallet, amountWei, dueAt }`. Sizes are drawn from the seed within
  ±35% of `total / wallets`, then scaled so they sum to `total` and each is at most
  `capWei` (the session's `maxTradeValue`); if that is impossible the order is refused at
  placement. Due times are drawn from the seed uniformly across `[createdAt, createdAt +
  windowMs]`, sorted. `windowMs` is chosen by the service at quote time: 5 minutes for 5
  wallets, scaling to 30 minutes for 50. The same order always yields the same plan.
- **Placement** (`order` action, signed): validates the token has a pool, the total fits
  the fleet's remaining draw, every slice fits the cap, the fleet is Active. Returns the
  plan for display. Nothing executes.
- **Execution** (`trade` action, signed): the browser sends the order; the service recomputes
  the plan, skips slices whose reservation key is already reserved or committed on the
  escrow, executes the due ones through the existing `#buyOne` path (reservation key
  `${campaign}|order|${id}|${index}`), and returns per-slice results plus the next due time.
  The browser calls `trade` on the existing poll cadence while any slice is pending, and
  stops when all are done, failed, or the order is cancelled.
- **Cancel** is local: the browser marks the order cancelled and stops calling `trade`.
  Slices already committed stay committed. A cancelled order's remaining slices can never
  run, because nothing sends them.
- **History** is the browser's order store (`localStorage`, key `chit-orders:<owner>`),
  each order with its slice results and tx hashes. Cross-device history is out of scope.

## Quote and holdings

- **`quote` action** (signed, no state change): given a token address, reads `symbol`,
  `decimals`, and the v4 pool's `slot0` from the PoolManager (`extsload` on the pool id for
  the fixed key: fee 3000, spacing 60, no hooks). Returns `{ symbol, decimals, hasPool,
  priceX96, estimatedOut, windowMs, capWei }`. `estimatedOut` is labelled an estimate;
  `minOut` stays 0 as today, and the spec for slippage protection is a later step.
- **`holdings` action** (signed): given a fleet and a list of token addresses (the browser
  supplies them from its order history), returns each wallet's ETH and token balances. The
  browser never reads these itself.
- **`list` action** (signed): the fleets this owner registered, from escrow events, each with
  id, state, ETH left and wallet count. Name is a browser-side label (`chit-fleet-names`),
  since the chain has none.

## Pages

- **Trade** (`app/trade.html`, script `app/src/trade-page.ts`), "Trade" in the nav between
  Set up and Control Room. Same top bar, one 60rem column, Stow-style cards:
  - **Fleet and holdings.** Switcher, state chip, ETH left, one row per held token.
  - **Order form.** Token address field; on blur the quote fills symbol, price, "pool found".
    Total ETH field with the fleet's remaining draw as the ceiling. A plan preview: "N
    wallets · about X ETH each · over about M minutes". One primary pill, "Place order",
    which confirms in the glass dialog, then signs once.
  - **Orders.** Running orders with a meter (slices done of total) and "next buy in about
    2 min"; past orders below with explorer links per tx. Cancel on a running order.
  - Errors are coral-deep panels with a written reason: no pool, over the remaining draw,
    fleet paused, slice over the trade cap, service unreachable.
- **Control Room** gains the fleet switcher, a rename field (browser label), a per-wallet
  view (ETH, held tokens, explorer link), and this fleet's order history. "Run one buy per
  wallet" is removed; the Trade page replaces it. `#buy-report` markup stays for its test.
- **Set up** gains an optional fleet name on the size step, stored with the snapshot.

## Privacy and claims

- The browser calls only Chit's API and the explorer link is a plain `<a>` the trader
  chooses to follow. No RPC calls from any app page. A test greps the app for RPC URLs.
- The main wallet's address never appears on the Trade page except in the top bar's
  connected state, as today.
- Copy states once that trades are public. No "hidden", "anonymous" or "untraceable".
  The claims test covers `trade.html`.

## Testing

- **Pure:** `planSlices` (sums to total, each ≤ cap, ±35% bound, due times inside the
  window and sorted, same seed → same plan, cap impossible → refusal); quote parsing;
  order id derivation; the browser order store (add, update slice, cancel, list).
- **Routes** (`test/fleet/order-route.test.ts`, `list`, `quote`, `holdings`): placement
  refusals, execution runs only due slices, re-running skips reserved slices, a wrong owner
  is refused, the fleet must be Active.
- **Fork:** one order of 5 slices against the seeded venue token, executed over two `trade`
  calls, every slice committed once.
- **App:** design-contract tests for `trade.html` (ids, pills, claims), the switcher, and
  the removed button; `app:shots` renders Trade at every viewport, disconnected and seeded.
- **Gates:** `fleet-*` and `pool-*` stay green; a new `verify.sh` predicate `fleet-trade`.

## Delivery

Three plans, one spec, in order:

1. **Service:** `order-plan.ts`, the `quote`, `order`, `trade`, `list`, `holdings` actions,
   fork test, `fleet-trade` gate.
2. **Trade page** and the browser order store.
3. **Control Room additions** and the Set up name field.

Commits ≤ 200 lines, test-first, no new dependencies, no Claude attribution. Each plan ships
to main when its gates are green.

## Later (recorded, not in this step)

- **Sells.** Require a second approved operation in `FleetSessionPolicy` (token `approve`
  to Permit2 or the router) and a redeploy; then a `sell` mirror of the buy. User's go needed.
- **Slippage protection.** `minOut` from the quote with a tolerance.
- **Cross-device order history.** Needs service-side storage, which the fleet path does not
  have today.
- **Charts, P&L, limit and copy trading, scheduling.** Still excluded.
