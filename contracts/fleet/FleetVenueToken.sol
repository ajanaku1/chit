// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FleetVenueToken
/// @notice Minimal ERC-20 used as the Stage 1 demo venue asset on Robinhood
///         Chain testnet. Fixed supply minted to the deployer, who seeds the
///         Uniswap v4 pool with it. Test-only: no value, no admin.
contract FleetVenueToken {
    string public constant name = "Chit Fleet Test Coin";
    string public constant symbol = "FLEET";
    uint8 public constant decimals = 18;
    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        uint256 held = balanceOf[from];
        if (held < value) revert InsufficientBalance();
        balanceOf[from] = held - value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
