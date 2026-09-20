# Chit Fleet

**Product**: A private funding layer for trading fleets. A trader runs many wallets; Chit funds them so the chain never shows the trader's main wallet funding the fleet. Delivered in three stages. This repository is the private build (`ajanaku1/chit-fleet`); the public `ajanaku1/chit` is the hackathon submission only.

**Goal (current build = the capped mainnet beta of Stage 2)**: Open the Private Funding Pool to real ETH on Robinhood Chain mainnet 4663, capped at 1 ETH, to CHIT holders, labelled a beta and labelled as not audited by a firm. Stage 2 is live and ungated on testnet 46630 and stays green there; Stage 1 (Fleet Mission, private gas) is live and stays green. Specified 2026-09-20: [design-mainnet-beta.md](design-mainnet-beta.md), [specs/003-mainnet-beta](specs/003-mainnet-beta/spec.md).

**Why**: The trader can coordinate a bounded five-account sponsored-buy campaign without publishing the primary-wallet-to-fleet gas-funding edge, and prove the paymaster and fleet plumbing on a live chain before any real capital is held.

## The honest constraint (bake this in)

Gas sponsorship alone does **not** hide the funding trail. To trade, each fleet wallet also needs its trade **principal**; if that principal comes from the trader's main wallet, the trail exists. Worse, Stage 1's escrow is a per-campaign deposit that names the owner on chain, and the same campaign key appears on every fleet account it creates, so on the live Stage 1 the primary-wallet-to-fleet link is derivable from public events (found 2026-09-06). Stage 1's true claim is only "the operator pays your fleet's gas". The "no trail" promise becomes true only at Stage 2, when deposits carry no campaign identifier and the pool funds principal and gas. Until Stage 2 is live, product copy must not claim it.

## Product stages (the roadmap)

- **Stage 1 — private gas (live).** Chit's operator pays the fleet's gas and settles it against the trader's ETH escrow (operator-executes; no paymaster in this stage). Live on Robinhood testnet 46630 at chit.tools; first sponsored buy landed 2026-09-06. Operator-trusted mapping.
- **Stage 2 — private funding pool (current build).** Chit funds the fleet's trade principal too, from one pooled, unkeyed deposit, so the main wallet never funds the fleet directly. This is where "no trail" becomes true. Semi-custodial (Chit briefly holds pooled capital), so it requires contract-enforced caps, a self-serve exit that works without Chit, and the accountable-privacy (selective-disclosure) model. A professional audit was originally a gate before any real funds; that was changed on 2026-09-20 to a capped, labelled beta first, bounded at 1 ETH so the most an unaudited contract can cost is the cap. The audit remains the gate for holding meaningful funds and for raising the caps. Specified 2026-09-06/07: [design-stage2.md](design-stage2.md), [specs/002-private-funding-pool](specs/002-private-funding-pool/spec.md).
- **Stage 3 — trustless shielded pool (final product).** A ZK privacy pool where nobody, not even the operator, links deposit to fleet, with user-held view keys for auditability. Needs privacy infrastructure not available on Robinhood today. North star, not near-term.

## Stage 1 core journey

Connect an eligible primary wallet; review published CHIT threshold and fee terms; configure fleet policy; download and confirm the encrypted recovery vault; fund ETH; activate; run the permitted SDK buy; monitor Control Room; pause, revoke, or Close to recover unused ETH.

## Stage 1 status (live)

Core contracts deployed and verified on 46630: session policy `0x57c7436bbbb40b08adef5c84f0aeaee0c4f3e011`, account factory `0x5c0e2ec619c11b66e0e0efb7931bccfa6b784ea6`, campaign escrow `0xd2c31ec466ead5f745bc6ba08cc49ff8435f1325`; FLEET venue token and seeded Uniswap v4 pool, the first sponsored buy, and every tx hash are recorded in [deployments/fleet-46630.json](deployments/fleet-46630.json). The app, landing, and API are deployed at chit.tools. The service is stateless across function instances. Every `fleet-*` gate in `verify.sh` is green and must stay so.

## Stage 2 core journey

Connect the primary wallet; deposit a fixed size into the pool with headroom shown; create a fleet (size, backup, confirm); activate with a draw from the balance; watch "Funding your fleet" through the random delay; run the permitted buy with principal moved just in time; pause, resume, revoke, or close (unspent draw credited to balance); withdraw to a signed address; or exit through the contract after 24 hours without Chit.

## Stage 2 scope

The pool contract (fixed-size unkeyed deposits; caps 0.5/0.2/5 ETH on testnet and 0.1/0.05/1 ETH on the mainnet beta; pause; draws with operator-encrypted owner reference and due time; just-in-time principal; queued spend posting with a random delay; operator claim; 24 hour self-serve exit); the ledger service (balance from chain, sweep by cron and every request, withdrawal payout from the operator wallet); the Balance page, wizard and Control Room changes; the FR-015 claim across app, landing, and marketing; and a live pooled buy. Testnet carries the test token only; the mainnet beta carries CHIT plus at most three hand-checked memes.

## Stage 1 scope

Responsive dashboard, small TypeScript SDK, read-only mainnet CHIT eligibility/discount, locally encrypted browser-generated owner credentials, one bounded session key, ETH campaign budget, one approved Robinhood Chain testnet buy route through EntryPoint v0.7.0 and the Uniswap v4 Universal Router, aggregate reporting, and a five-account demo. Public accounts, trades, amounts, timing, gas, and shared paymaster remain visible; only the public primary-to-fleet gas-funding relationship is withheld, while the operator knows it in MVP.

## Out of scope for Stage 1

**Roadmap (later stages, not permanently excluded):** operator-blind attribution, user-held view keys, mainnet sponsorship, on-chain confidential attribution (Nox or ZK), batched funding windows, an anonymity set, multi-asset deposits, and token treasury/buyback mechanics. Pooled custody of trade principal is now Stage 2 scope, testnet only.

**Permanently excluded:** custody or imported fleet keys, arbitrary calls, hidden trades, manufactured volume, and market manipulation. Chit never hides trades and never markets anonymity.

## Constraints

Target chains are Robinhood Chain testnet 46630, ungated, and mainnet 4663 for the capped beta. Each runs its own deployment: one chain per service, one chain per app host. CHIT is read-only eligibility and discount data; the sponsorship budget is ETH. No constants, deployments, venue, endpoint, or credential is invented — verified addresses are recorded in [research.md](specs/001-fleet-mission/research.md) and [deployments/fleet-46630.json](deployments/fleet-46630.json). Revoked is terminal for sponsorship; Close is its sole remaining action. Stage 1 follows [FR-001–018](specs/001-fleet-mission/spec.md) and [SC-001–010](specs/001-fleet-mission/spec.md); Stage 2 follows [FR-001–017](specs/002-private-funding-pool/spec.md) and [SC-001–010](specs/002-private-funding-pool/spec.md), except its FR-016, which excluded mainnet and is superseded for the beta by [specs/003-mainnet-beta](specs/003-mainnet-beta/spec.md) FR-001–043 and SC-001–016. No dependency is added; the ledger key and challenge secret derive from the operator key already in the environment.

## Definition of done (Stage 2)

All Stage 2 FR/SC outcomes pass through the `pool-*` verification family in `verify.sh`: pool contract, ledger, and ABI separation proven on the 46630 fork (`pool-foundation`); balance, headroom, withdrawal, and exit (`pool-balance`); delayed funding from a fresh instance and just-in-time buys (`pool-fund`); close-to-balance, top-up, and operator pause (`pool-control`); observer unlinkability over events, FR-015 copy, and every Stage 1 `fleet-*` gate still green (`pool-acceptance`). The live pooled buy on chit.tools (T040) is outward and recorded in the deployment file.

## Definition of done (the capped mainnet beta)

All 003 FR/SC outcomes pass through the `beta-*` family in `verify.sh`: the caps
branch rebased and the caps read back from deployed bytecode (`beta-caps`); every
money-moving write durable and every reproduction flipped (`beta-money`); the
pool reimbursing fronted withdrawals with the monitor identity assertable
(`beta-contract`); the gate, the beta note and the refusal state
(`beta-surfaces`); the token registry pinned, checked and quoted against real
pools (`beta-venue`); and the launch gate, which includes the published-promise
correction and a clean forty-eight hour soak (`beta-launch`). Three things are
outward and are the user's to run, recorded after: the testnet redeploy, the fork
rehearsal, and the mainnet deploy itself.

## Definition of done (Stage 1, kept green)

All FR/SC outcomes pass through the Fleet verification family in `verify.sh`: verified testnet dependency evidence or labelled fixture; policy/state/budget/redaction protections; eligible five-account creation with fee/vault controls; bounded sponsored buys; terminal lifecycle control; hardened contracts proven on a live EVM; and full build, privacy, and quickstart acceptance. Stage 3 has no done predicate here; it earns its own spec and `verify.sh` tags when it is actually built.
