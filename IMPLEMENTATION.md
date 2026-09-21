# Chit implementation record

## 2026-09-20 — the mainnet beta, written down before it is built

The capped mainnet beta now has a specification, a task list and machine checks: 43 requirements, 94 tasks, and eight new predicates in verify.sh that all start red and cannot be passed by anything but the work itself.

The rest of this entry is the record of what was reconciled, for whoever picks
this up next. `build-prompt reconcile` after the Spec Kit pass for
`specs/003-mainnet-beta`; Goal.md, prompt.md, plan.md and verify.sh updated, only
stale clauses touched.

**One predicate was wrong and was fixed deliberately.** `phase-4 "scaffolding
files are gitignored"` asserted that Goal.md, plan.md and prompt.md are ignored.
Commit 6072f7d deliberately tracks them, with the reason recorded there: they are
the source of truth for the product and the autonomy rules, and a second
developer cannot work without them. The predicate asserted the opposite of the
project's decision, so it had been failing since that commit. It now asserts what
the project actually requires: that all four artifacts are tracked. This is a
corrected predicate, not a weakened one.

**Clauses reconciled as stale**, each contradicted by the decision of 2026-09-19
to open a capped beta before a firm audit:

- Goal.md: the current build, the audit-before-real-funds gate, "mainnet 4663 is
  out of scope", and "testnet and test token only".
- plan.md: the stage boundary, which authorized testnet only. Mainnet writes
  remain stop-and-ask every time; the beta relaxes the opening gate, not the
  judgement.
- prompt.md: the choreography gained the beta's nine phases and lost "testnet and
  test token only"; the line saying nothing may claim "no trail" until Stage 2 is
  live was stale, since Stage 2 is live.

**Eight new `beta-*` predicates**, all red on a tree where none of the work
exists. They assert shape rather than file presence, so none of them can be
satisfied by creating an empty file, and each maps to a phase in
`specs/003-mainnet-beta/tasks.md`. The detail of what each one asserts lives
there and in `verify.sh`, both of which stay in the private repository.

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

## Privacy boundary wording (2026-09-06, user-approved test change)

FR-011's public fact "shared paymaster activity" named the 4337 component.
Stage 1 has no paymaster: the public, observable fact is the operator's gas
payments. `FLEET_PUBLIC_FACTS` and `FLEET_PRIVACY_CLAIM` now say so, and the
boundary test matches. The claim stays as narrow as before: fleet accounts,
trades, amounts, timing, gas, and the operator's gas payments are public; only
the primary-wallet-to-fleet relationship is withheld, and the operator knows it.

## Stage 2 Phase 2 — pool foundation (2026-09-07)

`FleetPool` holds every custody fact on chain, so Stage 2 needs no database and
any Vercel instance can serve any trader. Deposits and posted spend are keyed by
depositor; draws, funding, principal, and settlement are keyed by campaign; no
function or event names both, and `test/fleet/pool-abi.test.ts` asserts that over
the compiled ABI rather than trusting review.

Three deviations from `contracts/pool-contract.md`, each the conservative option:

- **`postCredit` dropped.** The interface had close release a campaign's
  remainder by reducing the depositor's `spent`. It is unnecessary and would
  double-count: a draw's amount is subtracted from the balance only while the
  draw is open, so closing restores it by itself. One fewer operator power over
  a trader's ledger.
- **Queued spend expires.** A queued spend is postable only between its `dueAt`
  and `queuedAt + POST_WINDOW` (12 h). Without it, `executeExit` would have to
  refuse while any earlier spend was unposted, which hands a vanished operator
  the power to block the exit forever — exactly the failure the exit exists to
  survive. With it, a spend queued before an exit request is always either
  posted or expired by the time the 24 h delay ends, and an unposted spend is
  the operator's loss, never the trader's.
- **`MIN_FUNDING_DELAY` added** (60 s, enforced in `openDraw`). The 1 to 15
  minute wait is what stops a deposit and its fleet funding pairing by timing,
  so the floor belongs in the contract rather than in the service that picks the
  actual delay.

The contract cannot decrypt `ownerRef` or `encDepositor`, so it cannot check
that a posting names the right depositor. That is operator trust, disclosed in
the product and auditable after the fact by anyone holding the ledger key. Also
for the audit: `_campaigns` grows without bound and the service iterates it,
which is fine at testnet scale.

`./verify.sh pool-foundation` is green; every Stage 1 `fleet-*` gate stays green.

## Stage 2 Phase 3 — the Balance page (2026-09-07)

A trader now holds one balance in the pool: deposits go straight from their
wallet to the contract (Chit is not in the path of their own money), the balance
is recomputed from chain state by whichever instance answers, and a withdrawal
is paid from the operator's wallet and only then charged to the depositor,
after a delay. A pool payout would have published depositor beside payee, which
is the one thing the stage exists to prevent.

Two things found along the way:

- **The Stage 1 wizard never signed.** `app/src/fleet-page.ts` sends a stub auth
  and expects 503, so the browser wizard on chit.tools cannot create a campaign
  even though the API accepts real signed requests (proved by
  `scripts/fleet-first-buy-live.ts`). Stage 2 adds a real browser signer,
  `app/src/fleet/signed-request.ts`: it asks the service for a challenge, signs
  the exact string the service returned, and sends the envelope, so the page
  never reconstructs the challenge format or holds the origin and chain id.
  The Balance page uses it. Rewiring the Stage 1 wizard onto it is a Stage 1
  fix, not done here, and is worth doing before any demo of the wizard.
- **`app/test/isolated-build.test.ts` needed `balance.html`** added to the files
  it copies, or the isolated build would fail on a file the build now expects.
  A fixture update, not a weakened check.

`./verify.sh pool-balance` is green; `pool-foundation` and every Stage 1 gate
stay green.

## Stage 2 Phase 4 — funding and buying from the pool (2026-09-07)

Activation now commits a draw from the balance and opens it with a due time;
any instance sweeps due draws, seeds the fleet's gas, and posts due charges. A
buy takes its principal from the pool inside the buy itself and queues the
charge against the depositor separately, so no transaction names both the
campaign and the trader. `./verify.sh pool-fund` proves the whole path on a live
EVM from instances that share only the chain.

Decisions and corrections worth recording:

- **The pool cannot simulate a buy before funding it.** The plan assumed a
  pre-flight simulation would stop a doomed buy before principal moved, but the
  fleet account does not hold the principal until the buy sends it, so the
  simulation always fails. The order is now fund, execute, then commit or roll
  back. A failed buy still charges the trader nothing; the operator absorbs the
  principal, which lands in the trader's own fleet account and is theirs to
  sweep with the owner escape hatch. Recorded as an operator-risk item for the
  audit; a state-override simulation would remove it if the chain supports one.
- **Due times come from chain time, not the service clock.** They are compared
  against `block.timestamp`, so a service whose clock is behind would open draws
  the contract refuses. Found by a fork test whose chain had travelled forward.
- **A pooled campaign's state follows its draw**, not the Stage 1 escrow. A
  fresh instance restoring a pooled campaign from the escrow's empty budget
  reported `Depleted`; it now reads the draw (`drawnState`).
- **`sessionOf` reverts before activation**, which crashed any restore attempt
  on a registered-but-not-activated campaign. Now treated as "no session".
- **The sweep reports campaign keys, not service ids.** A fresh instance cannot
  recover an id from a keccak hash and should not pretend to.
- **`topUpDraw` added to the contract.** FR-013 requires a depleted campaign to
  top up from balance and the written interface had no way to do it.
- **`contracts/fleet/FleetTestSink.sol`** is a test-only payable venue stand-in,
  so pooled settlement can be proven on a local EVM without a seeded pool.
- **The Stage 1 wizard now signs for real.** It previously sent a stub envelope
  and expected 503. It now uses `signedFleetApi`, asks for the draw, and shows
  the funding wait, so the page finally does what the API supports. The
  "No trail back to you" headline is gone, replaced by wording that is true
  today.

## Stage 2 Phase 5 — control and recovery (2026-09-07)

Closing a pooled campaign returns its unspent draw to the trader's balance and
transfers nothing: the ETH never left the pool, so there is no refund to
publish. The route already behaved correctly from Phase 4, so this phase was
mostly proving it and giving the trader somewhere to see it.

- **The pause now blocks principal.** `fundPrincipal` did not check `paused`, so
  a paused pool would still have let buys move money. FR-012 says a paused pool
  takes no deposits, draws, or buys, and now the contract agrees. A fork test
  covers all three, plus the case that matters most: the self-serve exit still
  works while the pool is paused, because that promise must survive the operator
  choosing to stop.
- **A depleted pooled campaign offers `topUp`, not just `close`.** With an
  escrow, depleted was near-terminal; with a balance behind it, the trader can
  refill without another deposit. The Control Room says so.
- **`postCredit` stayed unnecessary.** A closed draw simply stops counting
  against the balance, which a fork test checks directly rather than trusting
  the arithmetic.
- **The dashboard signs for real** and reads the live campaign instead of the
  saved snapshot, the same gap fixed for the wizard in Phase 4. It shows the
  balance, the draw, what is left, and a banner when Chit has paused the pool.

`./verify.sh pool-control` is green, as are `pool-balance`, `pool-fund`,
`pool-foundation`, and every Stage 1 gate.

## Stage 2 Phase 6 — claims and the observer proof (2026-09-08)

`test/fork/fleet-pool-observer.test.ts` runs a whole journey on a live EVM and
then reads back every log and every transaction it produced, asserting that no
log puts the depositing wallet beside a fleet account or a campaign key, and
that nothing the trader signed names either. It found a real leak on its first
run, which is the reason it exists.

- **The Stage 1 escrow was still publishing the link.** `create` registered
  every campaign in `FleetCampaignEscrow`, whose `CampaignRegistered` event
  emits the campaign key beside the owner's address. A pooled campaign does not
  use the escrow for anything, so registering it published exactly the
  relationship Stage 2 exists to hide. Pooled campaigns are no longer
  registered. Restoring one now reads its session from the policy and its owner
  from the draw's sealed reference (`chain.sessionOf`, `pool.ownerOf`), so the
  escrow is never consulted and never writes.
- **Stage 2 gets its own claim constants** rather than editing Stage 1's. The
  Stage 1 boundary test pins `FLEET_PUBLIC_FACTS` exactly, and Stage 1's claim
  is still correct for an escrow campaign, so `POOL_PUBLIC_FACTS`,
  `POOL_PRIVATE_FACT`, and `POOL_PRIVACY_CLAIM` sit alongside it and the Control
  Room picks by whether the campaign has a draw. No Stage 1 test was touched.
- **The claims check now catches claims, not mentions.** A blanket ban on
  "anonymous" and "mainnet" would have failed the exclusions list ("hidden
  trades", "mainnet sponsorship") and the landing's own disclaimer. The test
  bans "untraceable", "unlinkable", and "no trail" outright, and treats
  "anonymous", "hidden trade", and "mainnet" as violations only on a line that
  does not deny them. The `verify.sh` grep was narrowed to match, so
  "private, not anonymous" can be said where it belongs.

`./verify.sh pool-acceptance` is green, which also re-runs every Stage 1 gate.
The pool is not deployed: `deployments/fleet-46630.json` has no `pool` record,
`FLEET_POOL_ADDRESS` is unset, and the hosted service answers 503 for every pool
action until both exist. T040 is outward and waits for a go-ahead.

## Stage 2 — the sweep on a Hobby plan (2026-09-09)

The pool is deployed on 46630 at `0xce92…00c9` (recorded in
deployments/fleet-46630.json) and `FLEET_POOL_ADDRESS` is set in the host
environment. Two things surfaced when the first Stage 2 deploy was attempted.

- **The Vercel project is on Hobby, not Pro.** The per-minute cron this plan
  assumed is rejected outright, so no deploy succeeded at all until the schedule
  changed. The cron is now daily (`0 3 * * *`) and is a backstop only.
- **The opportunistic sweep was missing.** T024 called for sweeping at the start
  of state-changing actions as well as on a schedule, and only the scheduled
  half was built; the task was marked done anyway. With a daily cron that gap
  would have left fleets unfunded for up to a day, breaking SC-004. Ordinary
  traffic now sweeps: any campaign lookup and any balance read funds every due
  draw and posts every due charge, best effort, so a failed sweep never fails
  the request it rode on. A fork test covers it by funding a due fleet through
  an ordinary `read` with no sweep call at all.

The live journey has not run: the operator wallet holds about 0.0093 ETH, less
than the smallest deposit size of 0.01 ETH, so the trader side cannot fund
itself. It needs a faucet top-up before T040.

## Stage 2 — can the sweep live without a cron? (2026-09-09)

Yes, and the daily cron stays only as a backstop. Two facts make a schedule
optional rather than load-bearing:

- **Every request sweeps.** Any campaign lookup or balance read funds due draws
  and posts due charges, so ordinary use does the work.
- **The page now polls while a fleet is being funded.** That was the missing
  half: without it a trader sat on a static "Funding your fleet" screen and
  nothing swept until they navigated. The wizard and the dashboard now re-read
  until the campaign is Active, checking more often as the deadline nears
  (`pollDelayMs`). Since each read sweeps, the trader's own open page is what
  completes their activation. This is the case that actually mattered, because
  it is exactly when someone is watching.

What a long quiet period costs, if the site sees no traffic at all: a queued
charge can pass its 12-hour posting window and expire. That is the operator's
loss by design, never the trader's, and the balance shown to the trader is
correct throughout because unposted queued spend is already subtracted from
`available`. Funding is never lost either: a due draw simply funds on the next
request.

A dedicated scheduler was considered and is not needed. If one is wanted later,
a GitHub Actions scheduled workflow hitting `/api/fleet/sweep` costs nothing and
adds no vendor; a Render cron job would work equally well but introduces a
second service for one HTTP call. Moving the app itself off Vercel for this
reason would be a large change for a small problem.

## Stage 2 — testing the live configuration locally (2026-09-09)

`npm run fleet-pool:check` reports the operator, the pool address recorded
against the one configured, whether that address is a contract that answers,
whether the pool is paused, and whether there is enough testnet ETH, and then
lists what is blocking a run. `npm run fleet-pool:journey` runs the whole
journey in process against the live chain: deposit, create, activate with a
draw, wait out the delay, sweep, buy, close, withdraw to a fresh address, then
records it under `pooledJourney` in the deployment file. Neither needs a
deployment, which is the point: configuration can be proven before anything is
promoted.

It exists because the first production Stage 2 deploy answered 503 on every
pool action for a reason nothing surfaced. The function log had it:
`campaignCount()` was being called on `0x34b0…F724`, the operator's own wallet,
so `FLEET_POOL_ADDRESS` in the host environment held the deployer address
instead of the pool contract. The check refuses that case by name now, because
two addresses in the same deployment file are easy to swap and the resulting
failure looks like a service outage rather than a typo.

## Stage 2 — clicking through the real pages locally (2026-09-09)

`npm run dev:local` builds the site, assembles it, and serves the pages and the
Fleet API on one origin at http://localhost:3000, using the same handlers Vercel
runs. It takes the pool address from `deployments/fleet-46630.json` unless the
environment names one, so a local run needs no edit to `.env` and cannot drift
from what was actually deployed. `FLEET_ORIGIN` is set to the local server, and
because the browser signs the challenge string the service returns rather than
rebuilding it, signing works on localhost with no other change.

Verified: every page serves, `/api/fleet/sweep` answers 200 against the live
pool on 46630, and a challenge names `http://localhost:3000` as its origin.

## Stage 2 — why the frontend could not connect a wallet (2026-09-09)

Three wiring faults, all found by running the real pages locally rather than by
reading them. Each is now guarded by a test in `app/test/fleet-wallet-wiring.test.ts`.

- **Two owners for one button.** `initHeaderWallet` owns `#hdr-wallet` on every
  page, and the Balance page bound its own click to it as well. One click fired
  two `eth_requestAccounts` at once, which wallets refuse ("already
  processing"), so connecting failed with nothing on screen to explain it. Worse,
  a second click had the header disconnecting while the page tried to connect.
  Pages now follow the `chit-wallet-changed` event and never bind that button.
- **Nothing noticed a wallet arriving.** The dashboard read the wallet once at
  load and the wizard only through its own step button, so connecting from the
  header left both empty beside a header that said "connected". Both now listen
  for the same event.
- **`topUp` was sent to a route that refused it.** The app posts it to
  `/api/fleet/campaign`, whose allowlist did not include it, so the button
  answered 409 with no clue which side was wrong. A test now derives both the
  actions the pages can send and each route's allowlist from source and checks
  they agree, which is the class of bug that only surfaces when someone clicks
  the one button nobody tried.

Verified by driving the exact path the browser takes over HTTP against the local
server: challenge, `personal_sign`, then the action. `balance` answers 200 with
live pool state.

## Stage 2 — the wizard's launch step (2026-09-09)

Reported from a real run: the wallet had to be connected several times, and the
Launch button did nothing when clicked. Both were the wizard's.

- **Reacting to a wallet asked for one again.** The wizard's
  `chit-wallet-changed` handler called `#connect()`, which calls
  `connectWallet()`, so a wallet connected from the header immediately triggered
  a second `eth_requestAccounts`. It now adopts the address the header already
  has. The wiring test asserts the rule directly: the Balance page and the
  dashboard never reference `connectWallet` at all, and the wizard, which owns
  its own connect button, must not call it while reacting to a change.
- **Launch looked ready and silently returned.** With a zero balance,
  `#launch()` wrote a note and returned, leaving a fully-styled orange button
  that appeared to do nothing. `launchState` now drives the button's disabled
  state and its note from the same answer, the draw input revalidates as it is
  typed, and arriving at the step renders it immediately. A blocked launch also
  raises the banner rather than only a line of small text.
- **A zero balance says so.** "That is more than your balance of 0 ETH" now
  reads "You have 0 ETH at Chit. Add some on the Balance page first."

The underlying cause of the blocked launch is real and unchanged: the operator
wallet holds about 0.0093 ETH, less than the smallest 0.01 deposit, so no
deposit has been made and the balance is genuinely zero.

## Stage 2 — the wizard still asked for a connected wallet (2026-09-09)

Reported from a real run, with the server log confirming both halves.

- **Adopting a wallet did half the job.** `#adopt` set the address but skipped
  everything else the connect step does: the wallet line, `setup.connect`, and
  the move to the next step. So a trader who connected from the header was still
  shown "Connect wallet" inside the wizard. Both routes now go through `#adopt`,
  which advances only when the trader is actually waiting on the welcome or
  connect step, so adopting never yanks anyone out of a later one. The wallet
  line now also shows the Chit balance, which is the number the launch step
  depends on. A test asserts the two routes share a path and that adopting
  performs each step.
- **The zero balance was correct.** The pool held 0 ETH and no deposit
  transaction existed: the wallet had been funded on Ethereum Sepolia, not on
  Robinhood testnet, which is a different chain with a different faucet. Once
  funded on 46630 the check reports 0.509 ETH and reads ready. The Balance page
  was right; the wizard just told the trader too late and too quietly.
- **A deposit now confirms itself.** It reported "sent" and never refreshed, so
  a confirmed deposit looked like a failure. It now shows the transaction hash
  and re-reads until the balance moves.

## Stage 2 — the Balance page had no way in (2026-09-09)

The launch step told the trader to add ETH "on the Balance page", and no page
except the Balance page itself linked to it: the shared nav on the wizard, the
dashboard, and the privacy page listed only Set up, Dashboard, and What's
private. The instruction was a dead end reachable only by typing the URL, which
is why a funded wallet still showed a zero Chit balance through several
attempts. Every page now carries the link, and the launch step offers it inline.

Confirmed against the chain first, so the page was not blamed for a contract
problem: `deposit()` with 0.05 ETH estimates successfully from the trader's
wallet, and an unpublished size reverts with `SizeNotAllowed`. The contract and
the recorded address were correct throughout; the trader simply could not get
to the page that uses them.

Two tests keep it that way: every fleet page must link to the Balance page, and
the launch step must link to the page it names.

## Stage 2 — the Balance page, looked at (2026-09-09)

A screenshot of the live page showed four things at once.

- **It was never styled.** The page's markup and logic were written, its CSS
  was not, so the figures rendered as the browser's default definition list.
  It now reuses the wizard's own components (`summary` tiles, the `quickpick`
  row, `primary` and `ghost` buttons) with one added rule to let the tiles wrap.
  The dashboard's balance strip uses the same tiles. A test asserts the shared
  classes are present, so the page cannot quietly fall back to bare markup.
- **It showed only the Chit balance.** A trader who has just funded a wallet
  expects to see that number first; seeing "0 ETH" everywhere read as broken.
  An "In your wallet" tile now sits beside "Available at Chit", read through
  the wallet's own provider.
- **It blanked on every navigation.** Reading the balance requires a signature,
  and until that signature landed the figures were dashes, which read as
  "gone". The last known figures are kept per wallet in session storage and
  shown at once, then replaced by the live read. One trader's cache is never
  shown to another.
- **It announced success before the chain answered.** "Exit requested" appeared
  the moment the wallet returned a hash. On chain, no exit had been requested:
  the transaction had reverted (nothing deposited) and the page never checked.
  Every pool transaction now waits for its receipt through the wallet's
  provider and reports the receipt's status, and an exit with nothing
  deposited is refused before a transaction is even offered.

## Stage 2 — the Balance page, second look (2026-09-09)

- **Figures overflowed.** The wallet tile showed fifteen decimals. The page's
  `toEth` now caps display at six, matching the shared formatter; logic keeps
  the exact strings.
- **Tiles were uneven.** Flex wrapping stretched the second row. The tiles are
  now a grid with one column width, and the dashboard strip uses the same.
- **Every page load asked for a signature**, which reads as "connect again". A
  balance read needs a signature; a read from the last minute now stands in,
  with a Refresh button for a signed read on demand. Anything that waits for a
  deposit to land reads live, never the cache.
- **An empty account list on load was treated as a disconnect.** Some wallets
  emit `accountsChanged([])` while a page is still loading; the header dropped
  the stored wallet on it. It now confirms with `eth_accounts` before
  forgetting anything.

## Stage 2 — the wizard and a remembered wallet (2026-09-09)

A remembered wallet fires no connect event on load, and the wizard only took a
wallet up when it heard that event, so it sat on "Connect your wallet" beside a
header showing the address. On load it now adopts the remembered wallet without
moving the trader, Start skips the connect step when there is nothing to
connect, and the connect button on an already-adopted wallet just continues.
The wiring test now requires every page to take up a wallet on load, whether
directly or through a refresh that reads it.

## Stage 2 — one signature, not three (2026-09-09)

Reading the balance is a signed request, so it costs a wallet prompt. Each of
the three pages signed for it on every load, and only the Balance page consulted
the cache. Switching tabs therefore produced a wallet prompt every time, which
is indistinguishable from being asked to connect again.

`app/src/fleet/balance-read.ts` is now the only place that reads a balance: it
returns the last minute's read unless forced, and every page uses it. Switching
between Balance and Set up costs no prompt inside that minute; the dashboard
still signs once for its live campaign read, which must not be cached because
the campaign's state is what the trader is watching change. A test forbids any
page from signing for a balance itself.

## Stage 2 — why every menu change asked for a signature (2026-09-09)

The shared cached read was correct and was not the problem. The server log
showed the reads themselves failing:

```
fleet route failed ContractFunctionExecutionError: HTTP request failed.
URL: https://rpc.testnet.chain.robinhood.com/
```

The public testnet RPC was dropping requests, so the balance read returned 503,
nothing was ever cached, and the next page load signed again and failed again.
The prompt on every menu change was that loop, not a wallet or storage fault.

The cause was volume. Each request swept, and a sweep reads every draw and every
queued charge one call at a time; the balance read then walked the same state
again. A single page load could make dozens of separate HTTP calls to a
rate-limited endpoint.

- **The sweep is throttled** to at most once every ten seconds per instance
  (`createSweepGate`), which is far inside the one-to-fifteen minute funding
  wait it exists to serve.
- **The transport batches and retries**: `batch: true` collapses a page's reads
  into one HTTP call, with five retries and a longer timeout to absorb the rest.
- **The depositor record is read once** per balance, not twice.

## Stage 2 — choosing an amount is not spending it (2026-09-09)

The deposit row moved money on the click of a size, so a mis-click cost ETH.
Picking a size now only selects it, shown with `aria-pressed`, and a separate
Add funds button commits, disabled until a valid size is chosen. `canAddFunds`
holds the rule, refusing an unpublished size, one over either cap, and anything
at all while the pool is paused.

## Stage 2 — a lost campaign kept asking to be signed for (2026-09-10)

With the RPC failures gone, the log showed what was left: a signature prompt,
then `409 state_invalid`, repeated on every visit to the dashboard.

A fleet that is created but never activated exists only in the memory of the
service instance that made it; nothing about it reaches the chain until
activation opens its session. The dashboard kept the saved snapshot, signed for
a read of that campaign on every load, and got `campaign_unknown` every time.
Each of those failures cost the trader a wallet prompt and delivered nothing.
Restarting the local server, which this session did repeatedly, is enough to
lose such a campaign.

The dashboard now distinguishes that failure from a transient one: on
`state_invalid` it forgets the snapshot, shows the no-fleet view, and says
plainly that the fleet was never activated, that the Chit balance is untouched,
and that a new fleet can be started. Anything else is still treated as a hiccup
and leaves the snapshot alone.

Also confirmed from the same log: the deposit landed. The trader's balance reads
0.05 ETH deposited and available.

## Stage 2 — watching a fleet should not cost a signature (2026-09-10)

"Only after creating a fleet" was the clue. With no fleet there is nothing to
watch and the pages were quiet. With one, both the dashboard's routine refresh
and the wizard's funding poll called the signed `read` action, so every tab
switch and every poll tick, five to thirty seconds apart, raised a wallet
prompt. The cached balance read hid its own share of this and made the
remaining prompts look arbitrary.

`status` is a new unsigned action: given a campaign id it returns that
campaign's state and draw, computed from the pool and the session policy alone.
It can afford to be unsigned because everything it returns is already readable
on chain by anyone holding the campaign id, and it names no depositor; a test
asserts the owner never appears in the response. The dashboard and the wizard
now watch with it, so a dashboard load and a full funding wait cost no
signatures at all. Actions that change something, and the balance itself, stay
signed.

## Stage 2 — the balance cache was too short to help (2026-09-10)

After `status` removed the polling and dashboard signatures, one signed read
was left: the balance. Its cache lasted sixty seconds, so any browsing beyond a
minute signed again, which still reads as "asked to sign on every menu switch".

The balance cannot be unsigned. Deposits and posted spend are public on chain,
but the figure the page shows also aggregates which open draws belong to the
depositor, and that attribution is operator knowledge. An unsigned endpoint
would publish, per address, how much is committed to fleets.

So the window is now ten minutes and correctness comes from clearing the cache
whenever something actually moves the balance: a deposit, a withdrawal, an
activation that commits a draw, a close that returns one, and a top-up. The
freshness test now expresses the rule in terms of the window rather than a
hardcoded minute, since the old test pinned the value it was checking.

The dev server also now logs the action behind each request, and the action a
challenge is for, because a challenge is exactly one wallet prompt and knowing
which one is the whole diagnosis.

## Dependency proposal raised: Playwright, and a path that did not exist (2026-09-13)

Design work in this repo can be asserted but not verified. The landing proposal
in `proposals/landing-morph-2026-09-13/` carries nine acceptance checks from its
brief and five of them read "needs a human", because nothing here can render a
page. Colour audits, tag balance and parse checks are not the same as seeing the
layout land.

So `playwright` is proposed as a dev-only dependency: two packages, 18.5 MB, no
third-party transitive dependencies, browsers cached outside the repo. Not
`@playwright/test`, which would duplicate the `node --test` runner already in
use.

The cost worth knowing about is not the install. `vercel.json` installs
devDependencies on every build, so without `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
in the project environment each production build would pull about 150 MB of
browsers it never opens. That makes it two decisions, not one, and a production
env change is its own stop-and-ask.

Nothing was installed. The proposal, its measured figures and six alternatives
are in `loop/memory/STATE.md`.

That file is also new. `CLAUDE.md` names `loop/memory/STATE.md` as the place a
dependency proposal goes, and this repository had no `loop/` tree at all; it
keeps its log here and its contract in the four root files. The conservative
reading was to create the path the law names rather than file the proposal
somewhere of my own choosing, so that is what happened.

## Stage 2 — T040 live validation, the last open task (2026-09-13)

Ran the quickstart's live journey against testnet 46630 with the operator's
explicit go-ahead: 0.05 ETH deposit, five-account fleet, 0.02 ETH draw, one
sponsored buy, close-to-balance, withdrawal to a fresh address. All five
transactions landed; `npm run fleet-pool:journey` recorded every hash under a
`pooledJourney` key in `deployments/fleet-46630.json` — the implementation
writes that key name, not the `pooledBuy` name in T040's task text; the task
is marked done on the recorded evidence, not the exact key name.
`specs/002-private-funding-pool/tasks.md` T040 and quickstart.md's evidence
section are updated accordingly.

Separately, re-running the fork gates before this went live turned up that
`pool-acceptance` (and standalone `fleet-venue`) now fail. Root cause isn't a
code regression: `hardhat.config.ts:44` pins the 46630 fork to
`blockNumber: 113731448`, which is now roughly five million blocks behind the
live chain tip; the public RPC returns `-32000: metadata is not found` for
state queries at that block for addresses the venue test needs fresh state on.
Confirmed across three retries, different addresses each time, same error. The
privacy-relevant checks inside `pool-acceptance` — the observer unlinkability
test and the FR-015 claims grep — pass on their own when run in isolation.
Bumping the pinned fork block is the fix; deliberately left undone for now
since it touches shared fork config other gates also depend on.

## The brand constraint I had over-read (2026-09-13)

The landing proposal carried an open question: `BRAND-TRUTH.md` ends its
constraints with "no ... gradients, glow", and the proposed design is built from
both, so I had recorded a conflict and stopped.

The direction came back that the visual language may change while the branding
and palette stay. Re-reading the document on the back of that, the conflict was
narrower than I had written. That constraint list is scoped to the mark:
"Favicon-first vector mark; readable at 16px; one accent hue; works on paper and
ink surfaces; no letters, coins, ... gradients, glow ...". Those govern the
logo, not the site. The page was never in breach.

The masthead was. I had drawn a gradient-filled approximation of the seam mark
rather than using `brand/logo.svg`, which is the one place the rule did apply.
It now inlines the real mark, flat coral on ink.

Signal coral also reaches screen A for the first time: the live-status pill and
its dot, the reached steps on the funding timeline, and the balance delta. It
marks things that are live or have happened, which keeps it to one accent hue
doing one job.

## The fork pin is not stale, it is unpinnable (2026-09-13)

Bumped `hardhat.config.ts` from 113731448 to 118812840 and re-ran every gate
cold, with `cache/` moved aside so the machine looked like a fresh clone.

Cold, on the old pin, exactly two gates failed: `fleet-venue`, and
`pool-acceptance` because it runs every fleet gate. Ten others passed cold,
because they deploy fresh contracts and never read aged remote state. That
matches the report exactly. Every gate passed on the new pin, the full sweep
taking about three and a half minutes.

But bumping is not the fix, and the reason is worth recording. The public 46630
RPC serves state for roughly the last 6,900 blocks; past that it answers
`-32000: metadata is not found` and names its own horizon. Blocks arrive every
0.16 seconds. So the servable window is **about eighteen minutes wide**, and any
committed block number is unservable long before anyone clones the repo. The
gates were green here only because this machine had 804 cached RPC files built
up over two days, and `cache/` is gitignored, so nobody else inherits it.

That makes the fork gates reproducible only on a machine that already ran them.
A cold sweep needs ~3.5 minutes inside an ~18 minute window, which is plenty —
the problem is purely that the pin ages. Options, none taken: commit the EDR
cache (3.4MB) so a clone starts warm; fork unpinned from the tip, which the
existing comment warns the public RPC rate-limits; or point the fork at an
archive endpoint, which is a new external dependency. This needs a decision.

## What the rest of a full verify.sh run actually says (2026-09-13)

44 passed, 59 failed. All twelve fleet and pool gates are in the passing set.
The failures sort into three causes, none of them a fleet regression.

About fifty-one are the legacy Sepolia project's. `https://sepolia.drpc.org`,
the default in `verify.sh` and `hardhat.config.ts`, now answers
`chain is not available on free plan, please upgrade to paid plan`. Every
"has code on Sepolia" and "tx landed on Sepolia" check fails on that, as does
`phase-1`, whose predicate is `npx hardhat test` and so includes the Sepolia
fork suite. The contracts have not moved; the endpoint stopped being free.

One is `demo video is at most 4:00`: `submission/demo.mp4` does not exist.

Four are mine, and they are the interesting ones. `phase-4` asserts that
README.md carries the phrase "privately attributes authorized gas sponsorship",
states a public/private/trusted boundary, and lists the Sepolia EntryPoint, and
that `/Goal.md`, `/prompt.md` and `/plan.md` are gitignored. All four were true
until this session, when the README was rewritten for the fleet build and the
build-contract files were un-ignored so a second developer could read them. Both
changes were asked for. The predicates now describe the public submission's
README, not this repository's.

Left failing rather than fixed. The law says a wrong predicate gets corrected
deliberately, not quietly, and `verify.sh` has the final vote — so which of the
two is wrong here is the user's call, not mine.

## Wallet reconnect (2026-09-13)

From `chit-wallet-reconnect-fix.md`. Its section 1 diagnostic ran first against
the source, and it ruled out two of the three causes it lists.

The nonce (its section 4) was already stateless: `nonceSecretFromEnv` derives an
HMAC key from the operator key, so any warm instance verifies a challenge any
other issued. `test/fleet/stateless-challenge.test.ts` already proves it. The
only thing taken from that section is the TTL, 300s -> 600s, for the reason it
gives: signing means leaving the browser, and an expired challenge on the way
back reads as being asked to start over.

The real cause is its section 2. The connected address lived in
`sessionStorage`, and nothing ever asked the wallet who was connected. A tab iOS
discarded during the trip into the wallet app came back with empty storage and
no way to learn it was still granted, so it showed Connect. Now the address is
in `localStorage`, and `restoreWallet()` asks `eth_accounts` — the silent
question — on load and on every `visibilitychange`. `eth_requestAccounts`, the
prompt, still happens only from the trader's own click.
`app/test/fleet-wallet-reconnect.test.ts` drives the real module against a
provider that throws on `eth_requestAccounts`, so a passing test is one where no
prompt happened.

Two parts of the file were deliberately not done.

Its section 3 wants a session cookie issued after one signature verifies. Fleet
auth is per-action: every challenge is bound to the action and a hash of its
body, which is what makes a captured signature unable to authorize a different
trade. A session cookie that stands in for those signatures would remove that
binding. Not a storage change, a change to the security model, so it needs to be
asked for.

Its section 2 also covers WalletConnect, for a phone browser where the wallet is
a separate app and `window.ethereum` is absent. That is a new dependency, which
the law says to propose and stop. Nothing here helps that case yet.

`./verify.sh`: 44 passed, 59 failed, byte-identical to the run on the same tree
without these changes. The fleet and pool gates stayed green.

## The landing becomes the morph, and one predicate is corrected (2026-09-13)

chit.tools now carries the two-screen morph. The previous page's eight
explanatory sections are gone, on an explicit decision to replace wholesale
rather than port the shell around them.

Everything that was a claim or a disclosure was carried over, because that was
never the design's to delete. The hero states that trades stay public and only
the funding relationship is withheld. Screen B admits in its own copy that the
operator can still link a deposit to a fleet, and carries "Private, not
anonymous". The non-affiliation line survives and is now stronger: it names
Robinhood and Uniswap explicitly rather than saying "any of these". The contract
address and its copy control moved into the masthead rather than disappearing
with the old header.

`landing/test/landing.test.mjs` is rewritten. The assertions it lost were the
ones that pinned markup which no longer exists: the six section eyebrows, the
`.header-inner` grid areas, the `.prototype`/`.controls` selectors. Every
claims assertion survived and three got stricter. Copy is now matched against
extracted text rather than raw HTML, so the sentence is checked as a reader
sees it and cannot be satisfied by markup that merely contains the words.
"untraceable" joins the overclaim blocklist. Every occurrence of "anonymous" is
now individually required to appear in its denied form, rather than the file
merely being checked for one good phrase.

One predicate was genuinely wrong and is corrected: the motion test banned the
bare token `linear`, intending to ban linear easing, but `\blinear\b` matches
inside `linear-gradient`. It caught 37 gradients and no easing. Narrowed to
`transition: all`, `scale(0)`, `ease-in`, and `scroll-behavior: smooth`. Linear
easing stays legal for the opacity-only load ramp, which is the one place it is
the right choice.

The no-third-party-assets rule was left exactly as it was. The design was drawn
against Geist, Inter and DM Sans from Google Fonts, and permitting that was on
the table, but a page selling funding privacy should not hand every visitor's IP
to a font CDN to render the word "private". The faces are system stacks instead.

The WCAG test was re-pointed rather than relaxed: the old one measured ink on
paper, and this is a paper-on-ink surface, so it now measures the pairs a reader
actually sees. Body text 15.92:1, secondary 12.64:1, coral accent 5.88:1.

Rendered and checked at six viewports: no horizontal overflow anywhere, no
console errors, LED type rendering, morph reaching screen B. Nav now points at
pages that exist, since the anchors it used to use went with the old sections.
Not deployed; chit.tools still serves the previous page until someone runs the
deploy deliberately.

## Stage 2 — Connect reached the wrong wallet (2026-09-13)

The header Connect button did nothing on a browser with four wallets installed:
Rabby, OKX, MetaMask and Flow. Only one can own `window.ethereum`, and Rabby
won the race. It held no account, so it answered every request, even
`eth_chainId`, with `4001 wallet must has at least one account`. The app read
`window.ethereum` in four separate places (connect, signed requests, deposits,
the backup signature), so it only ever talked to Rabby and never reached the
MetaMask that held the trader's account. The two red `Cannot redefine property:
ethereum` errors in the console were the wallets fighting over that global.

Three wrong turns first, recorded so nobody repeats them. The header's click
handler did swallow every failure (`.catch(() => undefined)` into an event
nothing listened for), so errors were made visible; true, but not the cause.
The local server sent no cache headers, so a reload could run a stale build; it
now sends `no-store`, also true and also not the cause. And a Brave Wallet
theory was wrong: Rabby reports `isMetaMask: true`, which made the provider
look like MetaMask. What settled it was asking the page directly which
provider owned the global and what every installed wallet announced.

The fix is EIP-6963. Wallets announce their own providers by event; the app
collects them and, with more than one installed, asks the trader which to use.
The chooser stays open through the attempt, so a wallet that refuses says why
and the trader can pick another. Every wallet call now goes through one
`walletProvider()`, the wallet that connected, remembered per tab by rdns. Four
more defects turned up on the way: Flow Wallet answers `eth_chainId` with a
number, not a hex string; a remembered address whose wallet could no longer be
reached still showed as connected, or had its calls handed to a different
wallet; closing the chooser mid-connect discarded an approval given afterwards;
and a deposit was sent on whatever network the wallet was on, so a wallet moved
to mainnet after connecting would have sent real ETH to an address with no
pool. Deposits and exits now confirm Robinhood testnet first.

## Stage 2 reaches production, the claim follows it, and T040 goes back to open (2026-09-13)

`FLEET_POOL_ADDRESS` in the Vercel production environment held the operator
address, `0x34b0Ba...F724`, instead of the pool's. That address is an EOA with no
code, so every read of `campaignCount()` came back `0x` and the route's catch-all
answered 503 `dependency_evidence_invalid`. Sweep, challenges and balance had all
been down since the pool shipped; the daily cron had been failing silently.

The founder corrected the variable and a redeploy picked it up. `sweep` now
returns `{"funded":[],"posted":[]}` and challenges issue. Worth recording that my
own probes were malformed throughout the investigation — they sent `owner` where
the service reads `primaryWallet` — which made the challenge endpoints look
broken after the fix when they were not. The environment bug was real and is
proven by sweep alone, which changed behaviour on nothing but the address.

With the pool actually serving, the hero moved from the Stage 1 narrowing to the
FR-015 claim: "Your main wallet never funds your fleet. The chain shows a deposit
into Chit and fleets funded by Chit, and no transaction links the two." The two
honesty lines that sentence replaced were kept rather than dropped, so trades
stay public and the withheld relationship are both still stated, and screen B
still carries the operator admission and "Private, not anonymous". The eyebrow
changed from "Stage 1 live" to "Private funding pool live", and the gate now
asserts the FR-015 wording so it cannot quietly regress.

T040 is re-marked open. Its predicate names chit.tools, and the hosted service
could not reach the pool at all until today, so the journey that was recorded
ran against a local service pointed at the live chain. What it genuinely proved
is kept in the task: three transactions confirmed successful on 46630, deposit,
sponsored buy and withdrawal. What it did not prove is the hosted path. Done
means the predicate passed, and this one names a host it never touched. It is
now unblocked and can be closed by re-running against chit.tools.

## App redesign, step 1: the landing's look, tuned for an app (2026-09-14)

The four app pages now wear the landing's look: ink surfaces, glass and warm
cards, LED dot figures, pill tags, the landing's masthead and its motion rules.
Design: `design-app-redesign.md`; plan:
`docs/superpowers/plans/2026-09-14-app-redesign-step1.md`. This replaces the
fleet pages' "Soft Receipt" styles and the older "Public Docket" direction;
journeys and screens from `design.md`/`design-stage2.md` are unchanged.

The old stylesheet was wrapped in a lowest-priority `legacy` cascade layer and
shrunk task by task as new `tokens`/`components`/`pages` layers replaced it, so
no page was ever unstyled and no commit passed 200 lines. It is now gone:
`app/fleet.css` is a four-line manifest, and removing the last of it changed no
pixel on any page at 1600 or 390 wide. The app is dark-only like the landing.
Coral marks only what is live or has happened and primary buttons are paper, as
the landing's are; a test enforces the coral rule. The status pill shows the
pool's state only from the cached balance read, so it never costs a signature
and never asserts "live" unread. Revoke and Close now confirm in a dialog first,
and a dialog that fails to open reaches the error banner instead of vanishing.

Looking at the rendered pages found what the tests did not. Author rules that
set `display` beat the browser's own `[hidden] { display: none }`, so the empty
status pill showed on every page and the Control Room showed its fleet controls
with no fleet. One global `[hidden] { display: none !important }` in the
components layer ends that class of bug. The top bar was boxed into a 72rem
column, which left the wallet button short of the top-right; it now runs edge
to edge like the landing's, and everything below it shares one column.

Two ideas were tried and reverted at the user's request, and are recorded so
nobody rebuilds them: a landing-style live panel beside Set up (a warm wash
with a fleet-policy timeline), and the welcome promises as tiles in a row. The
panel's review also found its text at 2 to 3.3:1 contrast on glass over the
light wash, below the 4.5:1 this app holds text to. Then, from the user's
reference screenshots, a fit pass: labels in mono capitals tracked out, titles
sized to their card rather than the page, figures as label-and-value rows
instead of boxed tiles, and the Boundary blocks in one column so each is as
tall as its own text.

Two defects predate this work and are still open. After Launch the wizard goes
straight to its last screen, which hides the launch step, so its funding gauge
and "Funding your fleet" line are never seen. And an empty or half-typed draw
amount makes the launch step throw, leaving the button in its last state.

Evidence: `npm run app:shots` renders every page at 1606x1161, 1440x900,
1024x1180, 390x844, 320x640 and 1440x900 reduced-motion with no overflow and no
console errors, scrolling each page first so its once-only reveals are shown;
the 1440 and 390 shots are kept in `app/evidence/`. They show the pages without
a connected wallet; connected states were looked at by hand on localhost, not
scripted.
## The fork block is chosen at connect time, so a fresh clone is green (2026-09-14)

The 46630 fork pin in `hardhat.config.ts` was the wrong mechanism, as the
2026-09-13 entry recorded: the public RPC keeps state for about 6,900 blocks
and a block lands every 0.16s, so any number committed there is unservable
eighteen minutes later. `fleet-venue` was green only on a machine with a warm
`cache/`, and `cache/` is gitignored. A fresh clone failed with
`metadata is not found`.

The pin is gone from the config. `test/fork/robinhood-fork.ts` asks the RPC
for the tip when the test connects and passes `tip - 64` as a per-connection
`override.forking.blockNumber`, which Hardhat 3 accepts on `network.connect`.
The fork is still pinned for the length of the run, so EDR caches remote state
and does not burst the RPC, but the number never rots. The block chosen is
printed, and `ROBINHOOD_FORK_BLOCK=<n>` replays that exact fork while the RPC
still serves it, which is how a failing run gets reproduced.

Evidence, on a clone with no `cache/` directory, Windows, Node 24:
`fleet-venue` passes in 34 seconds at block 119431961. The control,
`ROBINHOOD_FORK_BLOCK=118812840` (the old pin), fails in two seconds with the
old error. `pool-acceptance`'s pieces pass here too, observer test, landing
suite, claims grep, `fleet-foundation`, `pool-foundation`, with one exception
that is the machine and not the code: `app/test/isolated-build.test.ts` creates
a symlink, which Windows refuses without developer mode, so every gate that
includes `npm --prefix app run verify` reports red on this box. That test is
untouched and passes on macOS.

Nothing else changed. The venue test's body is the same; only how it opens the
fork.

## FleetPool pre-audit: eight findings, each with a test, and six invariants (2026-09-14)

The professional audit is the gate before real money. This is the work that
makes that audit shorter: a read of `FleetPool.sol` against a written threat
model, a unit test per finding that reproduces it on the contract as deployed,
and an invariant suite that states what "the operator's ledger is right"
means and holds it under 256 random sequences. Report in
`docs/audit/2026-09-14-fleet-pool-pre-audit.md`; tests in
`test/fleet/FleetPool.t.sol` and `test/fleet/FleetPoolInvariants.t.sol`,
Solidity, forge-std, run by `npx hardhat test solidity`. No contract, service
or app code changed.

The two that matter. F3: a failed buy leaves the principal in the trader's
fleet account and the operator refunds the pool from its own wallet, which
the service comment already says; a trader who can make a buy revert is paid
the principal each time, so funding and execution need to be atomic before
mainnet. F2: draws are bounded per campaign and by nothing else, so the
operator key can empty the pool; that is the disclosed design, and the report
asks for a guardian that can only pause, then a multisig operator, and for the
disclosure to say custody, not only visibility. Three one-line reverts close
F1 (a deposit after requestExit is lost), F4 (commit below principal) and F5
(a queued spend born outside its window). F7 is service-side: nothing refuses
draws or buys for a depositor whose exit is pending.

What held: checks-effects-interactions everywhere, every cap, claimable as
gas only, the exit with the operator gone, bills posted during the wait. The
accounting identity and honest-operator solvency hold as invariants. The
fuzzer's one catch was in my own invariant, which double counted rollbacks;
`totalOutflow` is already net of them.


## Trading panel, plan 1: fleet buys as browser-held orders (2026-09-15)

Design: `docs/superpowers/specs/2026-09-15-trading-panel-design.md`. The service
gains five signed actions. `tokenQuote` reads a token's venue pool price straight
from the PoolManager's storage (`extsload` at StateLibrary's slot 6) with its
symbol and decimals; checked live, the seeded FLEET token quotes with a pool and
an unknown address without one. `order` validates a fleet buy (the token has a
pool, the total fits the fleet's remaining draw, every slice fits the session's
trade cap, the wallets are enrolled) and returns a plan: one slice per wallet,
sizes within ±35% of the average, due times spread across a window that grows
from five minutes at five wallets to thirty at fifty, all derived from entropy
the browser chose. `trade` executes the due, still-pending slices of an order the
browser holds and re-sends, one slice at a time through the same pooled-buy path
a plain buy uses. `list` returns the fleets an owner holds; `holdings` reads each
fleet wallet's ETH and the tokens the browser asks about.

Two things the user approved were changed by what the code enforces. Sells are
out: the on-chain `FleetSessionPolicy` allows one router and one selector per
fleet, and a sell needs a token approval first, so selling waits for a policy
change and a redeploy. And orders live in the browser, not on the service: the
fleet path keeps no state between requests, so the order is signed once, kept by
the browser, and driven by the open page the way funding already is. Its plan is
reproducible from the entropy; a per-instance guard and the browser's own pending
list keep a slice from running twice, and the accepted worst case across
instances is one repeated slice, itself under the trade cap.

Three things the fork test found. The wire field could not be called `seed`: the
wallet-recovery guard refuses any body carrying that name, so it is `entropy` on
the wire and `seed` inside. A fresh service instance restores a fleet from chain
without its accounts and refused every order as `wallets_not_enrolled`; it now
asks the factory's own event, as a plain buy does. And pooled fleets are never
registered in the Stage 1 escrow, on purpose, because that registration publishes
the owner beside the campaign key, so the fleet list cannot come from escrow
events alone: it unions those Stage 1 fleets with the pool's draws whose sealed
owner reference opens to the caller, read operator-side, publishing nothing. The
`fleet-trade` gate runs a five-slice order on a fresh chain across two service
instances and two polls.

## Trading panel, plan 2: the Trade page (2026-09-15)

A trader pastes a token address, sees whether the venue has an ETH pool for it and
roughly what the total buys, enters a total, and reads the plan: how many wallets,
about how much each, over about how long. Placing the order confirms in a dialog and
signs once. From then on the open page drives it: on each poll the browser marks the
due slices as sent *before* asking the service to run them, sends only those indices,
and settles each from the reply. A reply that never comes leaves those slices
"unconfirmed", never re-sent, and settled against how much the fleet's remaining draw
fell in the meantime. A rejected slice retries twice, then fails. Orders live in the
browser under `chit-orders:<owner>`; the service lists nothing. Slice hashes show as
text with a Copy button, because no block explorer for this testnet is recorded
anywhere in the repo and the page adds no external link. The page says trades stay
public and never sells volume: the stagger hides who funded the fleet, nothing else.
`order` and `trade` now refuse while the wallet's exit is pending. Two things are
true and worth knowing: polls never overlap (a timer tick and a freshly placed order
queue behind each other, and each order is re-read before it is touched), and every
`trade` poll asks the wallet for one signature, because every state-changing action
is signed. Letting `trade` ride on the order's own signature would remove those
prompts and is a service change for later.

Two constraints bent, both on the record. The isolated-build test lists every page
it stages by name, so a new page cannot exist without one line in it; that line was
added in its own commit. And `trade-page.ts` landed as one 500-line commit, over the
200-line cap: a single new file, where partial commits would be states that do not
compile. The render check now covers the Trade page at every viewport, and connected
with a running and a finished order seeded.

## Gas sponsorship spike, on a fork (2026-09-15, advisor)

The proposal in `proposals/gas-sponsorship-2026-09-15/` asked for a one-day spike
before anything else. It ran the same day on a fork of 46630 and touched nothing
deployed: a throwaway SimpleAccount v0.7 (the canonical factory is live on the
chain) that had never existed and held no ETH made a sponsored call through
`FleetPaymaster`, settled against a fresh `FleetCampaignEscrow` budget, with the
operator bundling `handleOps` itself; then a second call from the same account;
then a forged sponsorship, refused by the EntryPoint before the account existed
or the budget moved. `src/fleet/sponsored-op.ts` builds the op, both from
`test/fork/sponsor-spike.test.ts` and from `scripts/sponsor-spike-live.ts`, which
lands the same steps on the live testnet and records them under `sponsorship` in
`deployments/fleet-46630.json` (dry-run against a local fork node; the live run
needs the operator key). `FleetSponsorProbe` is the test target, a call that
moves no value. No route, no page, no contract that is deployed changed.

Three things the spike settled that the proposal could only assume: the sender
type (smart account, deployed by its own first sponsored operation); that the
deployed fleet escrow cannot serve, since it predates the settler role; and what
the budget really pays, which is the cost the EntryPoint reports to `postOp`,
95% to 98.5% of the operator's outlay, the rest being `postOp`'s own gas and the
unused-gas penalty that a fee must clear. Measured gas: 402k on the bundler
transaction for the operation that deploys the account, 198k after. The
proposal's earning estimate was rewritten from these numbers.

Two fork quirks, for whoever runs it next: EDR refuses an `eth_call` on a fresh
fork until one block is mined ("no known hardfork for execution on historical
block"), so the test deploys before it reads and a local `hardhat node` fork needs
one `evm_mine` first; and the bundler transaction has to be priced like the
operation, or the refund at the operation's price does not match what the bundler
paid at the node's default.

## The hackathon layer is retired (2026-09-15)

The repo carried two products. The first, a confidential ERC-4337 paymaster on iExec Nox for Sepolia, was the hackathon entry; the second, Chit Fleet on Robinhood Chain, is the one that is live. The first still owned the front door: `/app/` served "New sponsorship round", the hackathon's page, while the real app sat at `/app/fleet.html`. Today the hackathon is gone from this tree: its six pages and their tests, `spikes/`, the seven `Chit*.sol` contracts, the twenty-two service modules and their tests, the four API routes, five live scripts, nine Sepolia deployment records, the Nox plugin and Sepolia fork in `hardhat.config.ts`, and the six `verify.sh` phases that checked them against Sepolia. `/app` now lands on the fleet wizard, locally and on Vercel. Nothing under `src/fleet`, `api/fleet`, `contracts/fleet`, `test/fleet` or `test/fork/fleet-*` imported any of it; the Fleet suites are unchanged and green. The public hackathon repo, `ajanaku1/chit`, keeps the code and its history.

Two checks in `verify.sh` were already red before this change and were left alone: "scaffolding files are gitignored" and the app's `npm run build`, which fails on the store work in flight in another branch, not on this one.

## Audit fixes, round one: service guards on main, contract one-liners on a branch (2026-09-15)

Three commits on `main` close the service-side findings that needed no
redeploy. `pool-buy.ts`: the sweep posts charges first and funds each draw in
its own try (A3), skips a draw below its own headroom (A3), charges the seeded
headroom to the depositor (A1), queues a withdrawal's charge before paying it
(A12), retries a failed commit after a mined buy instead of rolling it back
(A11), bounds the execute transaction by the gas ceiling (A9), and keeps the
delay floor above the contract's (A37). `campaign-routes.ts`: a wallet whose
exit is pending gets no draw, buy or withdrawal (F7); a buy re-reads the
session from the chain and refuses on paused or revoked (A14); withdraw,
activate, top-up and buy are serialized per wallet and activate re-reads the
balance after the chain activation (A5, A6); a draw below its minimum, a token
outside `FLEET_TOKEN_ALLOWLIST`, a malformed account list and a gas ceiling
below the floor are refused (A3, A8, A41, A9). `service-runtime.ts`: every
configured address must hold code, checked once at boot, refused with a named
reason after (A33); the catch-all logs an error's first line only (A63).
Tests: `test/fleet/pool-sweep.test.ts`, `test/fleet/money-route-guards.test.ts`;
the pooled funding fork test now expects the headroom charge.

`audit/contract-fixes` holds the contract changes, which need a redeploy on
46630 and are the founder's call: `deposit` refuses a wallet whose exit is
pending (F1), `commit` refuses an amount below the principal that left (F4),
`queueSpend` refuses a `dueAt` beyond `POST_WINDOW` (F5), and `paused` now
gates `fund`, `topUpDraw` and `claimOperator` too (A36), so a guardian that
can only pause would actually stop the money. The pre-audit tests for F1, F4
and F5 assert the refusal now; F2 and F3 still pass as reproductions. The
spec's error list matches the contract again (A67, partly).

Later the same day, two more. On `main`: charges are posted in coarse units,
rounded down to a grain of 0.00001 ETH and always strictly below the exact
amount, so the wei value in `Committed` never reappears in `SpendPosted`
and a withdrawal's payout never equals its charge (A4 and A30, the amount
half; the grain is the pool's). On the branch: a `guardian` the operator
sets, which can call `pause()` and nothing else; only the operator unpauses
or changes it (R2a from the pre-audit). No constructor change, so nothing
in the deploy scripts moves.

Still open, and wanting the founder in the room: the time join (a charge is
queued in the operator's next transaction after the buy; breaking that needs
the contract to carry uncharged spend until a sweep batches it), random
queue ids, and a multisig operator (F2, F8).

## The atomic buy: funding and execution in one transaction (2026-09-15)

F3 and A22 were the same defect from two sides: the service sent the
principal in one transaction and executed the buy in another, so a buy that
reverted left the principal in the trader's own account and the operator
refunded the pool from its wallet; and between the two transactions the
account's owner could take the principal with the escape hatch. Both gaps
were the gap between two transactions. Now there is one.

`FleetPool.fundAndExecute` sends the principal and calls the account's
`execute` in the same call; a revert anywhere reverts the funding too. The
draw is charged principal plus the gas measured around the inner call,
capped by the ceiling, so the reservation, the commit and the rollback have
nothing left to do. `FleetAccount.execute` admits the pool as a caller
through `FleetSessionPolicy.pool()`, which the operator sets once with
`setPool`; the deploy script does it right after deploying the pool. The
service's `settle` is one write and reads the charge back as the draw's
spent delta.

Tests: `test/fleet/FleetPoolAtomic.t.sol` (a buy lands and is charged
principal plus measured gas; a reverting buy moves nothing and leaves no
reservation; the owner has no gap to act in; only the policy-named pool may
execute; pause and the draw cap hold). The pool fork tests set the pool on
the policy in their setup. 26 Solidity, 53 fork, 169 unit, green.

Three contracts change bytecode, so this is a redeploy of the pool, the
policy and the factory on 46630, in that order, then `setPool`. The old
`fundPrincipal`, `commit` and `rollback` are still in the contract for the
Stage 1 shape and unused by the service; they should go once the atomic
path is live, and the pre-audit's F2 and F3 tests with them.

## Operator hardening: the store, the batch, the hash, the admin (2026-09-16)

Four items handed back after the atomic buy, built on `feat/operator-hardening`
on top of `audit/contract-fixes`. They are one problem: a single hot key on
stateless instances whose transaction pattern leaked the link the pool hides.

**The store** (`src/fleet/store.ts`, `store-neon.ts`). Idempotency results,
challenge-nonce burns, executed-slice claims and the serialization of money
operations lived in per-instance `Map`s; a retry that landed on a second Vercel
instance saw none of them, and two instances signing together collided on the
operator's nonce. They are now behind one port with a memory adapter (the old
behaviour, the default without `DATABASE_URL`) and a Neon adapter where every
guard is one atomic statement and the operator lock is a lease. The two-instance
fork test now sends the second instance the *full* pending list and still gets
every slice once; without the shared store it runs them twice (checked).

**The batch.** A buy's charge used to be `queueSpend`, the operator's next
nonce, seconds later; `README.md:68` admitted the join. `charge()` now records
owed spend in the store and sends nothing; the *scheduled* sweep queues
everything owed in one `queueSpendBatch`, shuffled, each entry on its own
random timer. The opportunistic sweep that rides on trader requests never
queues, or the batch would sit beside that request's buy. The balance subtracts
owed spend at once (`owed` on the balance view), so nothing reads as available
that a charge already claims. `queueSpend` is gone from the ABI.

What this does and does not do, plainly: a charge no longer follows its buy in
time or in the same window, and on a busy pool a batch mixes many depositors.
On a quiet pool with one trader the batch is still the operator's next
transaction, hours later; the observer test asserts the gap and the single
batch, not nonce distance, because nonce distance is not a promise we can keep
at low volume. Exit safety in numbers: owed spend waits at most one sweep
interval to be queued, then at most `POST_WINDOW` (12 h) to post; at two sweeps
a day that sums to `EXIT_DELAY` with zero margin. The plan sets the cron to every
four hours. The Vercel plan is Hobby, whose crons run at most daily, so the
cadence lives in `.github/workflows/sweep.yml` (every four hours, plan
independent) with the two daily Vercel crons kept as a fallback. Because the
scheduled sweep now picks the batch's moment, `GET /api/fleet/sweep` honours
`CRON_SECRET` when set (`src/fleet/sweep-trigger.ts`); unset, it is open as before.

**The hash.** Queue ids were `_queued.length`, so the k-th posting was the k-th
queueing was the k-th buy. Ids are now `keccak256(entry, prevrandao, position)`,
`postQueued(bytes32)`, `queuedSpendAt(i) → (id, entry)`.

**The admin.** `operator` was `immutable` on the pool, the policy and the
factory; rotation meant redeploy, and the only key was hot. `FleetPool` and
`FleetSessionPolicy` are `Ownable2Step`: the owner is a cold admin that rotates
the operator, unpauses, names the guardian and claims gas; the operator moves
money and nothing else; `pause()` is guardian, operator or admin. The factory's
operator stays immutable (rotating it changes every predicted account address).
The deploy scripts require `FLEET_ADMIN_ADDRESS`, refuse the deployer's own
address, deploy with the deployer as owner so `setPool` can run, then offer
ownership to the admin, who accepts with one transaction per contract.

Tests: 190 unit, 41 Solidity (26 → 41), the pool fork suite green with the
observer's new gap assertion. `1291cd6` (retire the hackathon layer) had
removed `ChitCounter`/`ChitToken`, which five Stage 1 fork tests still
deployed; they were test fixtures, not product, so the counter is back as
`contracts/fleet/FleetTestCounter.sol` and the token test uses
`FleetVenueToken`. `fleet-foundation` is green again.

Still to do with the founder present (plan, phase 5): the second redeploy on
46630 with `FLEET_ADMIN_ADDRESS` and `DATABASE_URL`; the cron cadence once the
plan is confirmed; FR-012, SC-005, plan/research/data-model and the README
sentence, written only after the redeploy passes; tasks T041–T046 so the
progress sheet moves on their gates; the landing's Draw Cap sheet to
`fundAndExecute`; and dropping `fundPrincipal`/`commit`/`rollback` after T040.

## CHIT buyback and burn, a contract and not a wallet (2026-09-16, advisor, branch feat/chit-buyback)

Tokenomics only, proposed to the group and not deployed: `ChitBuyback.sol`
takes ETH by plain transfer, and anyone can call `buyAndBurn`, which
spends 1% of the balance (floor 0.002, cap 0.1 ETH) no more than hourly,
quotes the buy from the pool's own state on chain, refuses a fill more than
5% under it, buys through the Universal Router and calls `burn()` on the
token. No owner, no withdraw, no parameter that changes. On a fork of
mainnet against the live CHIT pool: 0.01 ETH bought 177,001.70 CHIT, the
hook took exactly 2.00%, the supply fell by the burn; the floor, the cap,
the interval and the guard each proved. A keeper workflow calls it hourly,
the daily post reads the day's events and the contract's counters, a deploy
script checks the pool id and a price before recording. The team's rule for
what goes in (10% of fees, one point more per 100k of mcap) stays the
team's, posted as a promise; a fee splitter can automate the deposit later.
`docs/chit-buyback.md`.
## Chit Bot, the testnet playground (2026-09-16, advisor, branch feat/chit-bot)

The Telegram trading bot, the card every degen knows, on a chain that has
no such bot. Playground mode, testnet: /start makes the user a wallet and
funds it from a faucet; Buy and Sell go through the real Uniswap v4 router
with a quote from the pool and a 3% guard; Positions, Withdraw, Faucet
(once a day), /pool in the group. The bot holds the playground key and says
so on the card; it can because the key holds test ETH and nothing else. Keys
are sealed at rest under a host secret in a store shared across instances
(memory or Neon). On mainnet the runtime refuses to start: there the bot
holds nothing, and the same buttons drive a session on the user's own
account through session keys. `docs/chit-bot.md` says all of it, including
the line against Trojan: speed without the key.

Handlers are pure over three ports and have seven conversation tests
against fakes; the chain adapter has a fork test against the live router
(faucet, quote, buy, sell, send). On the way, two things the fleet needed
anyway: the sell side of the v4 encoder with the Permit2 approvals
(`encodeV4TokenSell`, `sellApprovals`, a fork round trip), and an exact-in
quote with fee and price impact (`quoteExactIn`, from the pool's
liquidity) that `market.tokenQuote` now returns instead of the spot
estimate. The spot estimate tripped the slippage guard on the testnet venue,
where one buy is a tenth of the liquidity; on the fork the exact quote
matched the fill to the wei. The service's pooled buys inherit the fix.

## Chit Bot, buttons all the way, and the fleet from the chat (2026-09-16, advisor, branch feat/chit-bot)

The playground grew into the bot people expect: a card with buttons, a
reply field that opens when a number or an address is needed, and a token
card for any contract address pasted into the chat. Any token with an ETH
pool on the venue trades; settings hold the user's amounts, shares and
slippage, a confirmation step and sell protection; positions show what each
holding would fetch now; withdraw walks through a prompt and preset shares;
referral links count and promise nothing. The card still says whose key it
is and why that is fine on testnet.

The Fleet card drives Chit's own product from the chat: deposit into the
pool from the wallet, create a fleet of five with sealed keys (the service
sees addresses and salts), activate with a draw, buy from every wallet,
pause, resume, close, pool balance. `bot-fleet.ts` is the driver over the
hosted service's routes with the challenge flow signed by the playground
key; the test's fake service recovers every signature to the wallet and
refuses a tampered one. Eleven conversation tests, one fork test of the
adapter against the live router. `BOT_FLEET_OFF=1` hides the card until the
service is wired to the pool.

## Chit Bot audited and hardened before its first deployment (2026-09-16, advisor, branch feat/chit-bot)

Ten-lens audit of the bot (`docs/audit/2026-09-16-chit-bot.md`), every
finding fixed on the same branch. The webhook now requires its secret and
the runtime refuses to start without it, so a forged update can no longer
drive any wallet by Telegram id. Keys are sealed under a scrypt-derived key
with AES-GCM associated data binding each blob to its Telegram id and
purpose; the fleet record is sealed whole; the blob names its sealing key
and a canary row stops a rotated secret before it makes unopenable wallets.
The store never writes a whole row from a stale object: settings, tokens
and the fleet are patched by column, the faucet stamp is claimed atomically
with a daily budget across everyone, Telegram update ids are claimed once,
and one lock per wallet serialises money across every function instance.
Every button fits Telegram's 64 bytes (amounts travel as wei), every reply
prompt names its token or address, the card's buttons never carry the
confirmed verb, fleet phases follow the service's state names, create and
activate are one tap, idempotency keys come from the tap, a receipt that
does not arrive is reported with its hash, the swap deadline is wall-clock,
approvals are sent only when short, and the copy holds to FR-015 and to
"mainnet is next, not live". The Neon schema is applied one statement at a
time (its HTTP driver takes exactly one), and the store's contract runs on
the memory store, on the Neon store over PGlite, and on Neon when a scratch
database is named. Thirty-four bot tests plus the fork test.

## Chit Bot: share cards, and the bot remembers its trades (2026-09-16, advisor, branch feat/chit-bot)

A 📸 button on Positions draws the position as a picture: the symbol, the
change as one big number, what was paid, what the pool would fill right
now, and the poster's referral link, so the card that gets posted brings
the next person into the bot. To know what a position cost, the store now
keeps every trade the bot makes (`bot_trades`, keyed by tx hash so a
redelivered update never records one twice; the memory store the same);
a sale is recorded as what it left in the wallet after gas, so a card's
number errs against the poster. Tokens that arrived any other way have no
cost the bot knows and get no card. The card is SVG on the chit brand over
a plate of the mark blown into shards (`landing/public/bot/share-bg.png`),
set in IBM Plex from `landing/public/bot/fonts`, rasterised with resvg on
the spot and uploaded from its bytes; `vercel.json` ships the assets with
the function, and a missing plate or font is an error, never a card in a
fallback face. Tests: the flow from a buy to a card and back through a
sale, the refusals, the store contract on memory and PGlite, and a real
render checked for its PNG header and the plate's size.

## Fewer wallet prompts, and trades that run on the order's signature (2026-09-16, branches fix/fewer-wallet-prompts, feat/order-token)

Testing Chit end to end turned up prompts nobody needed. After a deposit,
exit request or claim, the Balance page re-signed for the balance every three
seconds until it moved, and went on asking after the trader refused; it now
watches the pool's public `depositorOf` record, which costs nothing, and signs
once when it moves. A withdrawal returns the whole balance, so showing it is
not a second signature. A token quote is kept for a minute, so typing then
leaving the field no longer asks twice, and placing an order reuses the
page's holdings read instead of signing for the wallet list. Every prompt
that remains puts a line on the page first saying what it is for, and that
signing is free and sends nothing.

Setup lost everything held in memory (fleet keys, backup, a half-made
campaign) when its "Add ETH on the Balance page" link replaced the page. The
wizard's Balance links now open a new tab, the launch step can re-check the
balance on request, an empty balance is named on the Size step before
anything is created, and each step says how many signatures it will ask for.

The change asked for in the Trade page entry above is now made. A signed
`order` returns an order token, an HMAC under the nonce secret over the
order id, its owner and the issue time; a `trade` poll may carry it instead
of a signature, for 90 minutes. This is not the session cookie refused
earlier: the token speaks for one order the trader signed, whose id is a
hash over every field, and the route still recomputes that id, checks the
owner, runs only due and pending slices, and claims each once. Only a
`401 challenge_invalid`, which is raised before any slice is claimed, sends
the page back to signing; a lost reply is never re-sent. A trade that bought
something also returns the fleet's holdings, so the tile updates without the
signed re-read that had been added to every poll. An order used to cost a
prompt to place it, one for every poll that sent slices, and one more per
poll for holdings; it now costs the one that places it.

## The landing's app buttons go to the app (2026-09-16, landing)

Launch app and Open the app opened the build-progress sheet, and the landing
said the app was in private testing and ran locally only. The loop runs end
to end on chit.tools now (deposit, fleet of five, launch, a sponsored order in
five slices), so both buttons are links to `/app/fleet.html`, the wizard, and
the hero says testnet and test ETH instead. The progress sheet stays at
`#progress`, unlinked. Two predicates in `landing/test/landing.test.mjs`
changed deliberately with the requirement: the landing must now link into the
wizard (and only the wizard; Control Room and Balance are reached from inside
the app), and must not call the app private.

## No wallet popup until the trader clicks (2026-09-17, branch fix/no-popup-on-load)

With "Open the app" now landing on the wizard, a remembered wallet met a
signature request before anything was clicked: the wizard read the balance as
it took the wallet up, and Balance, Trade and the Control Room did the same on
load, the Control Room again whenever its funding poll outlived the cached
read. The line explaining the prompt was there; the prompt still read as a bug.

No page signs while it loads now. A recent cached answer shows; what is public
is read without a signature (the wallet's own ETH, a campaign's status, the
pool's deposit record); anything else waits behind a box that says why it is
private and a button that opens the wallet. The wizard reads the balance when
the trader clicks through to Launch, and still warns about an empty balance
on the Size step: the unsigned quote now names the pool, and a wallet whose
public deposit record is zero has nothing to launch with. The Control Room's
balance shows a dash until read, not a zero nobody measured.

Background trade polls never open the wallet either. When an order's token is
refused (the tab was closed past its 90 minutes, or the order predates tokens)
the poll does not sign: its slices go back to pending without counting an
attempt, and the order shows "Sign to continue". That signed poll returns a
fresh token, added outside the stored idempotent result, so the polls after
it need no signature. A signature the trader refuses is reported as not sent,
never as a lost reply, so its slices are not reconciled as failed.

## The wallet menu says which wallet, which network, and how much (2026-09-17)

The connected header button opened a bare list: the address, Copy, Disconnect.
It now opens what a trader checks before doing anything. The wallet carries a
mark drawn from its address in the app's LED dots (paper tones only; coral
stays for what is live), on the button and at the head of the menu, beside the
wallet app it came through (its EIP-6963 name and icon) and the full address.
Below that, the network: live when the wallet is on Robinhood Chain testnet,
otherwise a warning with Switch network. Then the wallet's ETH, read only once
the network is right so another chain's balance is never shown as testnet
ETH, and the Chit balance from a recent read or else a link to Balance.
Switch wallet appears only with more than one wallet installed. Nothing in
the menu signs. On the narrowest phones the header's gaps tighten and the
chevron goes, so brand, wallet and menu button still fit on one row.

## The token address reads as the CHIT token, shortened, and still copies whole (2026-09-17)

The header row on the landing and every app page said "CA", printed all 42
characters, and ended in a boxed COPY. It now says "CHIT token" and shows
`0xD523A6…3E50D8`. The middle of the address stays in the text, hidden only
visually, so the copy button, a manual selection and a screen reader all get
the whole address, and hovering shows it in full. The button carries a copy
icon that turns into a check with "Copied", and the status line announces
"CHIT token address copied." Both test suites now check that the shortened
markup still spells the full address.


## Production follows main (2026-09-17)

Until today chit.tools moved only when someone ran `vercel --prod`, so a push
to `main` could sit unshipped for hours and a dev's local build was ahead of
production without anyone noticing. The Vercel project is now linked to
`ajanaku1/chit-fleet` with `main` as the production branch: every push to
`main` builds and deploys; every other branch gets a preview URL. The
`.vercelignore` keeps recordings and the build contract out of the upload,
and `vercel.json` still runs `scripts/assemble-site.mjs`. `vercel --prod` by
hand still works and is now the exception, not the way.

## The Chit balance is hidden or shown the same way on every page (2026-09-19)

A trader filmed it: the Control Room asked for a signature to show their
balance while the header menu showed it, and the Balance page showed it with
no ask at all. "If it's hidden, let's hide it in all. If it's displayed, let
it be displayed." One rule now decides, `showableBalance`: a signed read kept
in this tab and still inside the ten-minute window may show without signing;
anything older shows nothing and the page asks. The wallet menu, the Balance
page and the Control Room all ask it and only it. The Balance page no longer
paints an expired read above "Show my balance". The Control Room no longer
keeps a balance it read once after that read ages out or a top up clears it,
and its ask names only what is hidden: "Show holdings" sits by the wallet
list it reveals, not under the balance. Its gas budget card now reads the
fleet's live draw, so it no longer says 0 spent under a strip that says
0.001211.

## Session keys, built (2026-09-16, advisor, branch feat/session-keys)

The roadmap's "session keys as a product": a bounded key with a kill switch,
for anyone running a bot. `SessionAccount` is a smart account the owner
funds; `grant` hands a key up to eight (target, selector) rules, a value cap
per call and in total, and an expiry; the key calls `execute` from its own
address and pays its own gas while the account's ETH pays the call; the
owner pauses, resumes, revokes (terminal), and withdraws ETH and tokens on a
path no session can reach. `SessionAccountFactory` deploys one per (owner,
salt) at an address known in advance. No operator, no fee, no Chit address
anywhere in it: it is the primitive under the non-custodial trading bot, and
a fee, if ever, is a new contract.

Thirteen Solidity tests including a fuzz that spend never passes a cap; a
fork test on 46630 where a bot buys through the live Uniswap v4 router from
its session, is refused outside it, is revoked, and the owner takes the
tokens and the ETH back. `src/fleet/session-keys.ts` is the SDK (ABI,
encoders, `canExecute`); `app/sessions.html` is the page, all transactions
from the wallet straight to the contracts and every figure read from the
chain, in the app's own look and nav; `scripts/session-deploy-live.ts`
deploys the factory and writes `app/session-target.json`, which the page
reads. `docs/session-keys.md` is the whole product on one page.

Two things seen on the way. `app/build.mjs` resolves entry points through
`URL.pathname`, which esbuild cannot open on Windows ("/D:/…"), so the app
build only runs on Linux and Vercel; the page was bundled and rendered
directly to check it. And the app test that stages a build through a
symlink fails on Windows with EPERM for the same reason; both predate this
branch.

## The session-keys demo, told by the bot (2026-09-16, advisor, branch feat/session-keys)

`scripts/session-demo-live.ts` runs the whole session-keys story on testnet
and posts it to the group with every hash: a throwaway owner creates an
account, funds it, hands a fresh bot key a session (router only, 0.0005 a
trade, 0.001 in all, an hour), the bot buys FLEET through the live router
from its own key, is refused without gas when it asks to move the tokens or
to trade above its limit, gets its key pulled, and the owner takes the
tokens and the ETH back. The bot key is derived from the demo key and the
run's moment, so every run is a new key, since a revoked one is never
granted again. `.github/workflows/session-demo.yml` runs it by hand and on
Sundays; the first run deploys the factory (no owner, so the demo key may)
and commits the record. Rehearsed on a fork of 46630 against the real venue:
0.198 FLEET for 0.0003 ETH, then revoked. Needs one secret nobody has yet,
`DEMO_PRIVATE_KEY`, a throwaway with about 0.05 test ETH; never the
operator's.

## Gas sponsorship for dapps, built (2026-09-15, advisor, branch feat/gas-sponsorship)

The proposal's product, on top of the spike, with no change to the pool and
no new surface in the fleet's wiring. A dapp registers by its wallet's
signature (the fleet's challenge flow), sets a policy (targets and selectors,
a ceiling per operation, a cap per user per UTC day, a cap per sponsor per
day), funds its budget in a sponsor escrow from its own wallet, and its users
get operations sponsored through `POST /api/fleet/sponsor` with no login:
every FR-002 check runs before a signature and a refusal names its reason;
the route bundles the signed op itself and records what the escrow charged.
`FleetPaymaster` gained an immutable `feeBps` (zero for the fleet's own): the
budget is reserved and committed at cost plus fee, in postOp, which also
settles the spike's finding that postOp's figure undershoots the operator's
outlay. Measured on the fork with 20%: the budget covers 114% of the outlay
on an operation that deploys the account.

The ledger (sponsors, policies, every op by user hash) is the first state the
fleet service keeps off chain and between instances: `SponsorStore`, memory
for tests, Neon for the host (`DATABASE_URL`), so the daily caps hold across
functions (FR-005); the unit test runs two services over one store. The
dashboard is the `status` action for now, by day, target and user hash, never
an address (FR-008); a page in the app waits until the redesign settles, so
it lands once. `docs/gas-sponsorship.md` is the integration, end to end;
`scripts/sponsor-deploy-live.ts` deploys the set and prints the host
variables. Six unit tests, one fork test that is the doc page as code.

## The CI gate, Phase 1 of the mainnet beta (2026-09-21, T001–T003, T005)

`verify.yml` runs the no-network set on every push and pull request to main
(fleet suite, app, landing, Solidity, progress check); `verify-full.yml` runs
every fork suite nightly and by hand, one file per fork, with the RPCs read from
secrets and the public endpoints as the default, never as a required check.
Nothing commits to main any more: `progress.yml` is gone, the Vercel build
computes `landing/public/progress.json` from the task lists it deploys
(`scripts/progress.mjs` reads git where there is one and `VERCEL_GIT_COMMIT_SHA`
where there is not, leaving an unknown fact out), and `session-demo.yml` fails
on a moved factory record instead of pushing it. `test/fleet/ci-workflows.test.ts`
reads these facts from the workflow files.

Deviation, conservative: the landing still reads `/api/progress` (the public
mirror's copy) before its own `progress.json`, because the landing suite pins
that order and a test edit is not this contract's to make. The mirror is stale
while its push token is wrong, so until that is fixed the sheet shows the
mirror's last sync; the deploy's own file is the fallback, not the source.

T004 is blocked outside the code: branch protection and rulesets on a private
repository need GitHub Pro (`403` from the API). T006 follows T004.
## Mainnet ready: the chain from the environment, the caps at deployment (2026-09-16, advisor, branch feat/mainnet-beta)

What was agreed: a capped beta on Robinhood Chain mainnet, holders first,
labelled as a beta and as not audited by a firm, after the audit fixes are
live. What stood in the way was not a deploy but six places that named the
testnet: the service's chain id, RPC and recorded addresses, the app's
network switcher and the chain id the wizard signs, the balance page's 0.5
and 0.2, and the pool's caps as `constant`.

Now: `FleetPool` takes its caps in the constructor (immutable, same getter
names, a sanity check that no depositor can be the whole pool) so the same
audited bytecode runs on testnet with room to test and on mainnet as a beta;
`src/fleet/pool-caps.ts` publishes both sets. The service reads
`FLEET_CHAIN_ID` and `FLEET_RPC_URL`, assumes the recorded testnet addresses
only on testnet, reads the draw cap from the pool instead of a constant, and
reports the caps in the balance view. The app reads `chain-target.json`,
written by the deploy script: which chain, what to call it, and a beta note
the shell shows on every page when the file says so; the balance page draws
its limits from the pool's caps. `scripts/fleet-redeploy-live.ts` deploys
or redeploys the set on either chain (fresh with an escrow on mainnet,
guardian required there), records it per chain, writes the chain target and
prints the host variables, the holders gate included (which is `CHIT_FEE_*`
with a zero fee, all env). Rehearsed on a fork of mainnet at block
63,969,832: the beta set, the caps read back as 0.1 / 0.05 / 1, the note
written. `docs/runbooks/mainnet-beta.md` is the sequence, with what the beta
is not.

## The build can run the progress generator it was told to run (2026-09-21, Boye, branch fix/progress-build, T005)

Since T005 the build computes `progress.json` itself: `scripts/assemble-site.mjs`
runs `scripts/progress.mjs`. But a Vercel build only has the files
`.vercelignore` lets through, and that file dropped everything under `scripts/`
except the assembler, and every top-level `.md`, the README the generator reads
the stages from included. So the first build after T005 died in 33 seconds on
"Cannot find module '/vercel/path0/scripts/progress.mjs'" (the preview of
`feat/mainnet-beta-rebased`, the commit that is now main's tip). Production did
not show it only because a push to main no longer deploys; the next deploy by
hand would have failed the same way.

Two lines in `.vercelignore` let the generator and the README through
(`specs/` was never dropped). Nothing local can see this class of fault, since
on a checkout the files are all there, so the landing's suite now asks git,
which reads `.vercelignore` the way it reads `.gitignore`, which tracked files a
build never sees, and holds that against every script the assembler runs and
every file the generator reads. Rehearsed on exactly those files with no `.git`:
the assembler exits 0 and writes 88 of 175 with the commit from
`VERCEL_GIT_COMMIT_SHA`; the sheet already copes with a build that knows its
commit and nothing more.
