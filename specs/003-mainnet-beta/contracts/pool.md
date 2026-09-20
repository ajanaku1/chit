# Contract: FleetPool changes

Additive to the Stage 2 pool. One new bytecode, deployed with the beta caps.

## New and changed functions

```solidity
/// Cumulative charge posted, counting only the part of each charge still
/// backed by unspent deposit.
function totalPosted() external view returns (uint256);

/// Surplus the pool holds over what it owes depositors: covers fronted gas and
/// fronted withdrawals alike. Floored at zero.
/// claimable() == max(0, totalPosted - totalOutflow - totalClaimed)
function claimable() external view returns (uint256);

/// Post many queued charges in one transaction. Never reverts for one bad
/// entry: each entry reports posted, expired, or already posted. Capped in size.
function postQueuedBatch(bytes32[] calldata ids, address[] calldata depositors)
    external returns (PostResult[] memory);

/// Give ETH to the pool, crediting no depositor. Works while paused, because
/// that is when a short pool most needs making whole.
function donate() external payable;

/// Monitor counters, each emitting on change.
function everDeposited() external view returns (uint256);
function exitsPaid() external view returns (uint256);
function donated() external view returns (uint256);
```

## Invariants

- `claimable()` never exceeds the pool's balance less what it owes depositors.
  A full claim can never make the pool unable to pay an exit.
- `balance == everDeposited + donated - totalOutflow - exitsPaid - totalClaimed`,
  assertable by anyone from public views.
- `postQueuedBatch` posts a strict subset of what the same ids would post one at
  a time, and never posts one twice.
- `donate()` succeeds while paused; `deposit()` does not.

## Replaced invariant

`invariant_claimableIsGasOnly` is removed. It asserted the behaviour this change
exists to fix. Its replacement asserts the surplus bound above.
