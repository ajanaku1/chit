// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SessionAccount} from "./SessionAccount.sol";

/// @title Session account factory
/// @notice Deploys a SessionAccount for whoever asks, at an address anyone
///         can compute in advance from the owner and a salt. No operator, no
///         registry, no fee: the factory is a convenience for the owner's
///         wallet and for a page that wants to show the address before the
///         transaction lands.
contract SessionAccountFactory {
    event AccountCreated(address indexed owner, address indexed account, bytes32 salt);

    /// @notice Deploys an account for `owner`; returns the existing one if the
    ///         same owner and salt were used before, so a retried transaction
    ///         is harmless.
    function createAccount(address owner, bytes32 salt) external returns (SessionAccount account) {
        address predicted = accountOf(owner, salt);
        if (predicted.code.length != 0) return SessionAccount(payable(predicted));
        account = new SessionAccount{salt: keccak256(abi.encode(owner, salt))}(owner);
        emit AccountCreated(owner, address(account), salt);
    }

    function accountOf(address owner, bytes32 salt) public view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                keccak256(abi.encode(owner, salt)),
                keccak256(abi.encodePacked(type(SessionAccount).creationCode, abi.encode(owner)))
            )
        );
        return address(uint160(uint256(hash)));
    }
}
