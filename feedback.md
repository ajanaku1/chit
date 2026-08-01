# iExec Nox integration feedback

These findings came from building and verifying Chit on Ethereum Sepolia. Each item includes the observed behavior and a concrete improvement that would have shortened the integration.

## 2026-07-30: fork chain ID controls Nox address resolution

`Nox.sol` selects NoxCompute from a hardcoded chain map. A Sepolia fork using a local default chain ID reverts with `Nox: Unsupported chain`, even though the fork contains the correct deployed bytecode. The Hardhat network had to retain chain ID `11155111`.

Suggestion: add a fork recipe to the Nox Hardhat documentation and call out that the fork must preserve the source chain ID.

## 2026-07-30: the Hardhat plugin starts a local stack unless explicitly disabled

The Nox Hardhat plugin overrides test behavior to start its Docker-backed environment. That is unnecessary for a fork pointed at the real Sepolia NoxCompute and blocks environments without Docker. `nox: { skipTestOverride: true }` solved it, but the option was easy to miss.

Suggestion: document `skipTestOverride` beside the fork example and auto-detect a configured fork where possible.

## 2026-07-30: external encrypted inputs are contract-bound

The browser generated a valid 137-byte proof only when `encryptInput` received the exact application contract that later called `Nox.fromExternal`. Reusing a proof against another vault fails, which is the right security behavior but deserves a prominent example.

Suggestion: show the contract-binding rule in the first `fromExternal` tutorial and include a failing wrong-contract example.

## 2026-07-30: resolved handles can still return a temporary ACL denial

The imported handle reported `resolved: true`, and the on-chain viewer check confirmed the auditor. `HandleClient.decrypt` still returned HTTP 403 with `access_denied: not a viewer`. The same account and handle succeeded later without another ACL transaction.

Impact: the error looked permanent and blocked the live selective-disclosure gate. Full reproduction: [`reports/2026-07-30-nox-auditor-acl-403.md`](reports/2026-07-30-nox-auditor-acl-403.md). Public issue: [iExec-Nox/nox-handle-sdk#105](https://github.com/iExec-Nox/nox-handle-sdk/issues/105).

Suggestion: expose ACL readiness in the status response or classify this specific 403 as retryable.

## 2026-07-30: every Nox operation returns a fresh handle

ACL grants do not carry from an input handle to the result of `add`, `safeSub`, `safeMul`, `safeDiv`, or `select`. Chit had to call `allowThis` and re-grant the auditor after every operation that produced a stored value.

Suggestion: place a bold handle-lifecycle warning near the arithmetic API and publish a reusable ACL propagation pattern.

## 2026-07-31: wrapper transfers require transient permission

Importing an encrypted amount is not enough for the ERC-7984 wrapper to consume it. The contract must grant `Nox.allowTransient(value, wrapper)` before `confidentialTransferFrom`. The distinction between a persistent viewer and a one-call consumer was not obvious from the wrapper flow alone.

Suggestion: include the transient grant in every wrapper transfer example and explain why a persistent grant is broader than needed.

## 2026-07-31: encrypted initialization needs transaction staging

Deploying three round contracts and initializing every encrypted zero in one transaction was too gas-heavy for a reliable browser flow. The working factory separates contract creation from five bounded initialization calls. Measured initialization estimates ranged from 94,199 to 152,760 gas after the 3,338,144-gas `beginRound` call.

Suggestion: publish a staged deployment pattern for contracts with several encrypted storage values, including recommended gas ceilings.

## 2026-07-31: browser wallet discovery needs both provider paths

Rabby was not always available as the single `window.ethereum` provider in Brave. Reliable discovery required EIP-6963 announcements plus Brave's legacy `ethereum.providers` array as a fallback.

Suggestion: add an EIP-6963 browser sample to the Nox client documentation so applications do not assume one injected wallet.

## 2026-07-31: handle readiness and transaction readiness are separate states

A successful Sepolia receipt does not mean the Nox gateway can immediately serve the resulting handle. Chit had to wait for the chain receipt and then poll `/v0/public/handles/status` for the exact handle.

Suggestion: provide one helper that waits for both the transaction and gateway resolution with bounded backoff and an abort signal.

## 2026-08-01: confidential paymaster enforcement has a hard boundary

ERC-4337 paymaster validation is a public `view` path. It cannot decrypt a sponsor budget or revert on an encrypted comparison. Chit therefore uses a verifying signer that knows the sponsor graph and checks solvency off-chain, while Nox protects attribution and settlement on-chain.

Suggestion: document this paymaster limitation directly. A short pattern guide would help teams distinguish private accounting from trustless confidential authorization.

## 2026-08-01: RPC compatibility can obscure a successful write

One public Sepolia RPC returned `Unknown block Version: viem@2.55.10` while polling a transaction receipt. The wallet had already broadcast the write, but the UI could not classify it. Persisting the hash before receipt polling and reconciling through another public RPC prevented an accidental duplicate.

Suggestion: recommend durable transaction checkpoints in browser examples and return typed unknown-outcome errors from SDK helpers that perform writes.
