// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ChitPaymaster} from "./ChitPaymaster.sol";
import {ChitSettlement} from "./ChitSettlement.sol";
import {ChitVault} from "./ChitVault.sol";

contract ChitRoundCoreDeployer {
    address public immutable entryPoint;
    address public immutable wrapper;
    address public immutable factory;

    error NotFactory();

    constructor(address entryPoint_, address wrapper_, address factory_) {
        entryPoint = entryPoint_;
        wrapper = wrapper_;
        factory = factory_;
    }

    function deployRound(
        address creator,
        address operator,
        address verifier,
        address auditor
    ) external returns (address vault, address settlement, address paymaster) {
        require(msg.sender == factory, NotFactory());
        vault = address(new ChitVault(wrapper, auditor, creator, factory));
        settlement = address(
            new ChitSettlement(vault, auditor, creator, operator, factory)
        );
        paymaster = address(
            new ChitPaymaster(
                entryPoint,
                vault,
                settlement,
                creator,
                operator,
                verifier,
                factory
            )
        );
    }
}
