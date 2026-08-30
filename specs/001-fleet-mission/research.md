# Research: Fleet Mission

## Decision: preserve the existing stack and isolate the feature

- **Decision**: Use the existing TypeScript/Node, viem, Hardhat, static esbuild, and Vercel-function stack in a Fleet-specific namespace.
- **Rationale**: The product must preserve existing Sepolia/Nox proof and creator flows and may not add dependencies.
- **Alternatives considered**: A framework migration or separate service is rejected because it widens the change surface without serving the five-account demo.

## Decision: local key and recovery boundary

- **Decision**: Use the exact local/downloaded Recovery Vault v1 protocol in `contracts/fleet-vault.md`: browser randomness, an EIP-191 domain-separated signature-derived HKDF KEK, AES-256-GCM payload encryption, and a separately wrapped DEK; only the envelope commitment reaches the service.
- **Rationale**: The approved design requires non-custodial credentials, downloaded recovery material before activation, and no plaintext key in API, logs, or storage.
- **Alternatives considered**: Imported, custodial, and service-held plaintext credentials are excluded by the specification.

## Decision: bounded sponsorship privacy model

- **Decision**: Use an isolated Fleet account/factory, bounded campaign session policy, shared paymaster, and campaign escrow; UserOperations omit a public primary address and reusable campaign identifier.
- **Rationale**: Public accounts, trades, amounts, timing, gas, and paymaster activity remain visible while the public primary-to-fleet edge is not published; the operator retains the MVP mapping.
- **Alternatives considered**: Hidden trades and fleet-wide unlinkability are rejected because they are not truthful MVP claims.

## Decision: target Robinhood Chain testnet (chain 46630)

**Amended 2026-08-30.** The original decision named an unspecified testnet with
Redstone Holesky as the placeholder venue. The user redirected the feature to
Robinhood Chain, and the following was verified by direct JSON-RPC before the
amendment was written. Every address below returned non-empty bytecode from
`https://rpc.testnet.chain.robinhood.com` on 2026-08-30.

| Role | Address | Status |
|---|---|---|
| Chain | `eth_chainId` → `0xb626` (46630) | verified |
| EntryPoint v0.6.0 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | verified |
| EntryPoint v0.7.0 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | verified, selected |
| EntryPoint v0.8.0 | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` | verified |
| Safe 4337 Module v0.3.0 | `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` | verified |
| Uniswap v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | verified |
| Uniswap v4 Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` | verified, selected |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | verified |

- **Decision**: Target Robinhood Chain testnet, EntryPoint v0.7.0, and the Uniswap
  v4 Universal Router. The Fleet paymaster and the demo venue token remain
  labelled test-only doubles in `test/fleet/fixtures/dependency-evidence.json`
  until they are deployed to 46630 and their addresses are recorded.
- **Rationale**: Robinhood Chain has first-class ERC-4337 support and also
  supports EIP-7702, so the bounded session-key and sponsorship model this
  feature is built on is native to the chain rather than emulated. The Uniswap v4
  stack is deployed on testnet at the same addresses as mainnet, even though
  Uniswap's published deployment table lists only mainnet — which removes the
  need for a fixture router that the original decision had to assume.
- **Alternatives considered**: Robinhood Chain mainnet (4663) carries real Uniswap
  liquidity but would put real ETH into an unaudited paymaster and escrow and
  would contradict FR-018; it is rejected for this MVP. Ethereum Sepolia is
  retained only for the existing Nox proof, which does not move.

## Decision: the confidential attribution layer does not move

- **Decision**: Keep iExec Nox on the existing Ethereum Sepolia proof and keep it
  out of Fleet Mission entirely (FR-017).
- **Rationale**: Verified on 2026-08-30 — the iExec SDK supports Arbitrum Sepolia
  and Arbitrum mainnet only, defaulting to `arbitrum-sepolia-testnet`. Nox does
  not run on Robinhood Chain, so porting it would require iExec support or a
  self-operated gateway, compute, KMS, and indexing deployment. Fleet Mission was
  already scoped so the operator holds the primary-to-fleet mapping, so nothing in
  this feature depends on Nox.
- **Alternatives considered**: Standing up a private Nox deployment is rejected as
  out of proportion to the MVP and unverifiable within it.
