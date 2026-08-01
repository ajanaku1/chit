// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// GO/NO-GO SPIKE. Proves one thing: an ERC-4337 paymaster can carry encrypted
// per-sponsor budgets and debit the right one inside postOp without ever
// revealing which sponsor paid for which user.
//
// The hard part is that Nox has no encrypted indexing - you cannot look up
// `budget[encryptedSponsorId]`. So postOp walks every sponsor and uses
// eq/select to apply the real cost to exactly one of them and zero to the
// rest. Cost is O(sponsors) Nox ops per userOp, which is why sponsors are a
// fixed small set here.

import {Nox, ebool, euint256, externalEuint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

enum PostOpMode {
    opSucceeded,
    opReverted,
    postOpReverted
}

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IEntryPointLike {
    function depositTo(address account) external payable;

    function balanceOf(address account) external view returns (uint256);
}

contract ConfidentialPaymaster {
    /// @dev Maximum sponsors. postOp walks all of them, so this bounds gas.
    uint256 public constant MAX_SPONSORS = 4;

    address public immutable entryPoint;
    address public immutable auditor;

    /// @dev Encrypted remaining budget per sponsor slot.
    euint256[MAX_SPONSORS] private _budget;
    /// @dev Which sponsor slot backs a user - encrypted, so the sponsor->user
    /// edge never appears on chain. Slot MAX_SPONSORS means "unsponsored".
    mapping(address => euint256) private _sponsorOf;
    /// @dev Public: whether this account may be sponsored at all. Deliberately
    /// public - EntryPoint emits the sender anyway, so hiding it is theatre.
    mapping(address => bool) public enrolled;

    uint256 public sponsorCount;

    error NotEntryPoint();
    error TooManySponsors();
    error NotEnrolled(address account);

    constructor(address entryPoint_, address auditor_) {
        entryPoint = entryPoint_;
        auditor = auditor_;
        for (uint256 i = 0; i < MAX_SPONSORS; i++) {
            _budget[i] = Nox.toEuint256(0);
            Nox.allowThis(_budget[i]);
            Nox.allow(_budget[i], auditor_);
        }
    }

    /// @notice Opens a sponsor slot funded with an encrypted budget.
    function openSponsor(
        externalEuint256 encryptedBudget,
        bytes calldata inputProof
    ) external returns (uint256 slot) {
        require(sponsorCount < MAX_SPONSORS, TooManySponsors());
        slot = sponsorCount++;
        _budget[slot] = Nox.fromExternal(encryptedBudget, inputProof);
        _grant(_budget[slot]);
    }

    /// @notice Enrols `account`, backed by an encrypted sponsor slot.
    function enroll(
        address account,
        externalEuint256 encryptedSlot,
        bytes calldata inputProof
    ) external {
        enrolled[account] = true;
        _sponsorOf[account] = Nox.fromExternal(encryptedSlot, inputProof);
        Nox.allowThis(_sponsorOf[account]);
        Nox.allow(_sponsorOf[account], auditor);
    }

    /// @notice Validation stays entirely in plaintext.
    /// @dev This is the whole reason the design works. Validation cannot decrypt
    /// (publicDecrypt needs a caller-supplied proof) and cannot revert on an
    /// encrypted condition, so it never touches ciphertext: it checks public
    /// enrolment and lets EntryPoint's own deposit accounting cap total spend.
    /// Per-sponsor overdraft is settled (clamped) later in postOp.
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32,
        uint256
    ) external view returns (bytes memory context, uint256 validationData) {
        require(msg.sender == entryPoint, NotEntryPoint());
        require(enrolled[userOp.sender], NotEnrolled(userOp.sender));
        return (abi.encode(userOp.sender), 0);
    }

    /// @notice Debits the paying sponsor's encrypted budget, obliviously.
    function postOp(
        PostOpMode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256
    ) external {
        require(msg.sender == entryPoint, NotEntryPoint());
        address account = abi.decode(context, (address));

        euint256 cost = Nox.toEuint256(actualGasCost);
        euint256 slot = _sponsorOf[account];

        for (uint256 i = 0; i < MAX_SPONSORS; i++) {
            // Encrypted branch: is this the slot that owes the gas?
            ebool isPayer = Nox.eq(slot, Nox.toEuint256(i));
            euint256 debit = Nox.select(isPayer, cost, Nox.toEuint256(0));

            // Saturate to zero on underflow - we cannot revert on an encrypted
            // condition. safeSub already returns an encrypted 0 as its result
            // when it fails (see INoxCompute.safeSub), so assigning the result
            // straight through IS the saturating clamp. That also drops one
            // select per slot per userOp, which matters because this loop is
            // O(MAX_SPONSORS) on every sponsored operation.
            //
            // Do NOT "fix" this by keeping the previous budget on failure. That
            // leaves an overdrawn sponsor's budget untouched, which makes it
            // indistinguishable from an idle sponsor to the auditor - the one
            // party whose whole job is to catch that.
            (, euint256 updated) = Nox.safeSub(_budget[i], debit);
            _budget[i] = updated;
            _grant(_budget[i]);
        }
    }

    /// @notice Lets the auditor read a sponsor's remaining budget.
    function budgetHandle(uint256 slot) external view returns (euint256) {
        return _budget[slot];
    }

    function deposit() external payable {
        IEntryPointLike(entryPoint).depositTo{value: msg.value}(address(this));
    }

    function entryPointBalance() external view returns (uint256) {
        return IEntryPointLike(entryPoint).balanceOf(address(this));
    }

    /// @dev Re-granting after every write is mandatory, not defensive: each Nox
    /// op returns a fresh handle and the old ACL does not carry over.
    function _grant(euint256 value) private {
        Nox.allowThis(value);
        Nox.allow(value, auditor);
    }
}
