// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    Nox,
    ebool,
    euint256,
    externalEuint256
} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

interface IChitVault {
    function budgetHandle(uint256 slot) external view returns (euint256);

    function debit(uint256 slot, euint256 charge) external returns (euint256);
}

interface IChitPaymasterClaims {
    function currentEpoch() external view returns (uint256);

    function claim(uint256 epoch, address account) external view returns (uint256);

    function epochTotal(uint256 epoch) external view returns (uint256);
}

contract ChitSettlement {
    uint256 public constant MAX_SPONSORS = 4;

    IChitVault public immutable vault;
    address public immutable auditor;
    address public immutable creator;
    address public immutable factory;
    address public operator;
    address public paymaster;
    bool public paused;
    uint256 public settledEpochs;
    mapping(address user => bool isEnrolled) public enrolled;
    mapping(address user => euint256 sponsorSlot) private _sponsorOf;
    euint256[MAX_SPONSORS] private _lastCharge;
    euint256 private _lastAggregate;
    bool[MAX_SPONSORS] private _chargeInitialized;
    bool private _aggregateInitialized;

    error NotFactory();
    error NotOperator();
    error NotCreator();
    error InvalidAddress();
    error InvalidSlot();
    error PaymasterAlreadySet();
    error ChargeAlreadyInitialized();
    error AggregateAlreadyInitialized();
    error LengthMismatch();
    error AccountAlreadyEnrolled();
    error UnexpectedEpoch();
    error EpochNotClosed();
    error AccountNotEnrolled();
    error DuplicateAccount();
    error ClaimMismatch();
    error TotalMismatch();
    error RoundPaused();

    event AccountEnrolled(address indexed account);
    event PausedSet(bool paused);
    event OperatorSet(address indexed operator);

    constructor(
        address vault_,
        address auditor_,
        address creator_,
        address operator_,
        address factory_
    ) {
        require(
            vault_ != address(0) &&
                auditor_ != address(0) &&
                creator_ != address(0) &&
                operator_ != address(0) &&
                factory_ != address(0),
            InvalidAddress()
        );
        vault = IChitVault(vault_);
        auditor = auditor_;
        creator = creator_;
        operator = operator_;
        factory = factory_;
    }

    modifier onlyFactory() {
        require(msg.sender == factory, NotFactory());
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, NotOperator());
        _;
    }

    modifier onlyCreator() {
        require(msg.sender == creator, NotCreator());
        _;
    }

    modifier whenNotPaused() {
        require(!paused, RoundPaused());
        _;
    }

    function setPaused(bool paused_) external onlyCreator {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setOperator(address operator_) external onlyCreator {
        require(operator_ != address(0), InvalidAddress());
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setPaymaster(address paymaster_) external onlyFactory {
        require(paymaster_ != address(0), InvalidAddress());
        require(paymaster == address(0), PaymasterAlreadySet());
        paymaster = paymaster_;
    }

    function initializeCharge(uint256 slot) external onlyFactory {
        require(slot < MAX_SPONSORS, InvalidSlot());
        require(!_chargeInitialized[slot], ChargeAlreadyInitialized());
        _chargeInitialized[slot] = true;
        _lastCharge[slot] = Nox.toEuint256(0);
        _grant(_lastCharge[slot]);
    }

    function initializeAggregate() external onlyFactory {
        require(!_aggregateInitialized, AggregateAlreadyInitialized());
        _aggregateInitialized = true;
        _lastAggregate = Nox.toEuint256(0);
        _grant(_lastAggregate);
    }

    function enroll(
        address account,
        externalEuint256 encryptedSlot,
        bytes calldata inputProof
    ) external onlyOperator whenNotPaused {
        require(account != address(0), InvalidAddress());
        require(!enrolled[account], AccountAlreadyEnrolled());
        enrolled[account] = true;
        _sponsorOf[account] = Nox.fromExternal(encryptedSlot, inputProof);
        _grant(_sponsorOf[account]);
        emit AccountEnrolled(account);
    }

    function settleEpoch(
        uint256 epoch,
        address[] calldata users,
        uint256[] calldata claims
    ) external onlyOperator whenNotPaused {
        require(users.length == claims.length, LengthMismatch());
        require(epoch == settledEpochs, UnexpectedEpoch());
        require(
            epoch < IChitPaymasterClaims(paymaster).currentEpoch(),
            EpochNotClosed()
        );
        _validateClaims(epoch, users, claims);
        settledEpochs = epoch + 1;
        euint256[MAX_SPONSORS] memory slotClaims = _attributeClaims(users, claims);
        euint256 totalBudget = _totalBudget();
        _lastAggregate = _applyHaircut(slotClaims, totalBudget);
        _grant(_lastAggregate);
        Nox.allowPublicDecryption(_lastAggregate);
    }

    function _validateClaims(
        uint256 epoch,
        address[] calldata users,
        uint256[] calldata claims
    ) private view {
        uint256 suppliedTotal;
        for (uint256 i = 0; i < users.length; i++) {
            require(enrolled[users[i]], AccountNotEnrolled());
            for (uint256 prior = 0; prior < i; prior++) {
                require(users[prior] != users[i], DuplicateAccount());
            }
            require(
                IChitPaymasterClaims(paymaster).claim(epoch, users[i]) ==
                    claims[i],
                ClaimMismatch()
            );
            suppliedTotal += claims[i];
        }
        require(
            suppliedTotal == IChitPaymasterClaims(paymaster).epochTotal(epoch),
            TotalMismatch()
        );
    }

    function lastChargeHandle(uint256 slot) external view returns (euint256) {
        return _lastCharge[slot];
    }

    function lastAggregateHandle() external view returns (euint256) {
        return _lastAggregate;
    }

    function _attributeClaims(
        address[] calldata users,
        uint256[] calldata claims
    ) private returns (euint256[MAX_SPONSORS] memory totals) {
        for (uint256 i = 0; i < MAX_SPONSORS; i++) {
            totals[i] = Nox.toEuint256(0);
        }
        for (uint256 userIndex = 0; userIndex < users.length; userIndex++) {
            euint256 slot = _sponsorOf[users[userIndex]];
            euint256 claimValue = Nox.toEuint256(claims[userIndex]);
            for (uint256 slotIndex = 0; slotIndex < MAX_SPONSORS; slotIndex++) {
                ebool matches = Nox.eq(slot, Nox.toEuint256(slotIndex));
                euint256 amount = Nox.select(
                    matches,
                    claimValue,
                    Nox.toEuint256(0)
                );
                totals[slotIndex] = Nox.add(totals[slotIndex], amount);
            }
        }
    }

    function _totalBudget() private returns (euint256 total) {
        total = Nox.toEuint256(0);
        for (uint256 i = 0; i < MAX_SPONSORS; i++) {
            total = Nox.add(total, vault.budgetHandle(i));
        }
    }

    function _applyHaircut(
        euint256[MAX_SPONSORS] memory slotClaims,
        euint256 totalBudget
    ) private returns (euint256 aggregate) {
        aggregate = Nox.toEuint256(0);
        for (uint256 i = 0; i < MAX_SPONSORS; i++) {
            euint256 budget = vault.budgetHandle(i);
            (, euint256 weightedClaim) = Nox.safeMul(slotClaims[i], budget);
            (, euint256 charge) = Nox.safeDiv(weightedClaim, totalBudget);
            _lastCharge[i] = charge;
            _grant(charge);
            Nox.allowTransient(charge, address(vault));
            vault.debit(i, charge);
            aggregate = Nox.add(aggregate, charge);
        }
    }

    function _grant(euint256 value) private {
        Nox.allowThis(value);
        Nox.allow(value, auditor);
    }
}
