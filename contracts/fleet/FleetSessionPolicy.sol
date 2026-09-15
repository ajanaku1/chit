// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Fleet session policy
/// @notice One bounded session per campaign, authorizing exactly one approved
///         buy from a generated fleet account (FR-007, FR-008, FR-013).
/// @dev Mirrors `src/fleet/session-policy.ts` so a request the service refuses
///      off chain is refused here too, and revocation is terminal on both sides.
contract FleetSessionPolicy {
    struct Session {
        uint256 chainId;
        address router;
        bytes4 selector;
        uint256 maxTradeValue;
        uint256 perAccountGas;
        uint256 totalGas;
        uint64 expiry;
        uint256 spentGas;
        bool paused;
        bool revoked;
        bool exists;
    }

    address public immutable operator;

    /// @notice The funding pool allowed to drive a fleet account's execute in
    ///         the same transaction that funds it. Set by the operator; zero
    ///         means only the operator executes, as before.
    address public pool;

    event PoolSet(address pool);

    mapping(bytes32 campaign => Session) private _sessions;
    mapping(bytes32 campaign => mapping(address account => bool enrolled)) private _accounts;

    event SessionOpened(bytes32 indexed campaign, address router, bytes4 selector, uint64 expiry);
    event SessionPaused(bytes32 indexed campaign);
    event SessionResumed(bytes32 indexed campaign);
    event SessionRevoked(bytes32 indexed campaign);
    event GasSpent(bytes32 indexed campaign, address indexed account, uint256 gasCost);

    error NotOperator();
    error SessionMissing();
    error SessionExists();
    error RevokedTerminal();
    error SessionPausedError();
    error CampaignExpired();
    error ChainMismatch();
    error UnknownAccount();
    error UnapprovedTarget();
    error UnapprovedFunction();
    error TradeValueExceeded();
    error PerAccountGasExceeded();
    error TotalGasExceeded();
    error AccountCountOutOfRange();
    error AccountsNotStrictlyIncreasing();

    uint256 public constant MIN_ACCOUNTS = 5;
    uint256 public constant MAX_ACCOUNTS = 50;

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address operator_) {
        operator = operator_;
    }

    function setPool(address pool_) external onlyOperator {
        pool = pool_;
        emit PoolSet(pool_);
    }

    /// @notice Opens the campaign's single session over its generated accounts.
    /// @param accounts Fleet accounts in strictly increasing address order, which
    ///        is how distinctness is enforced without an O(n^2) scan.
    function openSession(
        bytes32 campaign,
        Session calldata session,
        address[] calldata accounts
    ) external onlyOperator {
        if (_sessions[campaign].exists) revert SessionExists();
        if (accounts.length < MIN_ACCOUNTS || accounts.length > MAX_ACCOUNTS) revert AccountCountOutOfRange();

        // Sanity-check the session so a malformed one can never open: it must be
        // for this chain, not already expired, with a real router and a total
        // gas budget that can cover at least one per-account request.
        if (session.chainId != block.chainid) revert ChainMismatch();
        if (session.expiry <= block.timestamp) revert CampaignExpired();
        if (session.router == address(0)) revert UnapprovedTarget();
        if (session.perAccountGas > session.totalGas) revert TotalGasExceeded();

        address previous = address(0);
        for (uint256 index = 0; index < accounts.length; ++index) {
            if (accounts[index] <= previous) revert AccountsNotStrictlyIncreasing();
            previous = accounts[index];
            _accounts[campaign][accounts[index]] = true;
        }

        _sessions[campaign] = Session({
            chainId: session.chainId,
            router: session.router,
            selector: session.selector,
            maxTradeValue: session.maxTradeValue,
            perAccountGas: session.perAccountGas,
            totalGas: session.totalGas,
            expiry: session.expiry,
            spentGas: 0,
            paused: false,
            revoked: false,
            exists: true
        });

        emit SessionOpened(campaign, session.router, session.selector, session.expiry);
    }

    function sessionOf(bytes32 campaign) external view returns (Session memory) {
        return _requireSession(campaign);
    }

    function isEnrolled(bytes32 campaign, address account) external view returns (bool) {
        return _accounts[campaign][account];
    }

    function pause(bytes32 campaign) external onlyOperator {
        Session storage current = _requireSessionStorage(campaign);
        if (current.revoked) revert RevokedTerminal();
        current.paused = true;
        emit SessionPaused(campaign);
    }

    /// @notice Resumes a paused campaign. A revoked campaign can never resume.
    function resume(bytes32 campaign) external onlyOperator {
        Session storage current = _requireSessionStorage(campaign);
        if (current.revoked) revert RevokedTerminal();
        current.paused = false;
        emit SessionResumed(campaign);
    }

    /// @notice Ends sponsorship for good. Close is the campaign's only remaining action.
    function revoke(bytes32 campaign) external onlyOperator {
        Session storage current = _requireSessionStorage(campaign);
        current.revoked = true;
        emit SessionRevoked(campaign);
    }

    /// @notice Reverts unless the request is inside every campaign bound.
    function check(
        bytes32 campaign,
        address account,
        address target,
        bytes4 selector,
        uint256 value,
        uint256 gasCost
    ) public view {
        Session memory current = _requireSession(campaign);

        if (current.revoked) revert RevokedTerminal();
        if (current.paused) revert SessionPausedError();
        if (block.timestamp >= current.expiry) revert CampaignExpired();
        if (block.chainid != current.chainId) revert ChainMismatch();
        if (!_accounts[campaign][account]) revert UnknownAccount();
        if (target != current.router) revert UnapprovedTarget();
        if (selector != current.selector) revert UnapprovedFunction();
        if (value > current.maxTradeValue) revert TradeValueExceeded();
        if (gasCost > current.perAccountGas) revert PerAccountGasExceeded();
        if (current.spentGas + gasCost > current.totalGas) revert TotalGasExceeded();
    }

    /// @notice Checks a request and records its gas against the campaign's total.
    function authorize(
        bytes32 campaign,
        address account,
        address target,
        bytes4 selector,
        uint256 value,
        uint256 gasCost
    ) external onlyOperator {
        check(campaign, account, target, selector, value, gasCost);
        _sessions[campaign].spentGas += gasCost;
        emit GasSpent(campaign, account, gasCost);
    }

    function _requireSession(bytes32 campaign) private view returns (Session memory current) {
        current = _sessions[campaign];
        if (!current.exists) revert SessionMissing();
    }

    function _requireSessionStorage(bytes32 campaign) private view returns (Session storage current) {
        current = _sessions[campaign];
        if (!current.exists) revert SessionMissing();
    }
}
