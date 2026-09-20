# Chit Constitution

These are not new principles. They record what the project already enforces
through `CLAUDE.md`, so that Spec Kit's gates and the repository's rules are the
same rules. Where this file and `CLAUDE.md` differ, `CLAUDE.md` wins and this
file is wrong.

## Core Principles

### I. Done means the check passed

A task is done when its machine-checkable predicate passes, never on anyone's
assessment that it looks finished. Every task carries a `done_when` before work
starts. `loop/guardrails/verify.sh` has the final vote.

### II. Tests are evidence, never an obstacle (NON-NEGOTIABLE)

A test is never edited or deleted to make it pass. A test that asserts broken
behaviour is replaced by one asserting the fixed behaviour, and the replacement
is written before the fix is called done. A deleted test is a failure, always.

### III. Claims must hold

Nothing published may claim more than the product does. A privacy claim carries
its qualification wherever it appears. A promise that turns out to be wrong is
corrected in public, in its own change, before the behaviour that contradicts it
ships.

### IV. Small, reversible changes

No commit exceeds 200 changed lines without asking first. No dependency is added
without proposing it and stopping. No secret, endpoint or convention is invented:
where the answer is not known, the work stops and asks.

### V. Money paths are guilty until proven innocent

Anything that moves user funds is assumed broken until a test says otherwise. An
exception is never read as proof that nothing happened. Where an outcome is
unobserved, it is resolved by reading the chain, not by inference.

## Additional Constraints

Deployed contract addresses, `.env*` files and submission artifacts are never
touched unattended. Private keys are never committed, testnet burn keys included.
Where a deviation from the plan is necessary, the conservative option is taken,
logged in `IMPLEMENTATION.md`, and work continues.

## Development Workflow

Decisions route to a read-only planning pass before implementation. A fresh
context verifies the project's `done_when` once, after the last phase, having
seen neither the plan nor the draft. Where maker and checker disagree twice, work
stops and queues for a human.

## Governance

This constitution records existing practice and does not supersede `CLAUDE.md`.
Amendments happen by amending `CLAUDE.md` first and reflecting the change here.

**Version**: 1.0.0 | **Ratified**: 2026-09-20 | **Last Amended**: 2026-09-20
