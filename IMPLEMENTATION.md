# Chit implementation record

## Selected direction

The user selected UI Option A, **Public Docket**. This is separate from the
logo gate, where Option B, **Blind Seam**, remains the selected mark.

Public Docket uses a paper-and-ink editorial layout, Fraunces display type, DM
Mono evidence text, signal coral actions, and a torn blind seam between public
steps and private attribution. The production UI should preserve the strong
hierarchy while making every transaction state explicit and keyboard-accessible.

## Design feasibility

- Aesthetic impact: 4/5
- Context fit: 5/5
- Implementation feasibility: 4/5
- Performance safety: 4/5
- Consistency risk: 3/5
- DFII: 14/15

The distinguishing element is the blind seam: public transaction stages sit on
paper while encrypted attribution sits behind an ink panel whose edge cannot be
followed directly.

## Verification deviation — 2026-08-28

The contract-address masthead change passed the local predicate, typecheck, all 20
application tests, production build, desktop and 320px browser checks, and a fresh Sol
review with verdict `ship`. The supplemental `claude-check.sh` could not run because
the local Claude OAuth session was unauthenticated. The user explicitly instructed us
to skip Claude authorization and continue; this exception applies only to that external
checker and does not waive the recorded local, browser, or Sol verification evidence.

## Fleet Mission phase 1 — 2026-08-30

`./verify.sh fleet-evidence` passes. T001–T008 are complete: the Fleet-scoped
compile/test harness (`tsconfig.fleet.json`, `build:fleet`, `test:fleet`), the
dependency-evidence validator, the shared Fleet types, and the browser boundary.

Two decisions were taken inside the evidence contract's latitude and are recorded
here rather than left implicit:

- **Fixture records carry no address.** `fleet-evidence.md` makes `address`
  optional. The validator now *forbids* it in fixture mode, so a test double can
  never be mistaken for a recorded deployment. Live mode still requires a
  bytecode-bearing address for `entryPoint`, `paymaster`, `router`, and `venue`,
  and forbids one for `provider`, which names an endpoint.
- **Freshness applies to live records only.** A fixture describes locally
  deployed test doubles, not chain state, so time-bounding it would expire the
  committed fixture on the calendar rather than on evidence. A record declares
  itself unbounded with `maxAgeSeconds: 0`, which live mode rejects.

The committed fixture targets chain 31337 (local Hardhat) and names
`FleetFixtureRouter` / `FleetFixtureToken`, per the spec's fallback when no
verified testnet swap venue is available.

One test case was corrected before it ever passed: the staleness case in
`test/fleet/chain-dependencies.test.ts` used a timestamp inside its own freshness
window, so it asserted nothing. No passing check was weakened.

## Fleet Mission phase 2 — 2026-08-30

`./verify.sh fleet-foundation` passes. T009–T016 are complete: the campaign state
machine, the bounded session policy, the campaign ETH budget, the service
envelope/idempotency/redaction layer, and the three Solidity contracts.

Choices worth recording:

- **Distinctness is enforced by ordering, not by scanning.** Both
  `FleetAccountFactory.createFleet` and `FleetSessionPolicy.openSession` require
  strictly increasing addresses. That enforces FR-001's distinct owners in one
  pass instead of an O(n^2) comparison over as many as 50 accounts, and it matches
  the sorted account order the Recovery Vault v1 contract already specifies.
- **Activation is retry-safe on chain.** `createFleet` returns an existing
  address rather than redeploying, so a reload during activation cannot produce a
  duplicate fleet (FR-014).
- **A consumed challenge is marked, not deleted.** Replaying a verified envelope
  reports `nonce_used`, not `nonce_unknown`, until the entry ages out with its own
  expiry. Both are `401 challenge_invalid`; the distinction is what makes replay
  visible in a log rather than indistinguishable from a forged nonce.
- **`close` on the escrow takes the campaign's open reservation keys.** Solidity
  cannot iterate a mapping, so the caller supplies them; any key that is not
  currently reserved is skipped, so passing a stale or wrong key cannot move ETH.

## Direction change: Robinhood Chain testnet — 2026-08-30

The user redirected Fleet Mission from an unspecified testnet to Robinhood Chain.
Before amending anything, the following was verified by direct JSON-RPC against
`https://rpc.testnet.chain.robinhood.com`, not taken from documentation:

- `eth_chainId` → `0xb626` (46630); mainnet → `0x1237` (4663).
- EntryPoint v0.6.0, v0.7.0, and v0.8.0 all return non-empty bytecode, as does the
  Safe 4337 Module v0.3.0.
- Uniswap v4 PoolManager (24,009 bytes), Universal Router (24,546 bytes), and
  Permit2 (9,152 bytes) are deployed on **testnet at the same addresses as
  mainnet**, although Uniswap's published v4 deployment table lists only mainnet.

Two things this settles:

- The test-only fixture router the original spec had to assume is no longer
  forced. The demo can route through the real Universal Router on testnet.
- FR-017's exclusion of Robinhood Nox is now verified, not assumed: iExec supports
  Arbitrum Sepolia and Arbitrum mainnet only, defaulting to
  `arbitrum-sepolia-testnet`. Nox does not run on Robinhood Chain. The existing
  Ethereum Sepolia Nox proof does not move, and Fleet Mission never depended on it.

The user chose testnet 46630 over mainnet 4663: mainnet would put real ETH into an
unaudited paymaster and escrow and would contradict FR-018.

### Amended artifacts

`Goal.md`, `specs/001-fleet-mission/spec.md` (FR-018, a dated clarification, and
the dependency assumption), `plan.md`, `research.md`, `quickstart.md`, and
`contracts/fleet-evidence.md`. `hardhat.config.ts` gains `robinhoodTestnet` and a
`robinhoodTestnetFork`, so Fleet tests can run against the real EntryPoint and
router without spending testnet ETH. The existing Sepolia entries are untouched.

### Evidence contract amendment

The record schema gains a required per-role `verified` boolean. Previously fixture
mode forbade every address, which would have hidden the real EntryPoint and router
the implementation now needs. A role with `verified: true` names a real deployment
and must carry a bytecode-bearing address (except `provider`, which names an
endpoint); a role with `verified: false` is a double and must carry none. A fixture
record must still contain at least one double — otherwise it is understating a
fully verified record, and the weaker claim would be the wrong one.

The committed record therefore now targets chain 46630 with `provider`,
`entryPoint`, and `router` verified, while `paymaster` and `venue` stay labelled
doubles until the Fleet paymaster and the demo venue token are deployed to 46630.
`allowedClaim` remains `test-only-fixture` until then.

### Still open

- No Robinhood Chain testnet pool with confirmed liquidity has been verified, so
  the demo buy still needs either a seeded v4 pool or the labelled venue double.

## Bundler chase — 2026-08-30

Three submission routes for chain 46630 were confirmed, in descending order of
production realism. None has landed a UserOperation yet; that requires an API key
and testnet ETH, both user-supplied per the no-invented-credentials rule.

1. **Alchemy Bundler API — confirmed available.** Alchemy's docs list the Bundler
   API and Gas Manager for Robinhood Chain, endpoint
   `https://robinhood-testnet.g.alchemy.com/v2/<api-key>`. A keyless probe of that
   host returned HTTP 429 (a rate-limit wall, not an unknown-network error), which
   proves the route exists and is gated only by a free API key.
2. **ZeroDev — confirmed available** as the named alternative provider on
   Robinhood Chain. Not probed further; one provider suffices for the MVP.
3. **Self-bundling — already implemented in this repo and viable on 46630.** The
   Sepolia proof lands UserOperations by calling `EntryPoint.handleOps` directly
   from the operator EOA (`src/viem-service-clients.ts:331`). The public testnet
   RPC answers everything that path needs (`eth_estimateGas`, `eth_call`,
   `eth_sendRawTransaction`), and EntryPoint v0.7 answered live view calls
   (`getNonce`, `balanceOf`) with correct zero values for an unused address.

Decision: build Phase 4 against the self-bundling path the repo already has, keep
the submission client behind an interface so an Alchemy bundler URL is a
configuration change, and record the bundler in dependency evidence once a key
exists and a UserOperation has actually landed.

## Fleet Mission phase 3 — 2026-08-30

`./verify.sh fleet-create` passes. T017–T024 are complete: eligibility and fee
accounting, the campaign action router with its thin Vercel wrapper, the exact
Recovery Vault v1 protocol, and the DOM-free campaign setup journey.

Decisions and deviations recorded:

- **The vault vector uses well-known hardhat development keys.** T019 mandates a
  fixed vector fixture whose payload by design contains private keys, while the
  workspace law forbids committing keys. Resolution: the fixture uses the
  universally published hardhat/anvil development keys — public constants in
  every hardhat install, not credentials — and is labelled `testOnly` with a
  never-fund warning. The `verify.sh` committed-key predicate scans `contracts/`,
  `scripts/`, `README.md`, and `feedback.md`; the fixture is in none of them.
- **The vector was generated implementation-independently.** A scratchpad script
  implemented `fleet-vault.md` with `node:crypto` only, so the fixture judges
  `app/src/fleet/vault.ts` rather than mirroring it. The vault reproduces every
  intermediate (HKDF KEK, both AES-GCM ciphertexts and tags, both commitments,
  canonical envelope, final keccak commitment) byte-for-byte.
- **Recovery collapses `vault_invalid` too.** During recovery, account-validation
  failures inside the payload re-collapse into the single non-oracular
  `vault_decryption_failed`; a simplify-pass rethrow briefly let the internal
  code escape and the tamper test caught it. The guard now passes through only
  the already-collapsed code.
- **`api/fleet/campaign.ts` answers 503 without configuration.** The CHIT RPC
  endpoint, token address, and published fee facts are environment configuration;
  no default endpoint or fee value is invented. Campaign records are per-instance
  memory in this MVP; durable storage is a later, separately-evidenced step.
- **Two route-test corrections before green**: the 50-account case originally
  sent a 5-account policy (the mismatch rejection was correct), and the
  duplicate-owner vault case forged an entry whose key could not derive its
  owner, so the derivation check fired first. Both were test fixes; no check was
  weakened.

## Fleet Mission phase 4 — 2026-08-30

`./verify.sh fleet-buy` passes. T025–T032 are complete: the buy route on the
campaign router, the EntryPoint v0.7 UserOperation adapter with a self-bundling
submitter, the Fleet SDK with local Revoked-terminal refusal, and Control Room
buy reporting.

Decisions recorded:

- **Sponsorship semantics.** Request-level policy violations (trade cap, state,
  expiry) refuse the whole request with `403 policy_rejected` before any
  sponsorship; per-account problems (unknown account, reservation that no longer
  fits, submit failure) mark that account `rejected` while the rest proceed.
  A submit failure rolls its reservation back and charges nothing.
- **Depletion is automatic.** After a buy, a campaign whose unused budget cannot
  cover another `perAccountGas` reservation transitions to Depleted, and a
  depleted campaign sponsors nothing.
- **Funding is evidence-checked.** The `fund` action now requires a configured
  `verifyFunding` dependency that confirms the funding reference and returns the
  verified wei amount; the budget is that amount, never a client claim. Without
  the dependency, fund answers 503.
- **The five-wallet e2e is an in-process journey.** The predicate runs plain
  `node --test` with no chain, so SC-003/SC-004/SC-009 are proven at the logic
  layer against a public-ledger double: five sponsored buys, exact aggregate
  debit, and no primary wallet anywhere in operations or responses. The on-chain
  demo on 46630 needs testnet ETH plus the deployed paymaster, and stays open in
  the quickstart.
- **SDK terminal behavior.** Once any response reports a campaign Revoked, the
  client refuses buy/resume/pause/rotate locally without sending a request;
  close and read remain permitted. This fronts T037's server-side enforcement.
- **Deferred cleanup**: `api/fleet/campaign.ts` and `api/fleet/buy.ts` share
  their wrapper shape; when `api/fleet/control.ts` lands in phase 5 the common
  handler moves into `service-runtime.ts`.

Regression caught by the phase gate: the evidence-checked fund initially tested
server configuration before state legality, turning a skipped-step 409 into a
503 in the phase-3 journey test. Order corrected — state first, configuration
only when a transition will occur — and the phase-3 router test gained the
`verifyFunding` dependency it now exercises. Both predicates re-verified green.

## Fleet Mission phases 5 and 6 — 2026-08-30

`./verify.sh fleet-control` and `./verify.sh fleet-acceptance` pass; all six
Fleet predicates are green and T001–T041 are complete.

Phase 5 notes: most control logic (pause/resume/revoke/close) had landed in
phase 4 because the buy tests needed pause, so T033's new coverage is the
owner-only check, the exact close refund, double-close returning zero, and the
same-key replay returning the original receipt. T037 was already satisfied by
the SDK's local Revoked-terminal refusal. The three Vercel wrappers now share
one handler in `service-runtime.ts`, closing the deferred-cleanup note.

Phase 6 notes: the root `npm run build` baseline debt recorded in plan.md no
longer reproduces — the root build is clean, so fleet-acceptance runs it
directly. The quickstart was reconciled to say exactly what is proven by the
suite and what remains pending on-chain (testnet deployment, a landed sponsored
UserOperation on 46630, a verified venue, service configuration).

Deviation: the Sol peer-verification gate cannot run from this session (no Sol
seat available); queued for the user per the standoff rule. Fresh-context
verification of the Fleet done_when runs next as its own step.

## Fleet frontend + skill verification pass — 2026-08-31

The Fleet tool now has a user-facing page: `app/fleet.html` + `app/fleet.css` +
`app/src/fleet-page.ts`, wired into `app/build.mjs`, in the selected Public
Docket direction (paper/ink editorial, Fraunces + DM Mono, signal coral, and the
torn blind seam separating the public docket from the private attribution
column). What is real today runs for real: fleet keys generate in the browser,
the Recovery Vault v1 encrypts/downloads/confirms end to end with wallet
signatures. Service-backed steps (quote, fund, activate, buy, lifecycle) call
the Fleet API and surface the honest 503 testnet-pending banner until the
service and paymaster exist on 46630; preview eligibility is labelled as such.

Verification ran through the prompt.md preflight skills, correcting an earlier
gap where several were satisfied only by their fallbacks:

- **design (orchestrator, --polish-only)**: direction pre-selected; production
  build + phase-5 QA. Contrast computed, not eyeballed: 10/10 pairs pass WCAG
  AA (weakest 4.65:1). Record in `ai/design-progress.md`.
- **code-reviewer** on the frontend: five findings, all fixed — innerHTML XSS in
  the buy report (now textContent), a real vault success mislabeled as failure
  when campaign create 503s (split), `not_created` shown as rejection instead
  of testnet-pending (rerouted), an unbound CA copy button (bound), and a
  keyboard-reachable "locked" policy form (now a disabled fieldset).
- **solidity-security** on `contracts/fleet/`: report-only, queued as
  pre-mainnet blockers, none affecting the value-free testnet MVP:
  - HIGH: `FleetAccount` has no owner escape hatch — purchased tokens are
    unrecoverable (execute is operator-only and router-bound; the recovered
    keys control nothing on-chain).
  - MEDIUM: a campaign owner can front-run `commit` with `close(openKeys)`,
    rolling back an in-flight reservation after gas was spent.
  - MEDIUM: committed `spent` ETH has no operator withdrawal and is stranded.
  - LOW: campaign-id squatting via first-funder-becomes-owner; `openSession`
    lacks sanity reverts (past expiry, chain mismatch, per>total gas).
  - Verified sound: `close` CEI/reentrancy, CREATE2 retry idempotency,
    terminal-revoke invariants.
- **test-driven-development / web3-testing**: `app/test/isolated-build.test.ts`
  gained the two new build inputs (inventory update, no assertion weakened);
  full re-verify after fixes.

Final state: all six `./verify.sh` fleet predicates PASS with the frontend
inside the app pipeline; the app suite is 52/52.

## Fleet consumer redesign — 2026-08-31

The user judged the first Fleet page too complex for retail and reopened the
visual direction. Full creative round run this time: three proposals in
`proposals/fleet-consumer-2026-08-31/` (Docket Lite, Night Ledger, Soft
Receipt). **User selected Soft Receipt, plus dark mode.**

Shipped: the single dense page became three — `fleet.html` (a wizard, one
question per screen: connect → size → backup → launch), `fleet-dashboard.html`
(budget meter and plain-language lifecycle controls), and
`fleet-privacy.html` (rendered from the same module constants the privacy
tests enforce, so page copy cannot drift from tested claims). ETH units only;
wei, router, selector, and gas caps live behind a collapsed Advanced panel with
verified presets; totalGas derives from wallets × per-wallet cap. Quick-pick
pills set wallet count and duration. Cross-page state is a sessionStorage
snapshot of public data only — campaign handle, state, budget, addresses;
never keys. Dark mode is Soft Receipt's warm-charcoal sibling: header toggle
persisted in localStorage, system preference as default.

QA (design skill phase 5, re-run): 17/17 color pairs pass WCAG AA in both
themes, weakest 4.50:1. The proposal mock's white-on-coral CTA computed to
~2.9:1 and was corrected to ink-on-coral (5.61:1) in production. All six
verify.sh fleet predicates remain green; the app suite is 52/52 with the two
new pages added to the build and the isolated-build inventory.

## Contract security hardening — 2026-08-31

Direction changed: Fleet is going to production with real users, so every
solidity-security finding is fixed before testnet, test-first, and proven on a
live EVM (new suite `test/fork/fleet-contracts.test.ts`, now run by
`./verify.sh fleet-foundation`). Standard caveat recorded and repeated to the
user: contracts holding real user funds still warrant a professional audit
before mainnet; this hardening closes the known findings but does not replace
that gate.

Fixes:

- **HIGH — owner escape hatch.** `FleetAccount` gains owner-only
  `withdrawToken`/`withdrawEth` (SafeERC20, zero-recipient guard). The sponsored
  `execute` path stays operator-driven and policy-bound; recovering the account's
  own assets is the owner acting directly, which the policy does not gate. Tokens
  a fleet account buys are now recoverable.
- **MEDIUM — close/commit race.** New `Locked` reservation state + `lock()`;
  `close` will not roll back a reservation locked within `LOCK_WINDOW` (1h), so a
  broadcast sponsored op can still be committed. The window bounds the operator's
  exclusivity.
- **MEDIUM — stranded locked reservation (found by the code-reviewer pass on this
  very diff).** An early `close` skips a still-locked reservation but runs only
  once, so an abandoned lock could strand ETH. Added owner-only
  `reclaimExpiredLock`, callable after the window even post-close.
- **MEDIUM — stranded spend.** `withdrawSpent` lets the operator withdraw
  committed gas cost to a beneficiary, tracked by `spentWithdrawn` so nothing
  pays twice; reverts once drained.
- **LOW — id squatting.** `registerCampaign` (operator-only) sets the owner
  before funding; `fund` now requires a registered campaign and the registered
  owner. First-funder-becomes-owner is gone.
- **LOW — openSession sanity.** Rejects past expiry, chain mismatch, zero router,
  and per-account gas above the total.

CEI verified on every new external call (state updated before transfer); the
`spent - spentWithdrawn` and `funded - spent - reserved` subtractions cannot
underflow given the maintained invariants. `campaign-budget.ts` stays the pure
arithmetic twin; the lock/registration/withdrawal are on-chain concurrency and
access concerns the single-threaded model does not need, an intentional
documented divergence.

## Fleet deployment tooling — 2026-08-31

Built the deploy path so the real testnet deploy is one command once a funded key
is supplied. `src/fleet/deploy.ts` holds a transport-agnostic `deployFleet` that
deploys the three hardened contracts (operator = deployer), waits for each
receipt, verifies code landed, and returns a complete record. It runs against a
local EVM in `test/fork/fleet-deploy.test.ts` (now part of `fleet-foundation`),
so the live path is proven without a credential.

`scripts/fleet-deploy-live.ts` is the thin wrapper for Robinhood testnet (46630):
it reads `DEPLOYER_PRIVATE_KEY` and optional `ROBINHOOD_TESTNET_RPC_URL` from the
environment — never invented — and writes `deployments/fleet-46630.json`. Run
with `npm run fleet-deploy:live`.

The actual on-chain deploy is a deliberate stop point per plan.md (outward
action, requires a funded key and explicit go-ahead). It has not been run.

## Testnet deployment — 2026-08-31

The three core Fleet contracts are LIVE on Robinhood Chain testnet (46630),
deployed via `npm run fleet-deploy:live` from the funded deployer
`0x34b0Ba20669f3ec4F1056853780c381e5e35F724` (also the operator). Verified by
independent `eth_getCode`: each address carries real bytecode.

- FleetSessionPolicy  `0x57c7436bbbb40b08adef5c84f0aeaee0c4f3e011`
- FleetAccountFactory `0x5c0e2ec619c11b66e0e0efb7931bccfa6b784ea6`
- FleetCampaignEscrow `0xd2c31ec466ead5f745bc6ba08cc49ff8435f1325`

Record: `deployments/fleet-46630.json` (addresses + deploy tx hashes).

One bug fixed en route: the live script read the RPC env var with `??`, which
does not fall back on the empty string a blank `.env` line produces; switched to
`||`. The failure happened at client construction, before any broadcast, so no
gas was spent on the first attempt.

Still pending before the app's "testnet pending" banners can go live:
- A gas-sponsoring **paymaster** contract (not yet built; the escrow holds the
  budget but does not itself sponsor UserOperations through the EntryPoint).
- Wiring the deployed escrow + paymaster into the hosted service (the API still
  uses the in-memory TS budget twin) and configuring it.
- A seeded venue (a Uniswap v4 pool with liquidity, or the labelled test token).

## Stage 1 gas model — operator-executes (2026-09-02)

A fork surfaced that the fleet accounts and the gas-payment path had drifted: the
verifying paymaster is a proper ERC-4337 component, but FleetAccount is an
operator-gated executor with no `validateUserOp`, so the EntryPoint cannot drive
it. The user chose the **operator-executes** model for Stage 1 over a full 4337
rebuild.

Model: the operator calls `FleetAccount.execute` (already policy-gated) directly,
pays the gas, and settles it against the escrow — reserve the ceiling, run the
call, commit the actual gas — so the trader's ETH budget reimburses the operator
and the fleet's gas never comes from the trader's main wallet. No EntryPoint or
paymaster at this stage; the 4337 paymaster + `paymaster-data.ts` are kept for
the later decentralized model, not deleted.

`src/fleet/operator-executor.ts` implements it; `test/fork/fleet-operator-executor.test.ts`
proves it on a live EVM (approved call runs, budget debited by exactly the settled
gas, unapproved call rolls back charging nothing) and is now in
`verify.sh fleet-foundation`.

## Step 0 — service wiring, open access (2026-09-05, verified)

The router now takes an optional `chain: FleetChain` (`src/fleet/chain-service.ts`)
that binds the deployed escrow, factory, and session policy behind the operator's
signer. With it configured: create registers the campaign in the escrow; fund
reads `escrow.budget` and refuses (422) until the escrow holds at least one
per-account gas cap; activate creates the fleet through the factory and opens
the bounded session; buy policy-checks each account off-chain, then settles the
permitted ones through `runFleetBuy`. The response budget is the on-chain read,
never a mirror. Without `chain`, the in-memory path is unchanged, so every
existing route test still holds.

Open access (decided 2026-09-02): `feeConfig`/`chitBalanceOf` are optional; absent,
the quote is zero-fee and always eligible, and create charges nothing. The wizard
is untouched (it only blocks on `eligible: false`, which never happens now), so its
tests stand as written. The service no longer answers 503 for want of CHIT fee env.

Runtime env (server-side, testnet only): `FLEET_OPERATOR_PRIVATE_KEY`,
`FLEET_ESCROW_ADDRESS`, `FLEET_FACTORY_ADDRESS`, `FLEET_POLICY_ADDRESS`, optional
`ROBINHOOD_TESTNET_RPC_URL`. Stage 1 control actions (pause/resume/revoke) stay
service-side: the operator is the only executor, so a paused campaign sponsors
nothing without an on-chain call. Deviation noted, conservative option.

Done-check `test/fork/fleet-service-chain.test.ts` (added to `fleet-foundation`)
drives the whole journey through the router on a live EVM. Once Rosetta was
installed the check ran and surfaced one bug: the router's error mapper never
handled `BudgetError`, so the deliberate "escrow unfunded" 422 escaped as a
crash. Fixed by mapping `BudgetError` codes like the other typed errors.
`./verify.sh` is green for every fleet phase (evidence, foundation, create,
buy, control, acceptance). Step 0 is done; Steps 1–5 are outward (operator key
in host env, pool seeding, Vercel deploy, first live buy) and wait for a go.

## Venue — real Uniswap v4 pool on 46630 (2026-09-05)

Decided venue (2026-09-02): a seeded Uniswap v4 pool, not the labelled fixture.
The v4 PoolManager `0x8366…0951` and Universal Router `0x8876…0904` are live on
46630 (research.md), but no v4 PositionManager address is verified there, so
seeding goes through a small contract of our own:

- `contracts/fleet/FleetVenueToken.sol` — fixed-supply test ERC-20 "FLEET".
- `contracts/fleet/FleetPoolSeeder.sol` — initialises the ETH/FLEET pool and
  adds one full-range position inside the PoolManager's unlock callback,
  paying ETH from msg.value and FLEET from the caller's approval. Inline
  minimal v4 interfaces; no dependency added.
- `src/fleet/v4-swap.ts` — Universal Router `execute` calldata for one exact-in
  ETH -> FLEET swap (command V4_SWAP; actions SWAP_EXACT_IN_SINGLE, SETTLE_ALL,
  TAKE_ALL). The router's on-chain buy path uses it whenever the campaign's
  approved function is `execute(bytes,bytes[],uint256)`, which is the wizard's
  preset; any other function keeps the fixture shape.
- Stage 1 honesty holds in the mechanics: the trade principal is the fleet
  account's own ETH (`value`); the escrow reimburses gas only.

Done-check `./verify.sh fleet-venue`: encoder unit tests, then
`test/fork/fleet-venue.test.ts` on a fork of 46630 seeds the pool through the
live PoolManager and lands a sponsored buy through the live Universal Router
into a policy-gated fleet account. Green. The public RPC drops requests under
a fork's burst, so the fork is pinned to block 113731448 and the check retries
the unchanged predicate up to three times.

`npm run fleet-venue:live` (scripts/fleet-venue-live.ts) seeds the real pool and
records it under `venue` in deployments/fleet-46630.json.

## Deploy to chit.tools — one site, precompiled API (2026-09-06)

chit.tools is the Vercel project `chit-tools`; it served only the landing
(uploaded from `landing/`). The repo root now links to it and one build
assembles `public/`: landing at `/`, the Fleet app at `/app`, functions from
`api/`. Vercel's own TypeScript pass type-checks viem differently from our tsc
(it rejected `createPublicClient` and a typed `readContract` our build accepts),
so the fleet handlers are plain JS (`api/fleet/*.js`) importing the runtime
compiled by `npm run build` in the Vercel build command. `verify.sh`
predicates for those three handlers were updated from `.ts` to `.js` for that
reason; the checks themselves are unchanged and green. `vercel build --yes`
reproduces the hosted build locally.

## Stateless service across function instances (2026-09-06)

The first live buy on chit.tools reached the buy route and got 401
`challenge_invalid`: create/fund/activate had run on the campaign function,
but `api/fleet/buy` is a separate function with its own memory, so it knew
neither the challenge nonce nor the campaign. Fix, without a store or a new
dependency:

- Challenge nonces are HMAC-SHA256 over the signed fields (version, origin,
  wallet, action, payload hash, issue time) under a secret every instance
  derives the same way from the operator key already in env (domain-separated
  keccak of `chit-fleet-challenge-v1|key`). Any instance verifies; a shifted
  issue time or stretched expiry is refused; replay is refused within the
  issuing instance and bounded by the 300 s TTL plus idempotency keys
  elsewhere. Without a secret the old random, instance-local nonces remain
  (`test/fleet/stateless-challenge.test.ts`, in `fleet-foundation`).
- A campaign the instance never saw is rebuilt from the chain (escrow owner
  and budget, policy session) once activated; the state is derived
  (revoked/expired/depleted/paused/active). Enrolled accounts are confirmed
  through `isEnrolled` on each buy. Before activation the policy exists only
  in the creating instance; those steps run back-to-back on one function.
- Control lands on-chain: pause/resume/revoke call the policy; close revokes
  the session and reports `returnedEth: "0"`, because only the owner can call
  the escrow's close and reclaim ETH. Deviation from the in-memory close,
  conservative option: the service never moves the owner's ETH.
- `test/fork/fleet-service-chain.test.ts` now serves buy, pause, resume, and
  close from fresh router instances that share only the secret and the chain.
- `fleet-first-buy:live` accepts `FLEET_RESUME_CAMPAIGN` + `FLEET_RESUME_ACCOUNT`
  to finish the buy for the campaign already created and funded on 46630
  (`d818c7b1-…`, account `0x37c0…d62c`).

Known gap, still: idempotency records are per instance. A retry that lands
elsewhere re-executes; on-chain settlement keys make a duplicate buy settle at
most once per reservation key, so the exposure is a second attempt, not a
double charge.

## Evidence schema for Stage 1 (2026-09-06, user-approved test change)

The dependency-evidence roles were written for the 4337 model and required a
paymaster. Stage 1 sponsors gas through the campaign escrow (operator-executes),
so the `paymaster` role is replaced by `escrow` in `EVIDENCE_ROLES`, the fixture,
the test's live record, and the `verify.sh` live loop. The committed record now
carries every contract Fleet calls on 46630 as verified with its address
(EntryPoint, escrow, Universal Router, FLEET venue) and one labelled double:
the provider, because the public testnet RPC is rate-limited and not an
operator endpoint. The record stays `mode: fixture` with the test-only claim
until an operator RPC exists; live mode also needs daily re-verification
(`maxAgeSeconds`), which is an ops step, not a code one. The test's fixture
mutations now target the venue (unverified with address) and the provider
(verified, leaving no double).
