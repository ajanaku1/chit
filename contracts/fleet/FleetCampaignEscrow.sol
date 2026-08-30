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
        RolledBack
    }

    struct Reservation {
        uint256 amount;
        uint256 committed;
        ReservationState state;
    }

    struct Campaign {
        address owner;
        uint256 funded;
        uint256 reserved;
        uint256 spent;
        bool closed;
        bool exists;
    }

    address public immutable operator;

    mapping(bytes32 campaign => Campaign) private _campaigns;
    mapping(bytes32 campaign => mapping(bytes32 key => Reservation)) private _reservations;

    event CampaignFunded(bytes32 indexed campaign, address indexed owner, uint256 amount);
    event Reserved(bytes32 indexed campaign, bytes32 indexed key, uint256 amount);
    event Committed(bytes32 indexed campaign, bytes32 indexed key, uint256 amount);
    event RolledBack(bytes32 indexed campaign, bytes32 indexed key, uint256 amount);
    event Closed(bytes32 indexed campaign, address indexed owner, uint256 returned);

    error NotOperator();
    error NotOwner();
    error CampaignMissing();
    error CampaignClosed();
    error OwnerMismatch();
    error ZeroAmount();
    error ReservationExceedsUnused();
    error ReservationAmountChanged();
    error CommitAmountChanged();
    error CommitExceedsReservation();
    error ReservationUnknown();
    error ReservationRolledBack();
    error ReservationCommitted();
    error ReturnFailed();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address operator_) {
        operator = operator_;
    }

    /// @notice Funds a campaign. Only its original owner may add to it.
    function fund(bytes32 campaign) external payable {
        if (msg.value == 0) revert ZeroAmount();

        Campaign storage record = _campaigns[campaign];
        if (!record.exists) {
            record.owner = msg.sender;
            record.exists = true;
        } else {
            if (record.closed) revert CampaignClosed();
            if (record.owner != msg.sender) revert OwnerMismatch();
        }

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
    function reserve(bytes32 campaign, bytes32 key, uint256 amount) external onlyOperator {
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

    /// @notice Debits the request's actual cost and releases the remainder.
    function commit(bytes32 campaign, bytes32 key, uint256 actual) external onlyOperator {
        Campaign storage record = _requireCampaignStorage(campaign);
        Reservation storage reservation = _reservations[campaign][key];

        if (reservation.state == ReservationState.None) revert ReservationUnknown();
        if (reservation.state == ReservationState.RolledBack) revert ReservationRolledBack();
        if (reservation.state == ReservationState.Committed) {
            if (reservation.committed != actual) revert CommitAmountChanged();
            return;
        }
        if (actual > reservation.amount) revert CommitExceedsReservation();

        record.reserved -= reservation.amount;
        record.spent += actual;
        reservation.committed = actual;
        reservation.state = ReservationState.Committed;
        emit Committed(campaign, key, actual);
    }

    /// @notice Releases a failed or expired reservation without charging it.
    function rollback(bytes32 campaign, bytes32 key) public onlyOperator {
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

    /// @notice Closes the campaign and returns its unused ETH to the owner.
    /// @dev Open reservations are released first, so an interrupted submission
    ///      never strands budget. Closing blocks every later charge.
    function close(bytes32 campaign, bytes32[] calldata openKeys) external returns (uint256 returned) {
        Campaign storage record = _requireCampaignStorage(campaign);
        if (msg.sender != record.owner) revert NotOwner();
        if (record.closed) return 0;

        for (uint256 index = 0; index < openKeys.length; ++index) {
            Reservation storage reservation = _reservations[campaign][openKeys[index]];
            if (reservation.state != ReservationState.Reserved) continue;
            record.reserved -= reservation.amount;
            reservation.state = ReservationState.RolledBack;
            emit RolledBack(campaign, openKeys[index], reservation.amount);
        }

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
