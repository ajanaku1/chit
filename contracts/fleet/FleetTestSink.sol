// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Fleet test sink
/// @notice Test-only stand-in for a venue: a payable target a fleet account can
///         call with the trade principal, so pooled settlement can be proven on
///         a local EVM without a seeded Uniswap pool. Never deployed to a live
///         chain; the real venue is the Universal Router (see fleet-venue).
contract FleetTestSink {
    mapping(address account => uint256 total) public bought;
    uint256 public totalBought;

    event Bought(address indexed account, uint256 amount);

    error Refused();

    /// @notice Accepts a buy. Reverts on zero value so a failed buy is easy to
    ///         provoke in a test without a second contract.
    function buy() external payable {
        if (msg.value == 0) revert Refused();
        bought[msg.sender] += msg.value;
        totalBought += msg.value;
        emit Bought(msg.sender, msg.value);
    }
}
