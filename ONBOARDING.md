# Chit — developer onboarding

Read this end to end before touching anything. It covers what the product is,
what is actually live, how the repo is laid out, how to run it, and the rules
that are non-negotiable here.

Last updated 2026-09-12. Current branch: `feat/fleet-mission`.

---

## 1. What Chit is

**A private funding layer for trading fleets.**

A trader runs many wallets (a "fleet"). To trade, each fleet wallet needs gas
and trade principal. If both come from the trader's main wallet, the chain
publishes the edge from the main wallet to every fleet account — anyone can
read the fleet off a block explorer.

Chit funds the fleet instead, so no transaction on chain joins the trader's
main wallet to a fleet account.

We say **private, not anonymous**. Never "untraceable", never "anonymous".
See §8 — this is enforced by a test.

### Two repositories

| Remote | Repo | What it is |
|---|---|---|
| `origin` | `ajanaku1/chit` | The **public hackathon submission** only |
| `private` | `Chit-org/chit-fleet` | The **real build**. Push here. |

The build goes to `private`. Do not push product work to `origin`.

### Three stages

| Stage | What | Status |
|---|---|---|
| **1 — Private gas** | The operator pays the fleet's gas and settles it against the trader's ETH escrow. Operator-executes; no paymaster. | **LIVE** on Robinhood Chain testnet 46630 at chit.tools. First sponsored buy landed 2026-09-06. |
| **2 — Private funding pool** | One shared, unkeyed pool funds *both* gas and trade principal. This is where "no trail" becomes true. | **Built, all gates green.** Pool deployed 2026-09-08. Only the live end-to-end validation (T040) is outstanding. |
| **3 — Trustless shielded pool** | ZK privacy pool; not even the operator can link deposit to fleet. User-held view keys. | North star. Not built, no spec, no gates. |

### The honest constraint (know this cold)

Gas sponsorship alone **does not** hide the funding trail. Stage 1's escrow is a
per-campaign deposit that names the owner on chain, and the same campaign key
appears on every fleet account it creates — so on live Stage 1 the
primary-wallet-to-fleet link **is derivable from public events**. This was found
2026-09-06 and it is why Stage 2 exists.

Stage 1's only true claim is *"the operator pays your fleet's gas."*
The "no trail" claim belongs to Stage 2 and not before.

Stage 2 is **semi-custodial** — Chit briefly holds pooled capital. That is why it
carries contract-enforced caps, a self-serve exit that works with the service
offline, and a professional security audit as a hard gate before any real funds.
Testnet and test token only, today.

---

## 2. The canonical documents

Read them in this order. **`Goal.md` wins on any conflict.**

| File | What it settles |
|---|---|
| [Goal.md](Goal.md) | Product, stages, scope, constraints, definition of done. The source of truth. |
| [plan.md](plan.md) | Autonomy: what you may do without asking, what you must stop and ask about. |
| [prompt.md](prompt.md) | Build choreography: phases, task ranges, done_when per phase. |
| [design.md](design.md) | Stage 1 approved product/experience design. |
| [design-stage2.md](design-stage2.md) | Stage 2 approved design. The settled decisions list is binding. |
| [specs/001-fleet-mission/](specs/001-fleet-mission/) | Stage 1 spec, plan, data model, tasks, quickstart, research. |
| [specs/002-private-funding-pool/](specs/002-private-funding-pool/) | Stage 2, same shape. `tasks.md` shows T001–T040 status. |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | The running build log. ~60KB, newest at the bottom. Read the tail before starting work — it explains most of the "why is it like this" questions. |
| [verify.sh](verify.sh) | The done predicates. Has the final vote. |
| [PROGRESS.md](PROGRESS.md) | How the landing's "how far along" sheet is computed from the task lists. Progress is read, never typed. |
| The workspace laws | Not in this repo. They live one level up in the workspace and govern every project in it, so the parts that bind this build are reproduced in [§7](#7-the-rules). Ask the founder for the file itself. |

Traceability runs: approved design → FR/SC numbers in the spec → COMP components
→ T-numbered tasks → a `verify.sh` tag. Every change should be locatable in that
chain.

---

## 3. Repo layout

```
contracts/fleet/      Solidity for the product
  FleetPool.sol           Stage 2 custody boundary — read this first
  FleetAccountFactory.sol Deterministic fleet accounts
  FleetSessionPolicy.sol  The bounded session key
  FleetCampaignEscrow.sol Stage 1 escrow (the one that leaks; superseded by the pool)
  FleetVenueToken.sol     FLEET test token
  FleetPoolSeeder.sol     Seeds the Uniswap v4 pool
  FleetPaymaster.sol      Not on the Stage 1 live path (operator-executes instead)

src/fleet/            Operator service (Node, TypeScript, viem)
  service-runtime.ts      Wires one router per warm serverless instance from env
  campaign-routes.ts      The action router — every API action lands here (814 lines)
  campaign-service.ts     Campaign state machine
  chain-pool.ts           FleetPool reads/writes
  pool-reads.ts           The two growing lists, read through Multicall3 and from a mark
  pool-reads-neon.ts      Where that mark is kept between instances (public chain data only)
  pool-ledger.ts          Seals/opens the depositor ciphertext; recomputes balance
  pool-buy.ts             Just-in-time principal, sweep, settlement, withdrawal payout
  chain-campaign.ts       Stage 1 escrow path
  operator-executor.ts    Operator-executes transaction path
  chain-buy.ts, v4-swap.ts  The permitted Uniswap v4 buy route
  session-policy.ts, campaign-budget.ts, eligibility.ts, sdk.ts, types.ts
  monitor.ts, monitor-reads.ts, monitor-cli.ts
                          The outside monitor. Not part of the service: it reads public
                          chain state hourly from a GitHub workflow, on plain node with no
                          install, so these three import no package (docs/fleet-monitor.md)

api/fleet/*.js        Vercel function entry points. Deliberately plain JS —
                      Vercel's TS pass type-checks viem differently from ours,
                      so the runtime is compiled by `npm run build` and imported
                      as JS. Each file just names which actions it accepts.

app/                  The browser app (static HTML + esbuild-bundled TS)
  fleet.html              The wizard
  fleet-dashboard.html    Control Room
  balance.html            Stage 2 Balance page
  fleet-privacy.html      The privacy claims page
  src/fleet/              Shared browser modules (signed-request, balance-read,
                          status-read, vault, control-room, page-shared)
  test/                   Browser-side tests (node --test via tsx)

landing/              The marketing site at the root of chit.tools
scripts/              Live deploy + journey runners, local dev server, site assembly
test/                 Service unit tests (test/fleet) and fork tests (test/fork)
deployments/          Recorded live addresses and tx hashes. Never invent one.
```

---

## 4. What is deployed, and where

All of Stage 1 and 2 live on **Robinhood Chain testnet, chain id 46630**.
Mainnet 4663 is out of scope. Everything is recorded in
[deployments/fleet-46630.json](deployments/fleet-46630.json) — that file, not
memory, is the source of truth.

| Thing | Address |
|---|---|
| Operator | `0x34b0Ba20669f3ec4F1056853780c381e5e35F724` |
| Session policy | `0x57c7436bbbb40b08adef5c84f0aeaee0c4f3e011` |
| Account factory | `0x5c0e2ec619c11b66e0e0efb7931bccfa6b784ea6` |
| Campaign escrow (Stage 1) | `0xd2c31ec466ead5f745bc6ba08cc49ff8435f1325` |
| **FleetPool (Stage 2)** | `0xce92096098ae1e397b167292edad8f3bdb8200c9` |
| EntryPoint v0.7.0 | `0x0000000071727de22e5e9d8baf0edac6f37da032` |
| Uniswap v4 Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| FLEET test token | `0x13283ab8e1f2bc4297e9ec6480c80c59674af554` |

Site: **chit.tools** — landing at the root, app under `/app`, API functions
under `/api/fleet/*`, on Vercel. Two clocks drive the sweep, and they are kept
apart on purpose. The queueing clock hits `/api/fleet/sweep`: GitHub Actions
every four hours, and two daily Vercel crons as a fallback. How often it ticks
is the size of the batch a charge hides in, so it does not tick faster for
safety's sake. The posting clock hits `/api/fleet/sweep-posting` every two
hours from `vercel.json`: it posts what is due and funds what is ready, never
queues, and exists to beat the pool's 12-hour `POST_WINDOW`. The sweep also
runs opportunistically on ordinary traffic (see §6). Every function under
`api/fleet/` states its `maxDuration` in `vercel.json`;
`test/fleet/sweep-timing.test.ts` holds the clocks and the durations.

---

## 5. How Stage 2 actually works

### The contract — `contracts/fleet/FleetPool.sol`

The whole privacy property is one rule:

> Deposits and spend are keyed by **depositor**. Draws and funding are keyed by
> **campaign**. No function and no event names both.

So nothing on chain publishes the link. The depositor behind a draw or a queued
spend travels as `ownerRef` / `encDepositor` — an AES-256-GCM ciphertext only the
operator's ledger key opens. The contract cannot decrypt it, so it cannot verify
that a posting names the right depositor. **That is operator trust**, disclosed
in the product, auditable after the fact by anyone holding the ledger key.

Constants that are contract-enforced, refused before any ETH moves:

| Constant | Value | Why |
|---|---|---|
| Deposit sizes | 0.01 / 0.05 / 0.1 ETH | Fixed denominations, so every deposit of a size looks alike |
| Per-depositor cap | 0.5 ETH | Bounds custody exposure |
| Per-campaign draw cap | 0.2 ETH | |
| Whole-pool cap | 5 ETH | |
| Gas headroom | 0.0002 ETH | Seeded to each fleet account |
| Exit delay | 24 hours | Self-serve recovery with the service offline |
| Min funding delay | 60 s (floor) | The service picks 1–15 min. The floor lives in the contract because the wait is what stops a deposit and its fleet funding pairing by timing. |

Do not change a cap, a size, or a delay without asking. It is listed in
`plan.md` as a stop-and-ask.

### The ledger — `src/fleet/pool-ledger.ts`

There is **no service database**. Custody state lives on chain, so any function
instance can serve any trader. The ledger key is derived from the operator key
already in the environment (`keccak256("chit-fleet-ledger-v1|" + operatorKey)`),
domain-separated, never stored, and identical on every instance. Ciphertexts and
the ledger key must never appear in a log or a response.

### The journey

1. **Deposit** — main wallet sends a fixed size straight to the pool. No campaign
   identifier on the deposit.
2. **Create a fleet** — wizard: connect → size → backup → confirm → activate.
   Owner credentials are generated in the browser and encrypted locally; the
   trader downloads and confirms a recovery vault.
3. **Activate** — opens a draw within the campaign cap and the balance, with a
   random due time 1–15 minutes out. The app shows "Funding your fleet" with the
   range and a countdown, honestly.
4. **Sweep funds it** — a later request (cron, or any ordinary traffic) funds due
   draws: gas headroom to each fleet account, session opened.
5. **Buy** — principal moves **just in time** from the pool to the fleet account,
   the permitted Uniswap v4 buy executes, principal plus gas commit against the
   draw. A failed buy rolls the principal back. The spend is *queued* and posted
   against the depositor later, after its own due time, so posting timing
   doesn't correlate either.
6. **Control Room** — pause, resume, revoke, close. Close credits the unspent
   draw **back to the balance**, not to a wallet, so closing publishes nothing.
   A depleted campaign tops up from balance without a new deposit.
7. **Out** — withdraw to a signed destination (the form warns that paying to the
   main wallet recreates the link), or the 24-hour contract exit that works with
   Chit entirely offline.

### Signed vs unsigned actions — read before you add an endpoint

Every wallet signature is a prompt, and prompts are the single biggest UX
complaint this build has had. The rule that came out of it:

- **Unsigned** is allowed only when the response contains nothing that isn't
  already public on chain to anyone holding the campaign id, and it names no
  depositor. `status` is the one such action: it returns a campaign's state and
  draw computed from the pool and the session policy alone. A test asserts the
  owner never appears in its response. The dashboard and the wizard poll with it,
  so watching a fleet costs zero signatures.
- **Signed** for anything that changes state, and for `balance`. Balance cannot
  be unsigned: it aggregates which *open draws* belong to the depositor, and that
  attribution is operator knowledge. An unsigned balance endpoint would publish,
  per address, how much is committed to fleets.
- The balance is cached for **10 minutes** and the cache is **cleared whenever
  something moves it** — deposit, withdrawal, activation, close, top-up.
  Correctness comes from the invalidation, not from a short window.

Challenge nonces are HMACs under a secret every instance derives the same way
from the operator key, because the instance that issues a challenge is not the
one that receives the signed action. Signatures are over the page origin, so
`FLEET_ORIGIN` must name the origin the browser is actually on.

---

## 6. Running it

Node 22. `npm ci && npm --prefix app ci`.

```bash
npm run build              # tsc --build  -> dist/
npm run build:fleet        # fleet-only project -> dist-fleet/
npm test                   # service tests
npm run test:fleet         # fleet service tests
npm --prefix app run verify   # typecheck + browser tests + app build
./verify.sh                # everything. The only thing that means "done".
./verify.sh pool-fund      # one gate
```

### Local, against the live testnet

```bash
npm run dev:local          # http://localhost:3000
```

This builds, assembles the site into `public/`, and serves the landing, the app
and the **real API handlers** on one origin — the same handlers Vercel runs, no
Vercel account needed. It reads `DEPLOYER_PRIVATE_KEY` from `.env` and takes the
pool address from the recorded deployment, so a local run cannot drift from what
is actually deployed. It sets `FLEET_ORIGIN` to itself so signed challenges name
the right origin. It logs the action behind each request and the action each
challenge is for — a challenge is exactly one wallet prompt, and knowing which
one is the whole diagnosis.

### Environment

`.env` (never committed; `.env.example` shows the shape):

| Var | Notes |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | Testnet operator signer. Also read as `FLEET_OPERATOR_PRIVATE_KEY`. Without it, `fund` and `buy` answer 503 — they do not fall back to a default. |
| `ROBINHOOD_TESTNET_RPC_URL` | Optional; defaults to the public testnet RPC |
| `CHIT_RPC_URL`, `CHIT_TOKEN_ADDRESS` | Mainnet read-only CHIT eligibility/discount data |
| `CHIT_BASE_FEE`, `CHIT_FEE_DISCOUNT`, `CHIT_FEE_THRESHOLD`, `CHIT_FEE_RECIPIENT` | Published fee facts |
| `FLEET_POOL_ADDRESS`, `FLEET_ESCROW_ADDRESS`, `FLEET_FACTORY_ADDRESS`, `FLEET_POLICY_ADDRESS` | Optional overrides; default to the recorded deployment. Only set after a redeploy. |
| `FLEET_ORIGIN` | Overrides the signed-challenge origin for previews |

Anything missing leaves the corresponding capability answering **503** rather
than substituting an invented fact. Keep it that way.

### Live scripts (outward — see §7)

`fleet-deploy:live`, `fleet-venue:live`, `fleet-pool-deploy:live`,
`fleet-first-buy:live`, `fleet-pool:journey`, and `fleet-pool:check` (the
non-mutating dry run — start there).

---

## 7. The rules

These are not style preferences. They come from the workspace laws and from [plan.md](plan.md).

**Laws:**
- **Done means `verify.sh` exits 0.** Not a summary, not a checked-off task,
  not "it looked right". Never report work done from your own assessment.
- **Never edit or delete a test to make it pass.** That is a fail, always.
  Same for weakening a `verify.sh` predicate — if a predicate is genuinely wrong,
  fix it deliberately and record it in `IMPLEMENTATION.md`.
- **Never invent** a secret, an endpoint, an address, or a convention. Stop and
  ask. Verified addresses live in `deployments/` and `specs/*/research.md`.
- **Never add a dependency.** Propose it and stop. The dependency list is tiny on
  purpose: viem, OpenZeppelin, the Nox packages, Neon, and Hardhat for tests.
- **Never commit a key**, even a testnet burn key.
- **Never exceed 200 changed lines in a commit** without asking.
- **Never touch** `.env*`, deploy keys, deployed addresses, or hackathon
  submission artifacts unattended.
- **Never type progress.** The landing reports how far along Chit is from the
  ticked boxes in `specs/*/tasks.md`, recomputed on every push to `main`
  ([PROGRESS.md](PROGRESS.md)). Tick the box when the gate passes; never edit
  `landing/public/progress.json` by hand.

**Stop and ask before:** deploying any contract to 46630; the live pooled buy
(T040); any Vercel production deploy or env change; anything touching real funds
or mainnet; changing caps, delays, or the privacy claim; posting anything
outward; any test edit; and any conflict with a settled spec.

**Hard constraints on Stage 2 code:** no new dependency; no transaction, event,
log or response may name both a depositor and a campaign; ciphertexts and the
ledger key never appear in logs; caps and the exit are contract-enforced; no
claim beyond FR-015; testnet and test token only; **every `fleet-*` gate stays
green**.

Work test-first — a failing test paired with its implementation, red-green order
visible in the commits. Deviations take the conservative option, get logged in
`IMPLEMENTATION.md`, and continue.

---

## 8. Claims discipline

There is a test — `app/test/fleet-claims.test.ts` and
`landing/test/landing.test.mjs` — that fails the build if the app, the landing,
or `marketing/` contains "anonymous", "untraceable", or an unqualified "no
trail", or is missing the approved claim.

The approved claim (FR-015), which Stage 2 earns and Stage 1 does not:

> "Your main wallet never funds your fleet. The chain shows a deposit into Chit
> and fleets funded by Chit, and no transaction links the two. Chit's operator
> can link them, and with few users, amounts and timing can be guessed at.
> Private, not anonymous."

Chit never hides trades and never markets anonymity. Public accounts, trades,
amounts, timing and gas all stay visible — only the funding relationship is
withheld. Permanently out of scope: custody of imported fleet keys, arbitrary
calls, hidden trades, manufactured volume, market manipulation.

---

## 9. Verification gates

`./verify.sh <tag>` runs one family. The fleet product's tags:

| Tag | Proves |
|---|---|
| `fleet-evidence` | Verified testnet dependency evidence, or a labelled fixture |
| `fleet-foundation` | Policy, state, budget and redaction protections |
| `fleet-create` | Eligible five-account creation with fee and vault controls |
| `fleet-buy` | Bounded sponsored buys |
| `fleet-control` | Terminal lifecycle control |
| `fleet-venue` | The seeded Uniswap v4 venue |
| `fleet-acceptance` | Full build, privacy and quickstart acceptance |
| `pool-foundation` | Pool contract, ledger and ABI separation on the 46630 fork |
| `pool-balance` | Balance, headroom, withdrawal, exit |
| `pool-fund` | Delayed funding from a *fresh* instance; just-in-time buys |
| `pool-control` | Close-to-balance, top-up, operator pause |
| `pool-acceptance` | Observer unlinkability over events, FR-015 copy, and every Stage 1 gate still green |

The fork tests in `test/fork/` run against a real 46630 fork via Hardhat —
`fleet-pool-observer.test.ts` is the interesting one: it replays a full journey
and asserts a fresh observer scanning pool, factory and policy events cannot
join the depositing wallet to any fleet account.

A fresh-context reviewer who saw neither the plan nor the draft verifies the
project's done_when — once, after the last phase. Never per phase, never per fix.
If maker and checker disagree twice, stop and queue it for a human.

---

## 10. Where things stand, and what's next

- Stage 1 is live and must stay green.
- Stage 2 is **built**; all `pool-*` and `fleet-*` gates are green; the pool is
  deployed at `0xce92096098ae1e397b167292edad8f3bdb8200c9`.
- **T040 is the only open task**: deploy-validate live — run the quickstart
  validation on chit.tools and record the tx hashes under `pooledBuy` in the
  deployment file. It is outward and needs the founder's go. Do not run it
  unasked.
- Recent work has been UX repair on the live app: killing redundant wallet
  prompts, caching the balance correctly, recovering from campaigns the service
  has lost, and making the local dev server explain itself. Read the last ~10
  entries of `IMPLEMENTATION.md` for the detail.
- Before mainnet: a professional security audit. Non-negotiable, and not part of
  this build.

### Your first hour

1. Read `Goal.md`, then `design-stage2.md`, then the tail of `IMPLEMENTATION.md`.
2. `npm ci && npm --prefix app ci`, then `./verify.sh` and watch it go green.
3. Read `contracts/fleet/FleetPool.sol` top to bottom — it is commented for
   exactly this purpose.
4. Follow one action end to end: `app/src/fleet/signed-request.ts` →
   `api/fleet/campaign.js` → `src/fleet/service-runtime.ts` →
   `src/fleet/campaign-routes.ts` → `src/fleet/chain-pool.ts`.
5. `npm run dev:local` and click through the wizard against the live testnet.
