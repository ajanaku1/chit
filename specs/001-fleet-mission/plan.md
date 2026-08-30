# Implementation Plan: Fleet Mission

**Branch**: `001-fleet-mission` | **Date**: 2026-08-28 | **Spec**: [spec.md](spec.md)

## Summary

Fleet Mission is an isolated, testnet-only vertical slice: an eligible individual trader creates 5–50 new smart accounts, protects local owner credentials and recovery material, funds a bounded ETH campaign, and submits one approved sponsored buy through a dashboard and small SDK. It preserves the existing Sepolia/Nox proof and creator app, existing dependencies, public trade visibility, and operator-known MVP mapping.

## Technical Context

**Language/Version**: TypeScript on Node 22; Solidity in the existing Hardhat 3 project.
**Primary Dependencies**: Existing viem, Hardhat, static esbuild browser app, Vercel API functions, and native Web Crypto; no dependency additions.
**Storage**: Local/downloaded Recovery Vault v1 in the browser; only its commitment plus a separate trusted operator-encrypted campaign mapping in the service; on-chain campaign budget escrow and pooled paymaster deposit.
**Testing**: Existing Node/TypeScript and Hardhat test tooling; tests are written before every corresponding implementation task.
**Target Platform**: Responsive static browser dashboard, TypeScript SDK, Vercel service functions, and Robinhood Chain testnet (chain 46630) smart-account infrastructure — ERC-4337 EntryPoint v0.7.0 with an Alchemy or ZeroDev bundler.
**Project Type**: Static browser application, service functions, smart contracts, and SDK.
**Performance Goals**: The five-account demo reports one terminal result per account and an aggregate campaign budget result in the same Control Room session.
**Constraints**: No new dependencies, no private or live credentials in fixtures, no public primary-wallet-to-fleet edge, no owner credential outside browser memory in the clear, Robinhood Chain testnet sponsorship only, and no invented provider, router, EntryPoint, or swap-venue address.
**Scale/Scope**: One individual trader per campaign, 5–50 accounts, one router/function, one bounded session key, and a five-account demo.

## Constitution Check

The generated constitution is an unratified template with no enforceable project-specific principles. Root workspace rules remain controlling: preserve existing product slices, add no dependencies, use test-first tasks, keep credentials out of the repository, and require review before delivery. **Pass** before and after design: this plan neither changes the constitution nor conflicts with those rules.

## Major Components

- **COMP-001 Fleet browser experience**: Static-app Fleet Mission modules for eligibility/fee disclosure, campaign setup, recovery confirmation, activation resumption, Control Room, and local Web Crypto vault handling.
- **COMP-002 Fleet account and policy contracts**: Isolated testnet factory and account policy that create fleet accounts and enforce one bounded session key without public primary or reusable campaign identifier in UserOperations.
- **COMP-003 Sponsorship and budget contracts**: Shared paymaster and per-campaign escrow with exact reservation, terminal owner withdrawal, and bounded operator reconciliation.
- **COMP-004 Fleet service and adapters**: Existing TypeScript service patterns for domain-separated primary-wallet challenges, nonce/expiry/replay checks, trusted encrypted mapping, idempotency, fee-charge accounting separate from ETH sponsorship, policy checks, and raw bundler/paymaster JSON-RPC behind viem/fetch interfaces.
- **COMP-005 Fleet TypeScript SDK**: A small client API that permits only the campaign's approved buy and exposes policy/state rejections.
- **COMP-006 Fleet verification suite**: A no-new-dependency Fleet-scoped root compile/test harness, independent app verification pipeline, and test-first dependency evidence, vault, redaction, fee, budget, idempotency, state, SDK, and five-wallet coverage.

## Project Structure

```text
specs/001-fleet-mission/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── fleet-api.md
│   ├── fleet-evidence.md
│   ├── fleet-policy.md
│   ├── fleet-sdk.md
│   └── fleet-vault.md
├── checklists/
│   ├── requirements.md
│   └── fleet-mission-review.md
└── tasks.md

app/src/fleet/
app/test/fleet-*.test.ts
api/fleet/
contracts/fleet/
src/fleet/
test/fleet/
tsconfig.fleet.json
```

**Structure Decision**: Fleet Mission adds a self-contained feature namespace to existing app, API, contract, source, and test roots. Existing Sepolia/Nox and creator paths remain unchanged.

## Delivery Phases

1. Add the Fleet-scoped compile/test harness; verify testnet dependencies by exact evidence or labelled fixture and establish shared models, policies, fee accounting, and redaction boundaries.
2. Write contract, service, browser-vault, SDK, and end-to-end tests before their implementations.
3. Build activation, policy, budget, dashboard, and SDK slices in user-story order.
4. Validate the five-account testnet demo, public privacy boundary, fee disclosure, terminal revocation, and unused-ETH withdrawal.

## Complexity Tracking

No constitution violation requires justification.

## Baseline debt

The unchanged root `test/fork/*.test.ts` viem typing failure prevents a full root build/test green result today. Fleet-scoped phases use the isolated harness and app pipeline; they do not edit existing tests to mask that debt. Full Fleet acceptance retains `npm run build` and cannot claim completion until this baseline is resolved separately.
