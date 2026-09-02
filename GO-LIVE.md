# Chit Fleet — Stage 1 Go-Live Checklist

Private ops doc. Takes Stage 1 (private gas, operator-executes model) from "building blocks done and tested" to a live end-to-end sponsored buy a $CHIT holder can run on Robinhood testnet 46630.

Two kinds of steps below: **[code]** I do (non-outward, no approval needed) and **[outward]** which need your go-ahead, a key, a faucet, or a config value. The outward steps are batched so you can approve them together.

---

## Already done (on-chain, tested, in the gate)

- Core contracts deployed + verified on 46630: session policy `0x57c7436b…e011`, account factory `0x5c0e2ec6…4ea6`, campaign escrow `0xd2c31ec4…1325`.
- Escrow settlement, policy-gated `FleetAccount.execute`, operator-executes single buy, and the multi-account `runFleetBuy` service — all proven on a live EVM.
- The app UI (wizard, dashboard, privacy page) — built; wallet generation + encrypted backup run for real in-browser.

---

## Step 0 — Service wiring  **[code — I do next]**

Wire the API to the deployed contracts instead of the in-memory twin:
- On create: `escrow.registerCampaign(campaign, owner)`.
- On activate: `policy.openSession(campaign, session, accounts)` for the generated fleet.
- Fund verification reads `escrow.budget(campaign)` on-chain.
- The buy route calls `runFleetBuy` (operator-executes settlement).

**Done-check:** a local/fork test drives create → fund → activate → buy fully through the service against the on-chain contracts. No approval needed; I'll build and test this before anything outward.

---

## The outward steps (approve together)

### Step 1 — Service configuration  **[outward — you decide the values]**
The service answers 503 until it's configured. Needs:
- **Operator signer key** — a testnet burner (the deployer `0x34b0…F724` already is one). This becomes a **server-side signer** that executes buys and settles the escrow. Decision: OK to use this key as the server signer, and (later) place it in the host's env? Never a mainnet key.
- **Deployed addresses** — from `deployments/fleet-46630.json` (already recorded).
- **No gated entry on testnet (decided).** Requiring CHIT on the main wallet to use a privacy app fingerprints that wallet as a Chit user, which is self-defeating. So Stage 1 on **testnet** has **no gate**: anyone can create a fleet, no CHIT balance check. Whether to gate on **mainnet** is a later decision, and if we do, it must be privacy-preserving (prove holding from a separate wallet, or a ZK proof decoupled from the funding wallet — Stage 2/3 tech). CHIT stays optional upside anyway (discounts, early access, governance), opt-in, so a privacy-first user never has to touch CHIT on their main wallet. **Marketing follow-up:** the CM article line "CHIT gives eligibility to create a fleet" must change to discounts + early access.

### Step 2 — Operator gas float  **[outward — faucet]**
In the operator-executes model the operator pays gas (reimbursed by the escrow). Confirm the operator wallet holds enough testnet ETH for buys + settlement txns; top up from the Robinhood testnet faucet if low. (Currently ~0.017 ETH.)

### Step 3 — A venue to buy  **[outward — small deploy + decision]**
Stage 1 needs an approved target to "buy." Two options:
- **Simple test target (recommended for the first demo):** deploy a minimal token/target on 46630, set it as the approved router/selector. Proves sponsored execution cleanly. Fast.
- **Real Uniswap v4 pool:** seed a pool with liquidity so buys hit the real router. More realistic, more setup. Better as a follow-up.

Decision: simple target first, or go straight to a seeded pool?

### Step 4 — Deploy the app  **[outward — host deploy]**
Deploy the Fleet app (the wizard/dashboard/privacy pages + the wired `/api/fleet` service) to a host (Vercel) with the Step 1 env set. This is where the operator key lives server-side — treat it as a secret, testnet-only. Decision: approve the deploy; confirm the host/project.

### Step 5 — First live sponsored buy  **[outward — the moment]**
Register + fund a demo campaign on testnet, run the first sponsored buy through the live app, capture the tx hashes, and record them in the evidence/deployment file. Then flip the app's "testnet pending" banners to live.

### Step 6 — Early access  **[outward]**
Open early access to $CHIT holders. Announce (the CM article already frames this as the milestone).

---

## Decisions to approve (the one-pass gate)

1. **Server signer:** use the `0x34b0…F724` testnet burner as the service's operator key, in the host env, testnet-only?
2. **Eligibility:** publish a CHIT threshold/fee now (give the numbers), or open Stage 1 with no gate and add it later?
3. **Venue:** simple test target first, or seed a Uniswap v4 pool?
4. **App host:** approve the app deploy, and to which host/project?

Give me those four and a "go," and the sequence is: I finish Step 0 (code), then run Steps 1–5 with your key/config, and hand you the live buy + tx hashes.

---

## Honesty guardrails at go-live

- Stage 1 is **private gas only**. The app copy must not claim "no trail back to you" (that's Stage 2). Keep the stage-labeled language from the CM docs.
- **No audit yet** — testnet only, no real funds. Do not describe Stage 1 as audited or safe for real capital.
- The operator can see the primary-to-fleet mapping (disclosed). Nothing here changes that.
