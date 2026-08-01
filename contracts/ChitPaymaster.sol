// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

enum ChitPostOpMode {
    opSucceeded,
    opReverted,
    postOpReverted
}

struct ChitUserOperation {
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

interface IChitEntryPoint {
    struct DepositInfo {
        uint256 deposit;
        bool staked;
        uint112 stake;
        uint32 unstakeDelaySec;
        uint48 withdrawTime;
    }

    function depositTo(address account) external payable;

    function addStake(uint32 unstakeDelaySec) external payable;

    function balanceOf(address account) external view returns (uint256);

    function getDepositInfo(
        address account
    ) external view returns (DepositInfo memory info);

    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;

    function unlockStake() external;

    function withdrawStake(address payable withdrawAddress) external;
}

interface IChitVaultEligibility {
    function sponsorCount() external view returns (uint256);
}

interface IChitSettlementEligibility {
    function enrolled(address account) external view returns (bool);
}

interface IChitSettlementLifecycle {
    function settledEpochs() external view returns (uint256);
}

contract ChitPaymaster {
    enum RoundState {
        Initializing,
        Active,
        Closing,
        Closed
    }

    bytes32 private constant AUTHORIZATION_TYPEHASH =
        keccak256(
            "ChitAuthorization(uint256 chainId,address entryPoint,address paymaster,bytes32 userOpHash,bytes32 paymasterFieldsHash,uint256 maxCost,uint48 validUntil)"
        );
    bytes32 private constant USER_OPERATION_TYPEHASH =
        keccak256(
            "ChitUserOperation(address sender,uint256 nonce,bytes32 initCodeHash,bytes32 callDataHash,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees)"
        );
    uint256 private constant PAYMASTER_FIELDS_LENGTH = 52;
    uint256 private constant SIG_VALIDATION_FAILED = 1;

    address public immutable entryPoint;
    address public immutable vault;
    address public immutable settlement;
    address public immutable creator;
    address public immutable factory;
    address public operator;
    address public verifier;
    bool public paused;
    RoundState public roundState;
    uint256 public currentEpoch;
    mapping(uint256 epoch => mapping(address user => uint256 amount)) public claim;
    mapping(uint256 epoch => uint256 amount) public epochTotal;

    error NotEntryPoint();
    error NotCreator();
    error NotOperator();
    error NotFactory();
    error InvalidAddress();
    error InvalidVerifier();
    error InvalidOperator();
    error AlreadyActivated();
    error InvalidActivationValue();
    error InvalidRoundState();
    error UnsettledEpochs();

    event ChitRecorded(uint256 indexed epoch, address indexed account, uint256 gasCost);
    event EpochClosed(uint256 indexed epoch, uint256 total);
    event PausedSet(bool paused);
    event OperatorSet(address indexed operator);
    event VerifierSet(address indexed verifier);
    event RoundClosing(uint256 indexed finalEpoch);
    event RoundClosed();

    constructor(
        address entryPoint_,
        address vault_,
        address settlement_,
        address creator_,
        address operator_,
        address verifier_,
        address factory_
    ) {
        require(
            entryPoint_ != address(0) &&
                vault_ != address(0) &&
                settlement_ != address(0) &&
                creator_ != address(0) &&
                operator_ != address(0) &&
                verifier_ != address(0) &&
                factory_ != address(0),
            InvalidAddress()
        );
        entryPoint = entryPoint_;
        vault = vault_;
        settlement = settlement_;
        creator = creator_;
        operator = operator_;
        verifier = verifier_;
        factory = factory_;
    }

    modifier onlyCreator() {
        require(msg.sender == creator, NotCreator());
        _;
    }

    modifier onlyFactory() {
        require(msg.sender == factory, NotFactory());
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, NotOperator());
        _;
    }

    function setVerifier(address verifier_) external onlyCreator {
        require(verifier_ != address(0), InvalidVerifier());
        verifier = verifier_;
        emit VerifierSet(verifier_);
    }

    function setOperator(address operator_) external onlyCreator {
        require(operator_ != address(0), InvalidOperator());
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setPaused(bool paused_) external onlyCreator {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function activateRound(
        uint256 depositAmount,
        uint256 stakeAmount,
        uint32 unstakeDelay
    ) external payable onlyFactory {
        require(roundState == RoundState.Initializing, AlreadyActivated());
        require(
            depositAmount != 0 &&
                stakeAmount != 0 &&
                unstakeDelay != 0 &&
                msg.value == depositAmount + stakeAmount,
            InvalidActivationValue()
        );
        roundState = RoundState.Active;
        IChitEntryPoint(entryPoint).depositTo{value: depositAmount}(
            address(this)
        );
        IChitEntryPoint(entryPoint).addStake{value: stakeAmount}(unstakeDelay);
    }

    function authorizationDigest(
        ChitUserOperation calldata userOp,
        uint256 maxCost,
        uint48 validUntil
    ) external view returns (bytes32) {
        return _authorizationDigest(userOp, maxCost, validUntil);
    }

    function validatePaymasterUserOp(
        ChitUserOperation calldata userOp,
        bytes32,
        uint256 maxCost
    ) external view returns (bytes memory context, uint256 validationData) {
        require(msg.sender == entryPoint, NotEntryPoint());
        if (
            !_eligible(userOp.sender) ||
            userOp.paymasterAndData.length < PAYMASTER_FIELDS_LENGTH
        ) {
            return ("", SIG_VALIDATION_FAILED);
        }
        (uint48 validUntil, bytes memory signature) = abi.decode(
            userOp.paymasterAndData[PAYMASTER_FIELDS_LENGTH:],
            (uint48, bytes)
        );
        if (!_validAuthorization(userOp, maxCost, validUntil, signature)) {
            return ("", SIG_VALIDATION_FAILED);
        }
        return (abi.encode(userOp.sender), uint256(validUntil) << 160);
    }

    function _validAuthorization(
        ChitUserOperation calldata userOp,
        uint256 maxCost,
        uint48 validUntil,
        bytes memory signature
    ) private view returns (bool) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            _authorizationDigest(userOp, maxCost, validUntil)
        );
        (address signer, ECDSA.RecoverError recoverError, ) = ECDSA.tryRecover(
            digest,
            signature
        );
        return
            recoverError == ECDSA.RecoverError.NoError &&
            signer == verifier &&
            validUntil >= block.timestamp;
    }

    function _eligible(address account) private view returns (bool) {
        return
            roundState == RoundState.Active &&
            !paused &&
            IChitVaultEligibility(vault).sponsorCount() >= 2 &&
            IChitSettlementEligibility(settlement).enrolled(account);
    }

    function postOp(
        ChitPostOpMode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256
    ) external {
        require(msg.sender == entryPoint, NotEntryPoint());
        address account = abi.decode(context, (address));
        claim[currentEpoch][account] += actualGasCost;
        epochTotal[currentEpoch] += actualGasCost;
        emit ChitRecorded(currentEpoch, account, actualGasCost);
    }

    function closeEpoch() external onlyOperator returns (uint256 closedEpoch) {
        require(roundState == RoundState.Active, InvalidRoundState());
        return _closeEpoch();
    }

    function requestClose() external onlyCreator {
        require(roundState == RoundState.Active, InvalidRoundState());
        paused = true;
        roundState = RoundState.Closing;
        uint256 finalEpoch = _closeEpoch();
        emit PausedSet(true);
        emit RoundClosing(finalEpoch);
    }

    function finalizeClose() external onlyCreator {
        require(roundState == RoundState.Closing, InvalidRoundState());
        require(
            IChitSettlementLifecycle(settlement).settledEpochs() == currentEpoch,
            UnsettledEpochs()
        );
        roundState = RoundState.Closed;
        emit RoundClosed();
    }

    function withdrawDeposit() external onlyCreator {
        require(roundState == RoundState.Closed, InvalidRoundState());
        uint256 amount = IChitEntryPoint(entryPoint).balanceOf(address(this));
        if (amount != 0) {
            IChitEntryPoint(entryPoint).withdrawTo(payable(creator), amount);
        }
    }

    function unlockStake() external onlyCreator {
        require(roundState == RoundState.Closed, InvalidRoundState());
        IChitEntryPoint(entryPoint).unlockStake();
    }

    function withdrawStake() external onlyCreator {
        require(roundState == RoundState.Closed, InvalidRoundState());
        IChitEntryPoint(entryPoint).withdrawStake(payable(creator));
    }

    function _closeEpoch() private returns (uint256 closedEpoch) {
        closedEpoch = currentEpoch++;
        emit EpochClosed(closedEpoch, epochTotal[closedEpoch]);
    }

    function deposit() external payable {
        IChitEntryPoint(entryPoint).depositTo{value: msg.value}(address(this));
    }

    function entryPointBalance() external view returns (uint256) {
        return IChitEntryPoint(entryPoint).balanceOf(address(this));
    }

    function stakeInfo()
        external
        view
        returns (uint112 stake, uint32 unstakeDelay, bool staked)
    {
        IChitEntryPoint.DepositInfo memory info = IChitEntryPoint(entryPoint)
            .getDepositInfo(address(this));
        return (info.stake, info.unstakeDelaySec, info.staked);
    }

    function _authorizationDigest(
        ChitUserOperation calldata userOp,
        uint256 maxCost,
        uint48 validUntil
    ) private view returns (bytes32) {
        bytes32 paymasterFieldsHash = userOp.paymasterAndData.length < PAYMASTER_FIELDS_LENGTH
            ? bytes32(0)
            : keccak256(userOp.paymasterAndData[:PAYMASTER_FIELDS_LENGTH]);
        return
            keccak256(
                abi.encode(
                    AUTHORIZATION_TYPEHASH,
                    block.chainid,
                    entryPoint,
                    address(this),
                    _userOperationHash(userOp),
                    paymasterFieldsHash,
                    maxCost,
                    validUntil
                )
            );
    }

    function _userOperationHash(
        ChitUserOperation calldata userOp
    ) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    USER_OPERATION_TYPEHASH,
                    userOp.sender,
                    userOp.nonce,
                    keccak256(userOp.initCode),
                    keccak256(userOp.callData),
                    userOp.accountGasLimits,
                    userOp.preVerificationGas,
                    userOp.gasFees
                )
            );
    }
}
