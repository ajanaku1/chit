// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20ToERC7984Wrapper} from "@iexec-nox/nox-confidential-contracts/contracts/token/extensions/ERC20ToERC7984Wrapper.sol";

contract ChitToken is ERC20 {
    constructor(address recipient, uint256 initialSupply) ERC20("Chit Collateral", "CHIT") {
        _mint(recipient, initialSupply);
    }
}

contract ChitBudgetToken is ERC20ToERC7984Wrapper {
    constructor(
        IERC20 underlying
    )
        ERC20ToERC7984Wrapper(
            "Confidential Chit Budget",
            "cCHIT",
            "ipfs://chit-budget",
            underlying
        )
    {}
}

contract ChitCounter {
    uint256 public count;

    event Incremented(address indexed account, uint256 count);

    function increment() external {
        count++;
        emit Incremented(msg.sender, count);
    }
}
