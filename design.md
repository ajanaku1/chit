# Chit Fleet Mission

Fleet Mission is a private gas-budget manager for one meme trader operating 5–50 newly generated programmable smart accounts. Its proof is simple: create and fund one campaign, then use the SDK to execute one sponsored token buy from five smart accounts. Fleet accounts are not imported EOAs.

The surface is a responsive web dashboard plus a small TypeScript SDK. Holding the defined CHIT threshold unlocks fleet creation and fee discounts; sponsorship budgets are always ETH. Public trades stay public, but observers do not receive the primary-wallet-to-fleet relationship. In MVP, Chit's operator knows that mapping.

## Core journey

1. The trader connects a primary wallet. Access shows the published CHIT threshold, base service fee, configured CHIT discount, and resulting eligible fee; Chit performs a read-only threshold check and only permits campaign creation when eligible.
2. In Campaign setup, the trader names the campaign, chooses 5–50 accounts, an expiration, per-wallet and total gas limits, one approved router, and a maximum trade value. Campaign review itemizes the base fee, applied CHIT discount, and net service fee before any transaction.
3. The browser generates a separate owner key for every smart account and encrypts its credentials locally under primary-wallet authorization. Chit never receives plaintext keys.
4. Before activation, the trader downloads the encrypted recovery vault and confirms that download. Losing both the local authorization path and this vault means the owner credentials cannot be recovered.
5. The trader funds the campaign's ETH gas budget, then activates the smart accounts and one bounded session key for that campaign.
6. Control Room shows campaign state, accounts, remaining ETH budget, activity, and aggregate results. The TypeScript SDK executes the permitted buy flow.
7. The trader can pause, revoke, or close the campaign. Closing returns unused ETH gas; pausing or revoking immediately prevents further sponsored execution. Revoked is terminal for sponsorship: it cannot resume or rotate a new session key, Close is its only remaining action, and continuing requires a new campaign.

## Screens and state

**Access** connects the primary wallet, shows the read-only CHIT result alongside the published threshold, base fee, configured discount, and resulting eligible fee, and either opens Campaign setup or blocks creation.

**Campaign setup** collects the campaign controls and generates encrypted owner credentials. Its campaign review itemizes the base fee, applied CHIT discount, and net service fee before any transaction. A saved draft survives reload so setup resumes without repeating accepted choices.

**Recovery and activation** requires vault download and confirmation, accepts the ETH funding step, and visibly advances account activation. A reload during activation resumes partial activation and never creates duplicate smart accounts or session keys.

**Control Room** is the single operating view for Active, Paused, Revoked, Depleted, Expired, and Closed campaigns: it exposes balances, budget use, aggregate reporting, and pause, revoke, retry, resume, and close actions where valid. Resume is available only from Paused; a Revoked campaign is terminal for sponsorship and permits Close only to recover unused ETH.

`Draft → Awaiting recovery confirmation → Awaiting funding → Activating → Active → Paused / Revoked / Depleted / Expired / Closed`

## Interaction and privacy boundaries

CHIT eligibility is checked only at campaign creation and renewal, not before every trade. The displayed threshold, base fee, configured CHIT discount, and resulting eligible fee make the published fee rule visible before creation. The campaign session key is bounded to its campaign, chain, generated accounts, allowed router and function, maximum trade value, per-wallet and total gas budgets, and expiry.

It cannot transfer arbitrary assets, change ownership, withdraw gas, authorize keys, or call unapproved contracts. One campaign has one bounded session key.

The private boundary is the primary wallet's relationship to its fleet and locally encrypted owner credentials. The public boundary is each smart account, its token trades, and the shared sponsorship activity. The trusted MVP boundary is Chit's operator, which knows the primary-to-fleet mapping but does not receive plaintext keys. The recovery warning is explicit: the downloaded encrypted vault is required if local credential access is lost.

## MVP scope

- Responsive dashboard and small TypeScript SDK.
- Robinhood Chain testnet sponsorship and read-only mainnet CHIT balance.
- 5–50 client-generated smart accounts with local key generation and encrypted recovery.
- ETH budget controls, one router, one buy function, maximum trade value, and per-wallet/total gas limits.
- Pause, revoke, retry, and resume controls for valid states; Revoked never resumes; aggregate reporting.
- The demo campaign uses five wallets.

## Exclusions

- Imported or custodial keys; selling, limit trading, copy trading, P&L, or charts.
- Telegram or mobile clients; arbitrary calls; hidden trades; or operator-blind attribution.
- Mainnet sponsorship before closed beta and security review, and Robinhood Nox until supported.
- Staking, revenue, buybacks, a new token, manufactured volume, or market manipulation.

## Demo path

An eligible wallet connects, creates a five-wallet campaign, downloads and recovers the vault, funds testnet ETH, and authorizes the session. One SDK command executes buys from all five accounts. Control Room reports the results; the explorer shows a common paymaster and no published primary mapping. Revoking the campaign makes a further SDK attempt reject.

## Acceptance outcomes

- An ineligible primary wallet is blocked from creation.
- An eligible campaign’s charged service fee equals the displayed base fee minus the configured CHIT discount.
- A five-account campaign has five distinct owner credentials, and the primary wallet is not their public owner.
- Five permitted buys change token balances without charging the accounts' native ETH; the correct campaign ETH budget is debited.
- Calls outside the campaign policy are rejected, and reloads are idempotent during draft and partial activation.
- The locally downloaded vault decrypts under primary-wallet authorization; API responses, logs, and storage contain no plaintext keys.
- Pause or revoke blocks execution; a Revoked campaign cannot resume or rotate a session key and can only Close to return unused ETH budget; the full demo is repeatable from a clean test account.

## Product stages (direction)

Fleet Mission as specified above is Stage 1 of a three-stage product. The stages are direction; only Stage 1 has a design and a done contract here.

- **Stage 1 — private gas.** What this document specifies. Chit sponsors the fleet's gas from a shared paymaster budget so no transaction shows the main wallet paying the fleet's gas. It does not hide the trade principal, so it does not yet deliver a full "no trail" funding promise. Operator-trusted mapping.
- **Stage 2 — private funding pool.** Chit funds the fleet's trade principal too, from one pooled deposit, so the main wallet never funds the fleet directly. This is where "no trail back to you" becomes true. Chit briefly holds pooled capital (semi-custodial), so it requires deposit/refund accounting, strict per-campaign limits, a professional security audit, and the accountable-privacy model (selective disclosure): hidden from the public, provable to an auditor the user chooses, never an anonymous mixer. Needs its own spec-dialogue → Spec Kit flow.
- **Stage 3 — trustless shielded pool.** A ZK privacy pool where nobody, not even the operator, links deposit to fleet, with user-held view keys for auditability. Requires privacy infrastructure not available on Robinhood today. North star.

The exclusions above are Stage 1 exclusions. Principal funding, operator-blind attribution, mainnet sponsorship, and on-chain confidential attribution move from "excluded" to "later stage." Hidden trades, manufactured volume, and market manipulation stay permanently excluded; Chit never hides trades and never markets anonymity.
