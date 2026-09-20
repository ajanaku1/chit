// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PoolKey} from "./FleetPoolSeeder.sol";

/// @dev The one Permit2 call a sell needs: the account lets the router pull
///      the token through Permit2. Uniswap's router settles ERC-20 input this way.
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @dev The Universal Router's one entry point; the account writes its calldata itself for a sale.
interface IUniversalRouterMinimal {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title Session account
/// @notice A smart account with a kill switch. Anyone running a bot today
///         gives it their wallet key. This is the opposite: the owner keeps
///         the wallet, funds this account, and hands the bot a session key
///         that can only do what the owner said, to whom, for how much, until
///         when, and that the owner can pause or revoke in one transaction.
///
///         Nobody but the owner is in the loop. Chit deploys nothing, signs
///         nothing, holds nothing; the bot pays its own gas from its own key
///         and spends the account's ETH within the session. The policy is in
///         this contract, read by anyone, and a session's spend is on chain.
///
/// @dev A session is one key and up to eight rules of (target, selector); a
///      zero selector on a rule allows any function of that target. Value is
///      capped per call and in total. Revoke is terminal for that key; a new
///      key is a new session. The owner's own path (`execute` by the owner,
///      `withdraw`, token rescue) is not gated, since the owner acting
///      directly is the whole point of keeping the wallet.
///
///      Selling is a rule too far. A rule is (target, selector) and a sell
///      through the router first needs the account to approve Permit2 on the
///      token, so the token would be the target, one rule per token, and the
///      owner cannot grant rules for tokens that do not exist yet. And an
///      open `execute` on the router is no sale either: the router's calldata
///      names who receives, so a key holding a standing approval could hand
///      the tokens, or the ETH they fetch, to anyone it likes. So the owner
///      sets one flag per key, `sellAllowed`, and with it the key calls
///      `sell`, where the account writes the router calldata itself: one
///      exact-in swap of `amountIn` of the token for ETH on the pool the key
///      names, the ETH paid to the account because the router pays its
///      caller and nobody else. The two Permit2 approvals exist only inside
///      that call, for `amountIn` and for this block, and are cleared before
///      it returns, so no approval outlives a sale and no other key inherits
///      one. The router has to be a target of the key's rules with the
///      `execute` selector; the sale is a call under the same expiry, pause
///      and revoke, spends none of the ETH caps, and before returning the
///      account checks that no more than `amountIn` of the token left and
///      that at least `minOut` of ETH arrived. What the flag cannot bound is
///      the price: the key names the pool and the floor, so a hostile key
///      can sell into a thin pool of its own with a floor of dust. With the
///      flag the owner trusts the key with the position, not only the caps,
///      and the page says so where the flag is set.
contract SessionAccount {
    using SafeERC20 for IERC20;

    struct Rule {
        address target;
        bytes4 selector;
    }

    struct Session {
        uint128 maxValuePerCall;
        uint128 totalValueCap;
        uint128 spentValue;
        uint48 expiry;
        uint32 calls;
        bool paused;
        bool revoked;
        bool exists;
        Rule[] rules;
    }

    uint256 public constant MAX_RULES = 8;

    /// @notice Permit2, the same address on every chain it is deployed to.
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address public immutable owner;

    mapping(address key => Session) private _sessions;

    event SessionGranted(address indexed key, uint128 maxValuePerCall, uint128 totalValueCap, uint48 expiry, uint256 rules);
    event SessionPaused(address indexed key);
    event SessionResumed(address indexed key);
    event SessionRevoked(address indexed key);
    event Executed(address indexed by, address indexed target, bytes4 indexed selector, uint256 value);
    event Withdrawn(address indexed to, uint256 amount);
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);
    event Received(address indexed from, uint256 amount);
    event SellAllowed(address indexed key, bool allowed);
    event Sold(address indexed key, address indexed token, address indexed router, uint256 amountIn, uint256 ethOut);

    error NotOwner();
    error NotAuthorized();
    error SessionExists();
    error SessionUnknown();
    error SessionRevokedError();
    error SessionPausedError();
    error SessionExpired();
    error RuleNotAllowed();
    error ValueOverCall();
    error ValueOverCap();
    error NoRules();
    error TooManyRules();
    error ZeroKey();
    error ZeroTarget();
    error BadExpiry();
    error CallFailed();
    error EmptyCallData();
    error ZeroRecipient();
    error WithdrawFailed();
    error Reentered();
    error SellNotAllowed();
    error NotEthPool();
    error NoFloor();
    error SoldTooMuch();
    error ProceedsShort();

    bool private _executing;

    /// @dev Appended after the original layout: which keys may sell through `sell`.
    mapping(address key => bool) private _sellAllowed;

    /// @dev The Universal Router's `execute(bytes,bytes[],uint256)`; a sale is only ever that call.
    bytes4 private constant ROUTER_EXECUTE = IUniversalRouterMinimal.execute.selector;
    bytes1 private constant COMMAND_V4_SWAP = 0x10;
    bytes private constant SELL_ACTIONS = hex"060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL

    /// @dev v4-periphery's parameters for one exact-in swap on one pool.
    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroKey();
        owner = owner_;
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    // --- the owner grants, pauses, resumes, revokes ---------------------

    /// @notice Hands `key` a session: the rules it may call, how much ETH per
    ///         call and in total, until when. One session per key, ever.
    function grant(address key, Rule[] calldata rules, uint128 maxValuePerCall, uint128 totalValueCap, uint48 expiry) external onlyOwner {
        if (key == address(0) || key == owner) revert ZeroKey();
        if (_sessions[key].exists) revert SessionExists();
        if (rules.length == 0) revert NoRules();
        if (rules.length > MAX_RULES) revert TooManyRules();
        if (expiry <= block.timestamp) revert BadExpiry();
        if (maxValuePerCall > totalValueCap) revert ValueOverCap();

        Session storage s = _sessions[key];
        s.maxValuePerCall = maxValuePerCall;
        s.totalValueCap = totalValueCap;
        s.expiry = expiry;
        s.exists = true;
        for (uint256 i = 0; i < rules.length; ++i) {
            if (rules[i].target == address(0)) revert ZeroTarget();
            s.rules.push(rules[i]);
        }
        emit SessionGranted(key, maxValuePerCall, totalValueCap, expiry, rules.length);
    }

    function pause(address key) external onlyOwner {
        Session storage s = _live(key);
        s.paused = true;
        emit SessionPaused(key);
    }

    function resume(address key) external onlyOwner {
        Session storage s = _live(key);
        s.paused = false;
        emit SessionResumed(key);
    }

    /// @notice The kill switch. Terminal: the key never acts again.
    function revoke(address key) external onlyOwner {
        Session storage s = _sessions[key];
        if (!s.exists) revert SessionUnknown();
        s.revoked = true;
        emit SessionRevoked(key);
    }

    /// @notice Lets `key` call `sell` (see the contract notes), or takes that
    ///         back, and since nothing of a sale outlives the call, taking it
    ///         back is complete. The session has to exist and not be revoked;
    ///         revoke ends the flag with everything else.
    function setSellAllowed(address key, bool allowed) external onlyOwner {
        _live(key);
        _sellAllowed[key] = allowed;
        emit SellAllowed(key, allowed);
    }

    // --- the bot acts, within its session ----------------------------------

    /// @notice One call. The owner may make any call; a session key only one
    ///         its rules allow, within its value ceilings, before its expiry,
    ///         while not paused and never after a revoke.
    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory result) {
        if (_executing) revert Reentered();
        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        if (msg.sender != owner) {
            if (data.length < 4) revert EmptyCallData();
            _authorize(msg.sender, target, selector, value);
        }
        _executing = true;
        bool ok;
        (ok, result) = target.call{value: value}(data);
        _executing = false;
        if (!ok) revert CallFailed();
        emit Executed(msg.sender, target, selector, value);
    }

    function _authorize(address key, address target, bytes4 selector, uint256 value) private {
        Session storage s = _sessions[key];
        if (!s.exists) revert NotAuthorized();
        if (s.revoked) revert SessionRevokedError();
        if (s.paused) revert SessionPausedError();
        if (block.timestamp >= s.expiry) revert SessionExpired();
        if (value > s.maxValuePerCall) revert ValueOverCall();
        if (s.spentValue + value > s.totalValueCap) revert ValueOverCap();
        bool allowed;
        uint256 n = s.rules.length;
        for (uint256 i = 0; i < n; ++i) {
            Rule storage r = s.rules[i];
            if (r.target == target && (r.selector == bytes4(0) || r.selector == selector)) {
                allowed = true;
                break;
            }
        }
        if (!allowed) revert RuleNotAllowed();
        s.spentValue += uint128(value);
        s.calls += 1;
    }

    /// @notice One sale, by a key the owner let sell: `amountIn` of the pool's
    ///         token for at least `minOut` of ETH, into this account. The
    ///         account writes the router's calldata, so the router pays the
    ///         account and nobody else; the two Permit2 approvals are made
    ///         for `amountIn` and this block only and cleared before the
    ///         call returns. `router` has to be a rule target for `execute`,
    ///         and the call counts like any other but spends none of the
    ///         caps. `poolKey` is the pool the sale goes through, which has
    ///         to be an ETH pool of the token; the price is the pool's.
    function sell(address router, PoolKey calldata poolKey, uint128 amountIn, uint128 minOut, uint256 deadline) external {
        if (_executing) revert Reentered();
        if (!_sellAllowed[msg.sender]) revert SellNotAllowed();
        if (poolKey.currency0 != address(0) || poolKey.currency1 == address(0)) revert NotEthPool();
        if (minOut == 0) revert NoFloor();
        _authorize(msg.sender, router, ROUTER_EXECUTE, 0);
        address token = poolKey.currency1;
        uint256 tokenBefore = IERC20(token).balanceOf(address(this));
        uint256 ethBefore = address(this).balance;

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams({
            poolKey: poolKey,
            zeroForOne: false,
            amountIn: amountIn,
            amountOutMinimum: minOut,
            hookData: ""
        }));
        params[1] = abi.encode(token, uint256(amountIn));
        params[2] = abi.encode(address(0), uint256(minOut));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(SELL_ACTIONS, params);

        _executing = true;
        IERC20(token).forceApprove(PERMIT2, amountIn);
        IPermit2(PERMIT2).approve(token, router, amountIn, uint48(block.timestamp));
        (bool ok, ) = router.call(abi.encodeCall(IUniversalRouterMinimal.execute, (abi.encodePacked(COMMAND_V4_SWAP), inputs, deadline)));
        IPermit2(PERMIT2).approve(token, router, 0, 0);
        IERC20(token).forceApprove(PERMIT2, 0);
        _executing = false;
        if (!ok) revert CallFailed();

        uint256 tokenAfter = IERC20(token).balanceOf(address(this));
        if (tokenAfter + amountIn < tokenBefore) revert SoldTooMuch();
        uint256 ethAfter = address(this).balance;
        if (ethAfter < ethBefore + minOut) revert ProceedsShort();
        emit Sold(msg.sender, token, router, tokenBefore - tokenAfter, ethAfter - ethBefore);
    }

    // --- the owner's own money ----------------------------------------------

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroRecipient();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(to, amount);
    }

    function withdrawToken(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroRecipient();
        token.safeTransfer(to, amount);
        emit TokenWithdrawn(address(token), to, amount);
    }

    // --- reading -------------------------------------------------------------

    function sessionOf(address key)
        external
        view
        returns (bool exists, bool paused, bool revoked, uint48 expiry, uint128 maxValuePerCall, uint128 totalValueCap, uint128 spentValue, uint32 calls)
    {
        Session storage s = _sessions[key];
        return (s.exists, s.paused, s.revoked, s.expiry, s.maxValuePerCall, s.totalValueCap, s.spentValue, s.calls);
    }

    function rulesOf(address key) external view returns (Rule[] memory) {
        return _sessions[key].rules;
    }

    function sellAllowed(address key) external view returns (bool) {
        return _sellAllowed[key];
    }

    /// @notice Whether `key` could sell through `router` right now, and why not if not.
    function canSell(address key, address router) external view returns (bool, string memory) {
        if (!_sellAllowed[key]) return (false, "sell not allowed");
        return this.canExecute(key, router, ROUTER_EXECUTE, 0);
    }

    /// @notice Whether `key` could make this call right now, and why not if not.
    function canExecute(address key, address target, bytes4 selector, uint256 value) external view returns (bool, string memory) {
        Session storage s = _sessions[key];
        if (!s.exists) return (false, "unknown");
        if (s.revoked) return (false, "revoked");
        if (s.paused) return (false, "paused");
        if (block.timestamp >= s.expiry) return (false, "expired");
        if (value > s.maxValuePerCall) return (false, "value over call");
        if (s.spentValue + value > s.totalValueCap) return (false, "value over cap");
        uint256 n = s.rules.length;
        for (uint256 i = 0; i < n; ++i) {
            Rule storage r = s.rules[i];
            if (r.target == target && (r.selector == bytes4(0) || r.selector == selector)) return (true, "");
        }
        return (false, "rule not allowed");
    }

    function _live(address key) private view returns (Session storage s) {
        s = _sessions[key];
        if (!s.exists) revert SessionUnknown();
        if (s.revoked) revert SessionRevokedError();
    }
}
