// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title FleetTestCounter
/// @notice A target for fork tests: a fleet account's `execute` points here and
///         the test reads `count` to see exactly how many approved buys ran.
///         Test-only: no value, no admin. It replaces the counter that lived in
///         the hackathon layer's asset file, retired 2026-09-15.
contract FleetTestCounter {
    uint256 public count;

    event Incremented(address indexed account, uint256 count);

    function increment() external {
        count++;
        emit Incremented(msg.sender, count);
    }
}
