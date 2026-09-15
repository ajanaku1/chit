# FleetPool pre-audit

**Scope:** `contracts/fleet/FleetPool.sol` at commit `cf51dd4` (403 lines), and the service paths that drive it in `src/fleet/pool-buy.ts` where the contract's behaviour depends on them. Not in scope: FleetSessionPolicy, FleetAccountFactory, FleetCampaignEscrow, the paymaster, the ledger encryption.
**Date:** 2026-09-14
**Method:** line-by-line read against the threat model below; a unit test per finding that reproduces it on the contract as deployed (`test/fleet/FleetPool.t.sol`); an invariant suite with an honest-operator handler, 256 random sequences per property (`test/fleet/FleetPoolInvariants.t.sol`). Run both with `npx hardhat test solidity`.
**Purpose:** shorten and cheapen the professional audit the spec requires before real funds (FR-016). Every finding here is something an auditor would otherwise be paid to find. None of it changes the product's claims.

Severity follows the usual scale: **High** = loss of funds with a realistic path; **Medium** = loss of funds needing a mistake or an unusual sequence, or a broken guarantee; **Low** = defence in depth; **Info** = worth knowing, no action forced.

---

## Threat model

Three parties touch the pool.

| Party | Can | Cannot |
|---|---|---|
| Trader | deposit fixed sizes, request and execute an exit, control fleet accounts through the owner escape hatch | see or affect other traders, touch draws |
| Operator (one EOA, immutable) | open, fund, top up, close draws; send principal; commit and roll back; queue and post spend to **any** depositor for **any** amount; claim gas; pause | read the depositor behind a draw on chain (by design); claim more than fronted gas |
| Anyone | read every event and view | nothing else |

The contract's stated guarantee is narrow and it holds: no function or event names both a depositor and a campaign (verified by reading the ABI, and by the existing observer test). What the contract does **not** guarantee, and what an auditor will write on page one, is solvency: draws are bounded per campaign but not by any depositor's balance, so the operator key is a full custodian of the pool up to `POOL_CAP`. The README says "the operator can link them"; it should also say "the operator can move them". F2 pins the size of that trust.

---

## Findings

### F1 · Medium · A deposit made after `requestExit` is lost

`deposit()` does not check `exitRequestedAt`. A trader who requests an exit and then deposits again (the app does not stop them) has the new deposit added to `deposited`, but `executeExit` pays `min(exitAmount, unspent)` where `exitAmount` was snapshotted before the second deposit, then `delete`s the whole record. The difference stays in the pool, attached to nobody, and nothing can ever pay it out: `claimable()` is bounded by draw spend, and there is no depositor to exit.

Reproduction: `test_finding_F1_depositAfterExitRequestIsLost`. 0.05 in, exit requested, 0.1 in, 24 h, exit pays 0.05, pool keeps 0.1 with `totalDeposited` and every depositor record at zero.

Fix, one line in `deposit()`: `if (d.exitRequestedAt != 0) revert ExitPending();`. Alternatively clear the exit on deposit, but refusing is clearer to the trader. The app should grey out deposit while an exit is pending regardless.

### F2 · High (centralization, disclosed) · The operator can empty the pool

`openDraw` checks `DRAW_CAP` and nothing about deposits. `fund` and `fundPrincipal` send to any address the operator names. An operator, or anyone holding its key, opens campaigns until the pool is dry. Traders' exits then revert with `TransferFailed`.

Reproduction: `test_finding_F2_operatorCanEmptyThePool`. 0.3 ETH from two traders, two rogue campaigns, pool at zero, Alice's exit reverts.

This is the design, not a bug, and the pool cap exists for exactly this reason. It still needs to be stated as custody in the disclosure and mitigated before mainnet, because "operator can see the link" and "operator can take the money" are different sentences. Recommendations, cheapest first:

- **R2a** A `guardian` address that can only call `setPaused(true)`. Pause already blocks `openDraw` and `fundPrincipal` while leaving exits open. A guardian lets a monitor, a second person, or a multisig stop an outflow in one transaction without holding the key that moves funds. Twenty lines, leaks nothing.
- **R2b** The operator as a 2-of-3 multisig on mainnet, with the hot service key holding a bounded session of its own (the project already has that pattern in `FleetSessionPolicy`). *On `feat/operator-hardening` (2026-09-16): the split, not yet the multisig. `FleetPool` and `FleetSessionPolicy` are `Ownable2Step`; the owner is a cold admin that rotates the operator, unpauses, names the guardian and claims; the operator moves money and nothing else. The admin is any address, so a Safe drops in later without a redeploy. `test/fleet/FleetPoolAdmin.t.sol`.*
- **R2c** A rate limit on outflow: `fund` plus `fundPrincipal` per rolling hour ≤ some fraction of the pool balance. Aggregate only, so it names no depositor. Turns "everything in one block" into "a fraction per hour, with the monitor watching".
- **R2d** Two-step operator transfer with a delay, so a key can be rotated after a compromise instead of the contract being abandoned. *On `feat/operator-hardening`: `setOperator` by the admin, in one step (the admin handover itself is the two-step); no delay, because the compromise case wants the rotation now.*

### F3 · High for mainnet, Medium on testnet · A failed buy pays the trader the principal, at the operator's expense

The service sends principal with `fundPrincipal`, executes the buy in a second transaction, and on failure calls `rollback` with the operator's own ETH (`pool-buy.ts` lines 262 to 300, and the comment says so: "the operator absorbs the principal, which lands in the trader's own fleet account and is theirs to sweep"). At the contract level: principal is in the fleet account, which the trader controls; the draw is charged nothing; the operator is short by the principal.

A trader who can make `execute` revert is paid the principal by the operator each time. On a live venue that is not hard: a buy with a slippage bound fails whenever the price moves against it, and the trader can move the price. `DRAW_CAP` bounds one campaign at 0.2 ETH, but campaigns are unbounded.

Reproduction: `test_finding_F3_failedBuyIsPaidByTheOperator`.

Fix: make funding and execution atomic, so a reverted buy reverts the transfer. Two shapes:
- **R3a** The fleet account pulls the principal from the pool inside `execute` (pool exposes `pullPrincipal(campaign)` callable only by an account the draw was funded for, in the same transaction as the swap), so a revert unwinds both.
- **R3b** A pool function `fundAndExecute(campaign, account, principal, gasCeiling, target, data)` that sends, calls `account.execute`, and reverts wholesale on failure. Simpler, and the session policy already bounds what `execute` may do.
Until then: bound the number of failed buys per campaign in the service, and count principal lost to failed buys in the operator's monitoring.

### F4 · Low · `commit` accepts less than the principal that left

`commit(actual)` only requires `actual <= reserved`. The service always charges `principal + min(gas, ceiling)`, so this never happens today; a service bug or a replaced service would leave `principal - actual` in fleet accounts uncharged, unnoticed by any view.

Reproduction: `test_finding_F4_commitBelowPrincipalIsAccepted`, 0.05 ETH out, 1 wei charged.

Fix: `if (actual < draw.principalOut) revert CommitBelowPrincipal();`.

### F5 · Low · A queued spend can be born unpostable

`POST_WINDOW` runs from `queuedAt`; `dueAt` is unchecked. A `dueAt` later than `queuedAt + 12 h` produces a spend that is never inside its window, and the charge is silently lost. The service's delay is 1 to 15 minutes so this does not happen today; the contract should refuse it anyway, because a lost charge is an insolvent pool by that amount.

Reproduction: `test_finding_F5_queuedSpendCanNeverBePosted`.

Fix in `queueSpend`: `if (dueAt > block.timestamp + POST_WINDOW) revert DueBeyondWindow();`.

### F6 · Info · Posted spend is bounded by nothing on chain

`postQueued` charges any depositor any amount, and `queueSpend` accepts any amount. The contract cannot know the right depositor (that is the design). It also does not track the aggregate, so nobody can check from outside that the sum posted is at most the sum drawn plus the sum paid out in withdrawals.

Reproduction: `test_finding_F6_postedSpendExceedsAllDrawSpend`, 1 ETH posted against 0 of draw spend.

The bound cannot be enforced on chain because withdrawals are paid from the operator's wallet on purpose. It can be made **auditable**: a `totalPosted` counter and a `totalWithdrawn` counter the operator increments when it pays a withdrawal, both aggregate, both public. Anyone can then verify `totalPosted <= totalDrawSpent + totalWithdrawn` with two view calls, and the invariant suite already states that property as `invariant_postedNeverExceedsWhatWasTaken`. A dishonest increment is possible but leaves a permanent, checkable trail.

### F7 · Medium-Low · A trader can keep trading for 24 hours after requesting an exit

Nothing in the service refuses `openDraw`, `fundPrincipal` or `withdraw` for a depositor with `exitRequestedAt != 0` (`campaign-routes.ts` and `pool-buy.ts` read it for display only). Charges queued in the last minutes before `executeExit` are not yet postable when the exit pays, and the exit deletes the record, so those charges land on an empty depositor and the pool eats them. Bounded by one buy per campaign, so small, but it is the one way a trader takes value from the pool without the operator's cooperation.

No contract change needed. The service should refuse draw, buy and withdrawal for a depositor whose exit is pending, and the app should hide Activate. The invariant handler models exactly this rule (`requestExit` closes the trader's open draws first).

### F8 · Info · Operator is immutable; no rotation, no separate pause authority

`operator` is `immutable`. A compromised key cannot be rotated; the only response is `setPaused`, by the same key. See R2a and R2d.

---

## What holds, and was checked

- Checks-effects-interactions everywhere ETH leaves: `executeExit` deletes before sending, `fund` and `fundPrincipal` update the draw before the loop, `claimOperator` increments before sending. A reentrant fleet account cannot be funded twice (`test_reentrantAccountCannotDoubleFund`).
- Deposit sizes, depositor cap, pool cap, draw cap: enforced before any state change, held under 256 random sequences (`invariant_depositCapsHold`, `invariant_drawsStayInsideTheirCaps`, `testFuzz_onlyPublishedSizesAreAccepted`).
- `claimable()` is exactly the gas the operator fronted, never principal or headroom (`test_claimableIsExactlyTheGasFronted`, `invariant_claimableIsGasOnly`).
- The exit works while paused and needs nothing from the operator (`test_exitWorksWhilePausedAndWithoutTheOperator`).
- Spend posted during the exit wait is honoured, so exiting is not a way out of a bill (`test_spendPostedAfterExitRequestStillCounts`).
- `MIN_FUNDING_DELAY` and `NotDue` hold (`test_fundingBeforeDueIsRefused`).
- Accounting identity: balance equals deposits minus outflow minus exits minus claims, always (`invariant_balanceIsAccountedFor`). `totalOutflow` is already net of rollbacks.
- Under an honest operator the pool can always pay every trader once posted spend catches up with draw spend (`invariant_solventForHonestTraders`). This invariant is the definition of "the ledger is right"; F2 is what happens when the operator is not honest.

---

## Order of work

1. F1, F4, F5: three one-line reverts. Do them together; they change no behaviour the service relies on, and each flips a `test_finding_*` from passing to failing in the expected way, so the tests should be updated to `expectRevert` in the same change.
2. F7: service-side refusal, a few lines in `campaign-routes.ts`, plus hiding Activate in the app.
3. F3: the atomic funding path. This is the one that needs design time, and it is the one a mainnet auditor will not let through.
4. F2 mitigations, before mainnet: guardian pause first (R2a), then multisig operator (R2b). Say "custody" in the disclosure.
5. F6 counters: with the F1/F4/F5 batch if convenient.

None of this is a reason to hold the testnet. All of it is a reason not to hold real money yet, which the spec already says.
