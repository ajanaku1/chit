// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC7984} from "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC7984.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {
    Nox,
    euint256,
    externalEuint256
} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

interface IChitSettlementLifecycle {
    function paymaster() external view returns (address);
}

interface IChitPaymasterLifecycle {
    function roundState() external view returns (uint8);
}

contract ChitVault {
    uint256 public constant MAX_SPONSORS = 4;
    uint8 private constant CLOSED_STATE = 3;
    bytes32 private constant ADMISSION_TYPEHASH =
        keccak256(
            "SponsorAdmission(uint256 chainId,address vault,address sponsor,uint48 validUntil)"
        );

    IERC7984 public immutable wrapper;
    address public immutable auditor;
    address public immutable creator;
    address public immutable factory;
    address public settlement;
    bool public active;
    uint256 public sponsorCount;
    euint256[MAX_SPONSORS] private _budget;
    bool[MAX_SPONSORS] private _budgetInitialized;
    bool[MAX_SPONSORS] public refunded;
    address[MAX_SPONSORS] private _sponsors;
    mapping(address sponsor => bool registered) public registeredSponsor;

    error NotFactory();
    error NotSettlement();
    error InvalidAddress();
    error InvalidSlot();
    error BudgetAlreadyInitialized();
    error SettlementAlreadySet();
    error TooManySponsors();
    error RoundNotActive();
    error RoundAlreadyActive();
    error RoundNotInitialized();
    error SponsorAlreadyRegistered();
    error AdmissionExpired();
    error InvalidAdmission();
    error RoundNotClosed();
    error NotSponsor();
    error SponsorAlreadyRefunded();

    event SponsorRegistered(address indexed sponsor, uint256 indexed slot);
    event SponsorRefunded(address indexed sponsor, uint256 indexed slot);

    constructor(
        address wrapper_,
        address auditor_,
        address creator_,
        address factory_
    ) {
        require(
            wrapper_ != address(0) &&
                auditor_ != address(0) &&
                creator_ != address(0) &&
                factory_ != address(0),
            InvalidAddress()
        );
        wrapper = IERC7984(wrapper_);
        auditor = auditor_;
        creator = creator_;
        factory = factory_;
    }

    modifier onlyFactory() {
        require(msg.sender == factory, NotFactory());
        _;
    }

    function setSettlement(address settlement_) external onlyFactory {
        require(settlement_ != address(0), InvalidAddress());
        require(settlement == address(0), SettlementAlreadySet());
        settlement = settlement_;
    }

    function initializeBudget(uint256 slot) external onlyFactory {
        require(slot < MAX_SPONSORS, InvalidSlot());
        require(!_budgetInitialized[slot], BudgetAlreadyInitialized());
        _budgetInitialized[slot] = true;
        _budget[slot] = Nox.toEuint256(0);
        _grant(_budget[slot]);
    }

    function budgetInitialized(uint256 slot) external view returns (bool) {
        require(slot < MAX_SPONSORS, InvalidSlot());
        return _budgetInitialized[slot];
    }

    function activate() external onlyFactory {
        require(!active, RoundAlreadyActive());
        require(settlement != address(0), RoundNotInitialized());
        for (uint256 slot = 0; slot < MAX_SPONSORS; slot++) {
            require(_budgetInitialized[slot], RoundNotInitialized());
        }
        active = true;
    }

    function admissionDigest(
        address sponsor,
        uint48 validUntil
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    ADMISSION_TYPEHASH,
                    block.chainid,
                    address(this),
                    sponsor,
                    validUntil
                )
            );
    }

    function registerSponsor(
        externalEuint256 encryptedBudget,
        bytes calldata inputProof,
        uint48 validUntil,
        bytes calldata creatorSignature
    ) external returns (uint256 slot) {
        require(active, RoundNotActive());
        _verifyAdmission(validUntil, creatorSignature);
        slot = _reserveSponsor(msg.sender);
        euint256 budget = Nox.fromExternal(encryptedBudget, inputProof);
        Nox.allowTransient(budget, address(wrapper));
        _budget[slot] = wrapper.confidentialTransferFrom(
            msg.sender,
            address(this),
            budget
        );
        _grant(_budget[slot]);
        emit SponsorRegistered(msg.sender, slot);
    }

    function sponsorAt(uint256 slot) external view returns (address) {
        require(slot < MAX_SPONSORS, InvalidSlot());
        return _sponsors[slot];
    }

    function refundSponsor(uint256 slot) external {
        require(slot < MAX_SPONSORS, InvalidSlot());
        address sponsor = _sponsors[slot];
        require(msg.sender == sponsor, NotSponsor());
        require(!refunded[slot], SponsorAlreadyRefunded());
        address paymaster = IChitSettlementLifecycle(settlement).paymaster();
        require(
            IChitPaymasterLifecycle(paymaster).roundState() == CLOSED_STATE,
            RoundNotClosed()
        );
        refunded[slot] = true;
        euint256 remaining = _budget[slot];
        _budget[slot] = Nox.toEuint256(0);
        _grant(_budget[slot]);
        Nox.allowTransient(remaining, address(wrapper));
        wrapper.confidentialTransfer(sponsor, remaining);
        emit SponsorRefunded(sponsor, slot);
    }

    function _verifyAdmission(
        uint48 validUntil,
        bytes calldata creatorSignature
    ) private view {
        require(validUntil >= block.timestamp, AdmissionExpired());
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            admissionDigest(msg.sender, validUntil)
        );
        (address signer, ECDSA.RecoverError recoverError, ) = ECDSA.tryRecover(
            digest,
            creatorSignature
        );
        require(
            recoverError == ECDSA.RecoverError.NoError && signer == creator,
            InvalidAdmission()
        );
    }

    function _reserveSponsor(address sponsor) private returns (uint256 slot) {
        require(!registeredSponsor[sponsor], SponsorAlreadyRegistered());
        require(sponsorCount < MAX_SPONSORS, TooManySponsors());
        slot = sponsorCount++;
        require(_budgetInitialized[slot], RoundNotInitialized());
        registeredSponsor[sponsor] = true;
        _sponsors[slot] = sponsor;
    }

    function debit(uint256 slot, euint256 charge) external returns (euint256) {
        require(msg.sender == settlement, NotSettlement());
        (, euint256 updated) = Nox.safeSub(_budget[slot], charge);
        _budget[slot] = updated;
        _grant(updated);
        return updated;
    }

    function budgetHandle(uint256 slot) external view returns (euint256) {
        return _budget[slot];
    }

    function _grant(euint256 value) private {
        Nox.allowThis(value);
        Nox.allow(value, auditor);
        if (settlement != address(0)) Nox.allow(value, settlement);
    }
}
