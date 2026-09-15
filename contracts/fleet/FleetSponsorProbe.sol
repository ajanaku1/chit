// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Fleet sponsor probe
/// @notice The target of the gas-sponsorship spike: a call that moves no value
///         and leaves one observable mark, so a sponsored operation from an
///         account that holds no ETH can be proven to have run. It stands in
///         for a sponsor's own contract (a game move, a post, a claim); on
///         testnet it is the spike's target and nothing else.
contract FleetSponsorProbe {
    mapping(address account => uint256 count) public pings;

    event Pinged(address indexed account, bytes32 note);

    function ping(bytes32 note) external {
        pings[msg.sender] += 1;
        emit Pinged(msg.sender, note);
    }
}
