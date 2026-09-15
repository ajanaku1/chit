# FleetPool Contract Interface

Solidity 0.8.x, deployed on 46630. Operator is the Stage 1 operator key.

## Trader functions
- `deposit() payable` — msg.value must be an allowed size; refused when paused or over a cap. Emits `Deposited(depositor, amount)`.
- `requestExit()` — records `exitRequestedAt` and `exitAmount = deposited − spent`. Emits `ExitRequested(depositor, amount, availableAt)`.
- `executeExit()` — after the delay and only when no queued spend created before the request is unposted; pays `min(exitAmount, deposited − spent)` to the depositor; zeroes the record. Emits `ExitPaid(depositor, amount)`.

## Operator functions
- `setPaused(bool)`.
- `openDraw(bytes32 campaign, uint256 amount, uint64 dueAt, bytes ownerRef)` — Pending draw; refused over per-draw cap. Emits `DrawOpened(campaign, amount, dueAt)`; `ownerRef` is stored, not indexed.
- `fund(bytes32 campaign, address[] accounts)` — after `dueAt`; sends gas headroom to each account; marks Funded. Emits `DrawFunded(campaign)`.
- `fundPrincipal(bytes32 campaign, address account, uint256 principal, uint256 gasCeiling)` — reserves `principal + gasCeiling` on the draw and sends `principal` to the account. Emits `PrincipalSent(campaign, account, principal)`.
- `commit(bytes32 campaign, uint256 actual)` / `rollback(bytes32 campaign, uint256 principalReturned) payable` — settle or undo the last reservation; rollback returns the principal.
- `queueSpend(bytes encDepositor, uint256 amount, uint64 dueAt)` — records a pending posting; emits `SpendQueued(id, amount, dueAt)`. `postQueued(uint256 id, address depositor)` — after `dueAt`; adds to the depositor's `spent`; emits `SpendPosted(depositor, amount)`. `postCredit(address depositor, uint256 amount)` — reduces `spent` on close. None takes a campaign argument.
- `closeDraw(bytes32 campaign)` — marks Closed and releases `amount − spent` to the pool's unassigned balance (the matching `postCredit` is a separate call).
- `claimOperator(uint256 amount)` — pays the operator up to `Σ spent posted − Σ principal already moved out − Σ claimed`.

## Events never combine a depositor and a campaign
Every event and function names at most one of {depositor, campaign}. Tests assert this over the full ABI.

## Errors
`NotOperator`, `Paused`, `SizeNotAllowed`, `DepositorCapExceeded`, `PoolCapExceeded`, `DrawCapExceeded`, `DrawExists`, `DrawNotPending`, `DrawNotFunded`, `DrawNotOpen`, `NotDue`, `DrawExceeded`, `PostWindowClosed`, `AlreadyPosted`, `NothingReserved`, `ReservationOpen`, `CommitExceedsReservation`, `CommitBelowPrincipal`, `PrincipalMismatch`, `NothingDeposited`, `ExitNotRequested`, `ExitNotDue`, `ExitPending`, `DueBeyondWindow`, `ClaimExceeded`, `TransferFailed`, `NoAccounts`, `DelayTooShort`.

`paused` refuses deposits, draws, funding, principal, top-ups and the operator claim; exits are never paused. A `guardian`, set by the operator, may call `pause()` and nothing else; only the operator unpauses (`setPaused(false)`) or changes the guardian. `NotGuardian` when anyone else calls `pause()`. `deposit` refuses a wallet whose exit is pending. `commit` refuses an amount below the principal that left. `queueSpend` refuses a `dueAt` beyond `POST_WINDOW`.
