// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { PoolKey } from "../fleet/FleetPoolSeeder.sol";

interface IUniversalRouterMinimal {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPoolManagerState {
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IBurnableToken {
    function balanceOf(address owner) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function burn(uint256 amount) external;
}

/// @title ChitBuyback
/// @notice ETH in, CHIT bought on the venue and burned, nothing else. No
///         owner, no withdraw, no parameter anyone can change after deploy:
///         whoever holds the deployer's key holds nothing here. Anyone can
///         call `buyAndBurn`; it spends a fixed share of whatever the
///         contract holds (with a floor and a cap), no more often than
///         `interval`, and refuses a fill worse than `maxSlipBps` under the
///         pool's own quote, so a caller who moves the price first gets a
///         revert, not a discount.
///
///         Sizing follows the balance, so a bigger deposit means bigger buys
///         and a quiet week means smaller ones; the floor makes sure the
///         last of the balance is spent rather than dust left forever, the
///         cap bounds the impact of any single buy. Every buy is an event
///         with running totals, so the day's report is a read of the chain.
contract ChitBuyback {
    IBurnableToken public immutable token;
    IUniversalRouterMinimal public immutable router;
    IPoolManagerState public immutable poolManager;
    /// @dev The pool key's fields, immutable one by one (structs cannot be).
    uint24 public immutable poolFee;
    int24 public immutable poolTickSpacing;
    address public immutable poolHooks;
    bytes32 public immutable poolId;

    /// @notice Share of the balance spent per call, in basis points.
    uint16 public immutable spendBps;
    /// @notice Never less than this per call (the whole balance when less is left).
    uint256 public immutable minSpend;
    /// @notice Never more than this per call.
    uint256 public immutable maxSpend;
    /// @notice Seconds between calls.
    uint32 public immutable interval;
    /// @notice The worst fill accepted, in basis points under the zero-fee pool quote; the hook's own fee has to fit inside it.
    uint16 public immutable maxSlipBps;

    uint256 public lastBuyAt;
    uint256 public buys;
    uint256 public totalReceived;
    uint256 public totalSpent;
    uint256 public totalBought;
    uint256 public totalBurned;

    event Funded(address indexed from, uint256 amount, uint256 balance);
    event BoughtAndBurned(address indexed caller, uint256 ethIn, uint256 tokensBought, uint256 tokensBurned, uint256 totalSpent, uint256 totalBurned);

    error BadParams();
    error TooSoon(uint256 dueAt);
    error NothingToSpend();
    error NoPrice();
    error TooLittleOut(uint256 got, uint256 minOut);

    uint256 private constant Q96 = 1 << 96;
    uint256 private constant POOLS_SLOT = 6;
    bytes1 private constant COMMAND_V4_SWAP = 0x10;
    bytes private constant ACTIONS = hex"060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    constructor(
        address token_,
        address router_,
        address poolManager_,
        uint24 poolFee_,
        int24 poolTickSpacing_,
        address poolHooks_,
        uint16 spendBps_,
        uint256 minSpend_,
        uint256 maxSpend_,
        uint32 interval_,
        uint16 maxSlipBps_
    ) {
        if (token_ == address(0) || router_ == address(0) || poolManager_ == address(0)) revert BadParams();
        if (spendBps_ == 0 || spendBps_ > 10_000 || minSpend_ == 0 || maxSpend_ < minSpend_ || interval_ == 0 || maxSlipBps_ >= 10_000) revert BadParams();
        token = IBurnableToken(token_);
        router = IUniversalRouterMinimal(router_);
        poolManager = IPoolManagerState(poolManager_);
        poolFee = poolFee_;
        poolTickSpacing = poolTickSpacing_;
        poolHooks = poolHooks_;
        // ETH is currency0 (address zero sorts first); the token is currency1.
        poolId = keccak256(abi.encode(PoolKey(address(0), token_, poolFee_, poolTickSpacing_, poolHooks_)));
        spendBps = spendBps_;
        minSpend = minSpend_;
        maxSpend = maxSpend_;
        interval = interval_;
        maxSlipBps = maxSlipBps_;
    }

    /// @notice Fees and top-ups arrive here; a plain transfer does the same.
    receive() external payable {
        totalReceived += msg.value;
        emit Funded(msg.sender, msg.value, address(this).balance);
    }

    function fund() external payable {
        totalReceived += msg.value;
        emit Funded(msg.sender, msg.value, address(this).balance);
    }

    /// @notice When the next call is allowed.
    function dueAt() public view returns (uint256) {
        return lastBuyAt + interval;
    }

    /// @notice What the next call would spend: the share of the balance, floored, capped, never more than the balance.
    function nextSpend() public view returns (uint256) {
        uint256 balance = address(this).balance;
        if (balance == 0) return 0;
        uint256 amount = (balance * spendBps) / 10_000;
        if (amount < minSpend) amount = minSpend;
        if (amount > maxSpend) amount = maxSpend;
        if (amount > balance) amount = balance;
        return amount;
    }

    /// @notice The pool's price and liquidity, read from the manager's storage the way the app does.
    function poolState() public view returns (uint160 sqrtPriceX96, uint128 liquidity) {
        bytes32 slot0Slot = keccak256(abi.encode(poolId, POOLS_SLOT));
        bytes32 slot0 = poolManager.extsload(slot0Slot);
        sqrtPriceX96 = uint160(uint256(slot0));
        bytes32 liq = poolManager.extsload(bytes32(uint256(slot0Slot) + 3));
        liquidity = uint128(uint256(liq));
    }

    /// @notice Tokens an exact-in buy of `ethIn` would get from one full-range position at zero fee: the pool's own quote, before the hook's fee.
    function quote(uint256 ethIn) public view returns (uint256) {
        (uint160 sqrtP, uint128 liquidity) = poolState();
        if (sqrtP == 0 || liquidity == 0) return 0;
        // sqrtP' = L * sqrtP / (L + ethIn * sqrtP / Q96); out = L * (sqrtP - sqrtP') / Q96, in 512-bit steps so no pool overflows it.
        uint256 denominator = uint256(liquidity) + Math.mulDiv(ethIn, sqrtP, Q96);
        uint256 sqrtNext = Math.mulDiv(liquidity, sqrtP, denominator);
        return Math.mulDiv(liquidity, uint256(sqrtP) - sqrtNext, Q96);
    }

    /// @notice The buy and the burn, by anyone, when due.
    function buyAndBurn() external {
        uint256 due = dueAt();
        if (block.timestamp < due) revert TooSoon(due);
        uint256 amount = nextSpend();
        if (amount == 0) revert NothingToSpend();
        uint256 quoted = quote(amount);
        if (quoted == 0) revert NoPrice();
        uint256 minOut = (quoted * (10_000 - maxSlipBps)) / 10_000;
        lastBuyAt = block.timestamp;

        uint256 before = token.balanceOf(address(this));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams({
            poolKey: PoolKey(address(0), address(token), poolFee, poolTickSpacing, poolHooks),
            zeroForOne: true,
            amountIn: uint128(amount),
            amountOutMinimum: uint128(minOut),
            hookData: ""
        }));
        params[1] = abi.encode(address(0), amount);
        params[2] = abi.encode(address(token), minOut);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(ACTIONS, params);
        router.execute{ value: amount }(abi.encodePacked(COMMAND_V4_SWAP), inputs, block.timestamp);

        uint256 got = token.balanceOf(address(this)) - before;
        if (got < minOut) revert TooLittleOut(got, minOut);
        // Everything held is burned, including any token sent here directly.
        uint256 burning = token.balanceOf(address(this));
        token.burn(burning);

        buys += 1;
        totalSpent += amount;
        totalBought += got;
        totalBurned += burning;
        emit BoughtAndBurned(msg.sender, amount, got, burning, totalSpent, totalBurned);
    }
}
