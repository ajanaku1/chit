// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal Uniswap v4 core surface: only what seeding one ETH/token pool needs.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPoolManagerMinimal {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
}

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title FleetPoolSeeder
/// @notice Initialises an ETH/token Uniswap v4 pool and adds one liquidity
///         position in a single call, paying ETH from msg.value and the token
///         from the caller's approval. Built so Stage 1 can seed a real venue
///         on Robinhood Chain testnet without the v4 PositionManager, whose
///         testnet address is not verified. Test-only tooling: holds nothing.
contract FleetPoolSeeder {
    IPoolManagerMinimal public immutable poolManager;

    struct Seed {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        int256 liquidity;
        address payer;
    }

    error NotPoolManager();
    error EthMustBeCurrency0();
    error RefundFailed();

    constructor(address manager) {
        poolManager = IPoolManagerMinimal(manager);
    }

    /// @dev currency0 must be native ETH (address zero), which v4 orders first.
    function seed(PoolKey calldata key, uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, int256 liquidity)
        external
        payable
    {
        if (key.currency0 != address(0)) revert EthMustBeCurrency0();
        poolManager.initialize(key, sqrtPriceX96);
        poolManager.unlock(abi.encode(Seed(key, tickLower, tickUpper, liquidity, msg.sender)));
        uint256 left = address(this).balance;
        if (left > 0) {
            (bool ok, ) = msg.sender.call{value: left}("");
            if (!ok) revert RefundFailed();
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Seed memory s = abi.decode(data, (Seed));
        (int256 delta, ) = poolManager.modifyLiquidity(
            s.key, ModifyLiquidityParams(s.tickLower, s.tickUpper, s.liquidity, bytes32(0)), ""
        );
        // BalanceDelta packs amount0 in the high 128 bits and amount1 in the low 128.
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        if (amount0 < 0) {
            poolManager.settle{value: uint256(uint128(-amount0))}();
        }
        if (amount1 < 0) {
            poolManager.sync(s.key.currency1);
            IERC20Minimal(s.key.currency1).transferFrom(s.payer, address(poolManager), uint256(uint128(-amount1)));
            poolManager.settle();
        }
        return "";
    }

    receive() external payable {}
}
