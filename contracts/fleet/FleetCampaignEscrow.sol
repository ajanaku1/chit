// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Fleet campaign escrow
/// @notice Holds one campaign's ETH sponsorship budget, reserves before a
///         sponsored request, commits only its permitted cost, and returns the
///         unused balance to the campaign owner on close (FR-009, FR-016, SC-004).
/// @dev Mirrors `src/fleet/campaign-budget.ts`. Every reservation is keyed, so a
///      retried submission reserves and commits once (FR-014). The budget is ETH
///      and is never mixed with the trader's CHIT holdings or the service fee.
contract FleetCampaignEscrow {
    enum ReservationState {
        None,
        Reserved,
        Committed,
        RolledBack,
        Locked
    }

    struct Reservation {
        uint256 amount;
        uint256 committed;
        uint64 lockedUntil;
        ReservationState state;
    }

    struct Campaign {
        address owner;
        uint256 funded;
        uint256 reserved;
        uint256 spent;
        uint256 spentWithdrawn;
        bool closed;
        bool exists;
    }

    address public immutable operator;

    /// @notice How long a locked reservation is exclusively the operator's to
    ///         settle. After this window the owner may reclaim it on close, so a
    ///         vanished operator cannot strand funds forever.
    uint64 public constant LOCK_WINDOW = 1 hours;

    mapping(bytes32 campaign => Campaign) private _campaigns;
    mapping(bytes32 campaign => mapping(bytes32 key => Reservation)) private _reservations;

    event CampaignRegistered(bytes32 indexed campaign, address indexed owner);
    event CampaignFunded(bytes32 indexed campaign, address indexed owner, uint256 amount);
    event Reserved(bytes32 indexed campaign, bytes32 indexed key, uint256 amount);
    event Locked(bytes32 indexed campaign, bytes32 indexed key, uint64 until);
    event Committed(bytes32 indexed campaign, bytes32 indexed key, uint256 amount);
    event RolledBack(bytes32 indexed campaign, bytes32 indexed key, uint256 amount);
    event SpentWithdrawn(bytes32 indexed campaign, address indexed to, uint256 amount);
    event Closed(bytes32 indexed campaign, address indexed owner, uint256 returned);

    error NotOperator();
    error NotOwner();
    error CampaignMissing();
    error CampaignExists();
    error CampaignClosed();
    error OwnerMismatch();
    error ZeroAddress();
    error ZeroAmount();
    error ReservationExceedsUnused();
    error ReservationAmountChanged();
    error CommitAmountChanged();
    error CommitExceedsReservation();
    error ReservationUnknown();
    error ReservationRolledBack();
    error ReservationCommitted();
    error NotReservedOrLocked();
    error ReturnFailed();
    error NothingToWithdraw();

    /// @notice A settlement module (the Fleet paymaster) the operator authorizes
    ///         once to reserve, lock, commit, and roll back budget on its behalf.
    ///         This lets the paymaster settle gas atomically inside the EntryPoint
    ///         flow while the operator keeps registration and spend withdrawal.
    address public settler;

    event SettlerSet(address indexed settler);
    error SettlerAlreadySet();
    error NotOperatorOrSettler();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyOperatorOrSettler() {
        if (msg.sender != operator && msg.sender != settler) revert NotOperatorOrSettler();
        _;
    }

    constructor(address operator_) {
        operator = operator_;
    }

    /// @notice Authorizes the settlement module once. Set-once, operator-only.
    function setSettler(address settler_) external onlyOperator {
        if (settler_ == address(0)) revert ZeroAddress();
        if (settler != address(0)) revert SettlerAlreadySet();
        settler = settler_;
        emit SettlerSet(settler_);
    }

    /// @notice Registers a campaign to its owner before any funding. Only the
    ///         operator may register, which removes the first-funder land-grab:
    ///         an observer can no longer squat a campaign id with 1 wei.
    function registerCampaign(bytes32 campaign, address owner) external onlyOperator {
        if (owner == address(0)) revert ZeroAddress();
        Campaign storage record = _campaigns[campaign];
        if (record.exists) revert CampaignExists();
        record.owner = owner;
        record.exists = true;
        emit CampaignRegistered(campaign, owner);
    }

    /// @notice Funds a registered campaign. Only its registered owner may add to it.
    function fund(bytes32 campaign) external payable {
        if (msg.value == 0) revert ZeroAmount();

        Campaign storage record = _campaigns[campaign];
        if (!record.exists) revert CampaignMissing();
        if (record.closed) revert CampaignClosed();
        if (record.owner != msg.sender) revert OwnerMismatch();

        record.funded += msg.value;
        emit CampaignFunded(campaign, record.owner, msg.value);
    }

    function budget(bytes32 campaign)
        external
        view
        returns (uint256 funded, uint256 reserved, uint256 spent, uint256 unused)
    {
        Campaign memory record = _requireCampaign(campaign);
        funded = record.funded;
        reserved = record.reserved;
        spent = record.spent;
        unused = record.closed ? 0 : record.funded - record.spent - record.reserved;
    }

    function ownerOf(bytes32 campaign) external view returns (address) {
        return _requireCampaign(campaign).owner;
    }

    /// @notice Reserves the maximum a pending sponsored request may cost.
    function reserve(bytes32 campaign, bytes32 key, uint256 amount) external onlyOperatorOrSettler {
        Campaign storage record = _requireCampaignStorage(campaign);
        if (record.closed) revert CampaignClosed();
        if (amount == 0) revert ZeroAmount();

        Reservation storage reservation = _reservations[campaign][key];
        if (reservation.state != ReservationState.None) {
            if (reservation.amount != amount) revert ReservationAmountChanged();
            return;
        }
        if (amount > record.funded - record.spent - record.reserved) revert ReservationExceedsUnused();

        reservation.amount = amount;
        reservation.state = ReservationState.Reserved;
        record.reserved += amount;
        emit Reserved(campaign, key, amount);
    }

    /// @notice Locks a reservation the operator is about to submit on chain.
    /// @dev This closes the close/commit race: once locked, the owner's `close`
    ///      cannot claw the reservation back within LOCK_WINDOW, so a sponsored
    ///      op that has already been broadcast can still be committed. The window
    ///      bounds the operator's exclusivity so funds are never stranded.
    function lock(bytes32 campaign, bytes32 key) external onlyOperatorOrSettler {
        _requireCampaignStorage(campaign);
        Reservation storage reservation = _reservations[campaign][key];
        if (reservation.state != ReservationState.Reserved && reservation.state != ReservationState.Locked) {
            revert NotReservedOrLocked();
        }
        reservation.lockedUntil = uint64(block.timestamp) + LOCK_WINDOW;
        reservation.state = ReservationState.Locked;
        emit Locked(campaign, key, reservation.lockedUntil);
    }

    /// @notice Debits the request's actual cost and releases the remainder.
    function commit(bytes32 campaign, bytes32 key, uint256 actual) external onlyOperatorOrSettler {
        Campaign storage record = _requireCampaignStorage(campaign);
        Reservation storage reservation = _reservations[campaign][key];

        if (reservation.state == ReservationState.None) revert ReservationUnknown();
        if (reservation.state == ReservationState.RolledBack) revert ReservationRolledBack();
        if (reservation.state == ReservationState.Committed) {
            if (reservation.committed != actual) revert CommitAmountChanged();
            return;
        }
        // Reserved or Locked both commit.
        if (actual > reservation.amount) revert CommitExceedsReservation();

        record.reserved -= reservation.amount;
        record.spent += actual;
        reservation.committed = actual;
        reservation.state = ReservationState.Committed;
        emit Committed(campaign, key, actual);
    }

    /// @notice Releases a failed or expired reservation without charging it.
    function rollback(bytes32 campaign, bytes32 key) public onlyOperatorOrSettler {
        Campaign storage record = _requireCampaignStorage(campaign);
        Reservation storage reservation = _reservations[campaign][key];

        if (reservation.state == ReservationState.None) revert ReservationUnknown();
        if (reservation.state == ReservationState.Committed) revert ReservationCommitted();
        if (reservation.state == ReservationState.RolledBack) return;

        record.reserved -= reservation.amount;
        reservation.state = ReservationState.RolledBack;
        emit RolledBack(campaign, key, reservation.amount);
    }

    function reservationOf(bytes32 campaign, bytes32 key) external view returns (Reservation memory) {
        return _reservations[campaign][key];
    }

    /// @notice Owner reclaims a locked reservation the operator abandoned.
    /// @dev The escape hatch that makes LOCK_WINDOW safe: once the window has
    ///      passed, a still-locked reservation is no longer the operator's to
    ///      settle, so the owner may roll it back and recover the ETH — even
    ///      after close, which otherwise runs only once.
    function reclaimExpiredLock(bytes32 campaign, bytes32 key) external returns (uint256 amount) {
        Campaign storage record = _requireCampaignStorage(campaign);
        if (msg.sender != record.owner) revert NotOwner();
        Reservation storage reservation = _reservations[campaign][key];
        if (reservation.state != ReservationState.Locked) revert NotReservedOrLocked();
        if (block.timestamp <= reservation.lockedUntil) revert NotReservedOrLocked();

        amount = reservation.amount;
        record.reserved -= amount;
        reservation.state = ReservationState.RolledBack;
        emit RolledBack(campaign, key, amount);

        (bool ok, ) = record.owner.call{value: amount}("");
        if (!ok) revert ReturnFailed();
    }

    /// @notice Withdraws committed spend to a beneficiary — the ETH the operator
    ///         fronted as gas for permitted sponsored requests.
    /// @dev Without this the committed `spent` would be locked in the contract
    ///      forever. Tracks `spentWithdrawn` so nothing is paid twice.
    function withdrawSpent(bytes32 campaign, address to) external onlyOperator returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        Campaign storage record = _requireCampaignStorage(campaign);
        amount = record.spent - record.spentWithdrawn;
        if (amount == 0) revert NothingToWithdraw();

        record.spentWithdrawn += amount;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert ReturnFailed();
        emit SpentWithdrawn(campaign, to, amount);
    }

    /// @notice Closes the campaign and returns its unused ETH to the owner.
    /// @dev Open reservations are released first, so an interrupted submission
    ///      never strands budget. A reservation still Locked inside its window is
    ///      left for the operator to settle; only after the window may the owner
    ///      reclaim it. `spent` already withdrawn by the operator is excluded.
    ///      Closing blocks every later charge.
    function close(bytes32 campaign, bytes32[] calldata openKeys) external returns (uint256 returned) {
        Campaign storage record = _requireCampaignStorage(campaign);
        if (msg.sender != record.owner) revert NotOwner();
        if (record.closed) return 0;

        for (uint256 index = 0; index < openKeys.length; ++index) {
            Reservation storage reservation = _reservations[campaign][openKeys[index]];
            bool releasable = reservation.state == ReservationState.Reserved ||
                (reservation.state == ReservationState.Locked && block.timestamp > reservation.lockedUntil);
            if (!releasable) continue;
            record.reserved -= reservation.amount;
            reservation.state = ReservationState.RolledBack;
            emit RolledBack(campaign, openKeys[index], reservation.amount);
        }

        // Return the owner's remainder: funded minus committed spend and any
        // reservation still standing (locked-within-window or committed).
        returned = record.funded - record.spent - record.reserved;
        record.closed = true;

        if (returned != 0) {
            (bool ok, ) = record.owner.call{value: returned}("");
            if (!ok) revert ReturnFailed();
        }
        emit Closed(campaign, record.owner, returned);
    }

    function _requireCampaign(bytes32 campaign) private view returns (Campaign memory record) {
        record = _campaigns[campaign];
        if (!record.exists) revert CampaignMissing();
    }

    function _requireCampaignStorage(bytes32 campaign) private view returns (Campaign storage record) {
        record = _campaigns[campaign];
        if (!record.exists) revert CampaignMissing();
    }
}
