// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev The one Permit2 call a sell needs: the account lets `spender` pull
///      `token` through Permit2. Uniswap's router settles ERC-20 input this way.
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
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
///      owner cannot grant rules for tokens that do not exist yet. So the
///      owner sets one flag per key instead, `sellAllowed`: with it the key
///      may make the account approve any token to Permit2 and Permit2 to a
///      spender, but only a spender that is already a target of the key's
///      rules. Permit2 moves a token only for that spender, and the spender
///      (the router) moves it only when the account itself calls it, which
///      is an `execute` inside the same rules and caps. The sale is then an
///      ordinary `execute` with zero value; what it can sell is bounded by
///      what the account holds, and the ETH comes back to the account.
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
    event SellApproved(address indexed key, address indexed token, address indexed spender);

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
    error SpenderNotAllowed();

    bool private _executing;

    /// @dev Appended after the original layout: which keys may approve tokens for a sell.
    mapping(address key => bool) private _sellAllowed;

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

    /// @notice Lets `key` set up sells (see the contract notes), or takes that
    ///         back. The session has to exist and not be revoked; revoke ends
    ///         the flag with everything else.
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

    /// @notice The two approvals a sell needs, made by a key the owner let
    ///         sell: the account approves `token` to Permit2 and Permit2
    ///         approves `spender` for it, both without limit so it is done
    ///         once per token. The session must be live and `spender` must
    ///         be a target of one of the key's rules, so the only contract
    ///         that can ever pull the token is one the key was already allowed
    ///         to call, and it pulls only when the account calls it.
    function approveForSell(address token, address spender) external {
        if (_executing) revert Reentered();
        Session storage s = _sessions[msg.sender];
        if (!s.exists) revert NotAuthorized();
        if (s.revoked) revert SessionRevokedError();
        if (s.paused) revert SessionPausedError();
        if (block.timestamp >= s.expiry) revert SessionExpired();
        if (!_sellAllowed[msg.sender]) revert SellNotAllowed();
        bool isTarget;
        uint256 n = s.rules.length;
        for (uint256 i = 0; i < n; ++i) {
            if (s.rules[i].target == spender) {
                isTarget = true;
                break;
            }
        }
        if (!isTarget) revert SpenderNotAllowed();
        _executing = true;
        IERC20(token).forceApprove(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(token, spender, type(uint160).max, type(uint48).max);
        _executing = false;
        emit SellApproved(msg.sender, token, spender);
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
