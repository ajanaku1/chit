# Chit Fleet autonomy

**Autonomy level**: Medium autonomy.

Green-lit: routine local test-first edits, drafting reports, and non-mutating verification within the settled design/spec/tasks and existing dependencies.

Stop and ask before: new dependency; secrets or credentials; an unevidenced live endpoint or deployed address; mainnet write or sponsorship; posting, deploying, or other outward action; destructive or irreversible action; scope/privacy-claim change; brand/UI-direction change; or conflict with settled specifications.

**Stage boundary.** This contract authorizes Stage 1 (live, regression only) and Stage 2 (Private Funding Pool) on Robinhood testnet 46630 with the test token, per `design-stage2.md` and `specs/002-private-funding-pool/` (user-authorized 2026-09-06/07). Stop and ask before: deploying the pool contract or any contract to 46630; the live pooled buy (T040); any Vercel production deploy or env change; touching real funds or mainnet (a professional audit is a precondition); changing caps, delays, or the FR-015 claim; and any test edit. The permission classifier blocks commands that read the operator key, production deploys, and self-granted settings; those are the user's to run. Stage 3 is out of scope.

After the final phase, run fresh-context verification and the Sol gate. On an unexpected hurdle, preserve evidence, stop at the narrow blocker, and report the minimal decision needed. Resume Stage 2 from `design-stage2.md`, `specs/002-private-funding-pool/spec.md`, its `tasks.md`, and the first incomplete task; Stage 1 from `design.md` and `specs/001-fleet-mission/`. Drafting reports is routine; posting is not.
