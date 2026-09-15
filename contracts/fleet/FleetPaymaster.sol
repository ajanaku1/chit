// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {FleetCampaignEscrow} from "./FleetCampaignEscrow.sol";

/// @dev Minimal EntryPoint surface the paymaster needs for its deposit/stake.
interface IEntryPointStake {
    function depositTo(address account) external payable;
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable to) external;
    function withdrawTo(address payable to, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

/// @dev ERC-4337 v0.7 packed user operation.
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

/// @title Fleet paymaster
/// @notice A verifying ERC-4337 v0.7 paymaster that sponsors gas for fleet
///         accounts and settles the cost against `FleetCampaignEscrow` atomically
///         inside the EntryPoint flow. With a fee, it is the gas-sponsorship
///         product's paymaster too: the sponsor's budget is charged the cost
///         plus a published percentage, in the same postOp, and nothing else.
/// @dev The operator authorizes each sponsored op off-chain by signing over the
///      userOpHash plus the campaign, reservation key, and cost bound. That
///      off-chain check is where policy (approved router, caps, state) is
///      enforced; on-chain the paymaster verifies the operator signature,
///      reserves the max cost, and commits the actual cost in postOp. Because
///      reserve and commit both run within the EntryPoint's handleOps call, the
///      owner cannot interleave a close between them — the settlement is atomic.
contract FleetPaymaster {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    enum PostOpMode {
        opSucceeded,
        opReverted,
        postOpReverted
    }

    address public immutable entryPoint;
    address public immutable operator;
    FleetCampaignEscrow public immutable escrow;

    /// @notice The fee on every sponsored operation, in basis points of the
    ///         gas cost the EntryPoint reports. Zero for the fleet's own
    ///         paymaster; the sponsorship product's is deployed with one. It
    ///         is fixed at deployment so a sponsor can read it and rely on it.
    /// @dev The EntryPoint hands postOp a cost that leaves out postOp's own
    ///      gas and the unused-gas penalty (measured at 1.5% to 5% of the
    ///      operator's outlay on 46630); the fee has to clear that before it
    ///      is revenue.
    uint16 public immutable feeBps;
    uint16 public constant MAX_FEE_BPS = 5_000;

    /// @dev paymasterData layout after the 20+16+16 header EntryPoint strips:
    ///      campaign(32) | key(32) | validUntil(6) | validAfter(6) | signature(65)
    uint256 private constant SIG_OFFSET = 76;

    event Sponsored(bytes32 indexed campaign, bytes32 indexed key, address indexed sender);

    error NotEntryPoint();
    error NotOperator();
    error MalformedPaymasterData();
    error FeeTooHigh();

    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert NotEntryPoint();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address entryPoint_, address operator_, FleetCampaignEscrow escrow_, uint16 feeBps_) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        entryPoint = entryPoint_;
        operator = operator_;
        escrow = escrow_;
        feeBps = feeBps_;
    }

    /// @notice What the budget is charged for a given gas cost: the cost plus the fee.
    function charged(uint256 gasCost) public view returns (uint256) {
        return gasCost + (gasCost * feeBps) / 10_000;
    }

    /// @notice Validates a sponsored op and reserves its maximum cost.
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external onlyEntryPoint returns (bytes memory context, uint256 validationData) {
        // paymasterAndData = paymaster(20) | verGas(16) | postGas(16) | data...
        bytes calldata data = userOp.paymasterAndData[52:];
        if (data.length < SIG_OFFSET + 65) revert MalformedPaymasterData();

        bytes32 campaign = bytes32(data[0:32]);
        bytes32 key = bytes32(data[32:64]);
        uint48 validUntil = uint48(bytes6(data[64:70]));
        uint48 validAfter = uint48(bytes6(data[70:76]));

        // Sign over the operation's fields, never the EntryPoint userOpHash:
        // userOpHash includes the full paymasterAndData (this signature), so
        // signing it would be circular. Binding sender, nonce, callData and gas
        // pins the exact op without that dependency. userOpHash is unused.
        userOpHash;
        bool signatureOk = _verify(userOp, campaign, key, maxCost, validUntil, validAfter, data[SIG_OFFSET:SIG_OFFSET + 65]);

        // Reserve the ceiling, fee included, only for an authorized op; an
        // invalid signature is signalled to the EntryPoint through
        // validationData, which drops the op.
        if (signatureOk) {
            escrow.reserve(campaign, key, charged(maxCost));
        }

        context = abi.encode(campaign, key, userOp.sender);
        validationData = _packValidationData(!signatureOk, validUntil, validAfter);
    }

    /// @dev Recovers the operator signature over the sponsorship digest, hashed
    ///      from the operation's fixed fields (no userOpHash, no signatures).
    function _verify(
        PackedUserOperation calldata userOp,
        bytes32 campaign,
        bytes32 key,
        uint256 maxCost,
        uint48 validUntil,
        uint48 validAfter,
        bytes calldata signature
    ) private view returns (bool) {
        // Two-step hash keeps each abi.encode shallow enough to avoid stack-too-deep.
        bytes32 opHash = keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                userOp.preVerificationGas,
                userOp.gasFees
            )
        );
        bytes32 digest = keccak256(
            abi.encode(opHash, block.chainid, address(this), campaign, key, maxCost, validUntil, validAfter)
        ).toEthSignedMessageHash();
        return digest.recover(signature) == operator;
    }

    /// @notice Commits the actual gas cost, plus the fee, against the budget.
    /// @dev By postOp the gas has already been spent, so we always commit the
    ///      real cost (never more than the reserved max, since the fee scales
    ///      the same way on both). Rollback is the operator's off-chain path
    ///      for an op that never lands.
    function postOp(
        PostOpMode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256
    ) external onlyEntryPoint {
        (bytes32 campaign, bytes32 key, address sender) = abi.decode(context, (bytes32, bytes32, address));
        escrow.commit(campaign, key, charged(actualGasCost));
        emit Sponsored(campaign, key, sender);
    }

    // --- EntryPoint deposit/stake management (operator-only) ---

    function deposit() external payable {
        IEntryPointStake(entryPoint).depositTo{value: msg.value}(address(this));
    }

    function getDeposit() external view returns (uint256) {
        return IEntryPointStake(entryPoint).balanceOf(address(this));
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyOperator {
        IEntryPointStake(entryPoint).addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOperator {
        IEntryPointStake(entryPoint).unlockStake();
    }

    function withdrawStake(address payable to) external onlyOperator {
        IEntryPointStake(entryPoint).withdrawStake(to);
    }

    function withdrawTo(address payable to, uint256 amount) external onlyOperator {
        IEntryPointStake(entryPoint).withdrawTo(to, amount);
    }

    /// @dev v0.7 validationData: authorizer(20) | validUntil(6) | validAfter(6).
    ///      authorizer == 0 is valid; 1 signals a signature failure.
    function _packValidationData(bool sigFailed, uint48 validUntil, uint48 validAfter) private pure returns (uint256) {
        return (sigFailed ? 1 : 0) | (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    receive() external payable {}
}
