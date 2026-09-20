# Chit Fleet autonomy

**Autonomy level**: Medium autonomy.

Green-lit: routine local test-first edits, drafting reports, and non-mutating verification within the settled design/spec/tasks and existing dependencies.

Stop and ask before: new dependency; secrets or credentials; an unevidenced live endpoint or deployed address; mainnet write or sponsorship; posting, deploying, or other outward action; destructive or irreversible action; scope/privacy-claim change; brand/UI-direction change; or conflict with settled specifications.

**Stage boundary.** This contract authorizes Stage 1 (live, regression only), Stage 2 on Robinhood testnet 46630, and the capped mainnet beta of Stage 2 on 4663, per `design-mainnet-beta.md` and `specs/003-mainnet-beta/` (user-authorized 2026-09-19/20). Authorized here means the code, the tests, the contracts and the copy may be written and run locally and against forks. It does not authorize any of it to reach a chain or a user.

Stop and ask before: deploying any contract to any chain, 46630 and 4663 alike; the live pooled buy (T040); any Vercel production deploy or environment change; any transaction that spends real ETH; pushing to `main` once it auto-deploys; posting any announcement; changing caps, delays, the FR-015 claim, or the token registry's enabled set; and any test edit. The permission classifier blocks commands that read the operator key, production deploys, and self-granted settings; those are the user's to run.

**What the beta does not relax.** A capped beta replaces the audit as a gate for opening, not as a gate for judgement. Real ETH is still real: a mainnet write is stop-and-ask every time, no matter how small, and no task in `specs/003-mainnet-beta/tasks.md` marked outward may be run unattended. Stage 3 is out of scope.

After the final phase, run fresh-context verification and the Sol gate. A fresh context that saw neither the plan nor the draft verifies the project's done_when once, after the last phase, never per phase. On an unexpected hurdle, preserve evidence, stop at the narrow blocker, and report the minimal decision needed. Resume the mainnet beta from `design-mainnet-beta.md`, `specs/003-mainnet-beta/spec.md`, its `tasks.md`, and the first incomplete task; Stage 2 from `design-stage2.md` and `specs/002-private-funding-pool/`; Stage 1 from `design.md` and `specs/001-fleet-mission/`. Drafting reports is routine; posting is not.
