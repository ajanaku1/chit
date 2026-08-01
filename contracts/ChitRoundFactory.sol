// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ChitPaymaster} from "./ChitPaymaster.sol";
import {ChitRoundCoreDeployer} from "./ChitRoundCoreDeployer.sol";
import {ChitSettlement} from "./ChitSettlement.sol";
import {ChitVault} from "./ChitVault.sol";

contract ChitRoundFactory {
    uint8 public constant INITIALIZATION_STEPS = 5;
    uint8 public constant ALL_STEPS_INITIALIZED = 31;
    uint32 public constant MINIMUM_UNSTAKE_DELAY = 1;

    struct Round {
        address creator;
        address operator;
        address verifier;
        address auditor;
        address vault;
        address settlement;
        address paymaster;
        uint8 initializedSteps;
    }

    address public immutable entryPoint;
    address public immutable wrapper;
    uint256 public immutable minimumStake;
    ChitRoundCoreDeployer public immutable coreDeployer;
    mapping(bytes32 roundId => Round round) private _rounds;

    error InvalidAddress();
    error RoundAlreadyExists();
    error RoundNotFound();
    error InvalidInitializationStep();
    error InitializationStepComplete();
    error NotRoundCreator();
    error RoundNotInitialized();
    error InvalidActivationValue();
    error StakeBelowMinimum();
    error OperatorFundingFailed();

    event RoundCreated(
        bytes32 indexed roundId,
        address indexed creator,
        address vault,
        address settlement,
        address paymaster,
        address operator,
        address verifier,
        address auditor
    );
    event RoundStepInitialized(bytes32 indexed roundId, uint8 indexed step);
    event RoundActivated(
        bytes32 indexed roundId,
        uint256 paymasterDeposit,
        uint256 stake,
        uint32 unstakeDelay,
        uint256 operatorGas
    );

    constructor(
        address entryPoint_,
        address wrapper_,
        uint256 minimumStake_
    ) {
        require(
            entryPoint_ != address(0) &&
                wrapper_ != address(0) &&
                minimumStake_ != 0,
            InvalidAddress()
        );
        entryPoint = entryPoint_;
        wrapper = wrapper_;
        minimumStake = minimumStake_;
        coreDeployer = new ChitRoundCoreDeployer(
            entryPoint_,
            wrapper_,
            address(this)
        );
    }

    function roundId(
        address creator,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    function beginRound(
        bytes32 salt,
        address operator,
        address verifier,
        address auditor
    ) external returns (bytes32 id) {
        require(
            operator != address(0) &&
                verifier != address(0) &&
                auditor != address(0),
            InvalidAddress()
        );
        id = roundId(msg.sender, salt);
        require(_rounds[id].creator == address(0), RoundAlreadyExists());
        _deployRound(id, msg.sender, operator, verifier, auditor);
    }

    function initializeRoundStep(bytes32 id, uint8 step) external {
        Round storage round = _rounds[id];
        require(round.creator != address(0), RoundNotFound());
        require(step < INITIALIZATION_STEPS, InvalidInitializationStep());
        uint8 flag = uint8(1 << step);
        require(round.initializedSteps & flag == 0, InitializationStepComplete());
        round.initializedSteps |= flag;
        if (step < 4) {
            ChitVault(round.vault).initializeBudget(step);
            ChitSettlement(round.settlement).initializeCharge(step);
        } else {
            ChitSettlement(round.settlement).initializeAggregate();
        }
        emit RoundStepInitialized(id, step);
    }

    function getRound(bytes32 id) external view returns (Round memory) {
        Round memory round = _rounds[id];
        require(round.creator != address(0), RoundNotFound());
        return round;
    }

    function activateRound(
        bytes32 id,
        uint256 paymasterDeposit,
        uint256 stake,
        uint32 unstakeDelay,
        uint256 operatorGas
    ) external payable {
        Round storage round = _rounds[id];
        require(round.creator != address(0), RoundNotFound());
        _validateActivation(
            round,
            paymasterDeposit,
            stake,
            unstakeDelay,
            operatorGas
        );
        ChitVault(round.vault).activate();
        ChitPaymaster(round.paymaster).activateRound{
            value: paymasterDeposit + stake
        }(paymasterDeposit, stake, unstakeDelay);
        (bool funded, ) = payable(round.operator).call{value: operatorGas}("");
        require(funded, OperatorFundingFailed());
        emit RoundActivated(
            id,
            paymasterDeposit,
            stake,
            unstakeDelay,
            operatorGas
        );
    }

    function _validateActivation(
        Round storage round,
        uint256 paymasterDeposit,
        uint256 stake,
        uint32 unstakeDelay,
        uint256 operatorGas
    ) private view {
        require(msg.sender == round.creator, NotRoundCreator());
        require(
            round.initializedSteps == ALL_STEPS_INITIALIZED,
            RoundNotInitialized()
        );
        require(
            paymasterDeposit != 0 &&
                stake != 0 &&
                unstakeDelay != 0 &&
                operatorGas != 0 &&
                msg.value == paymasterDeposit + stake + operatorGas,
            InvalidActivationValue()
        );
        require(
            stake >= minimumStake &&
                unstakeDelay >= MINIMUM_UNSTAKE_DELAY,
            StakeBelowMinimum()
        );
    }

    function _deployRound(
        bytes32 id,
        address creator,
        address operator,
        address verifier,
        address auditor
    ) private {
        (
            address vault,
            address settlement,
            address paymaster
        ) = coreDeployer.deployRound(
            creator,
            operator,
            verifier,
            auditor
        );
        ChitVault(vault).setSettlement(settlement);
        ChitSettlement(settlement).setPaymaster(paymaster);
        _recordRound(
            id,
            creator,
            operator,
            verifier,
            auditor,
            vault,
            settlement,
            paymaster
        );
    }

    function _recordRound(
        bytes32 id,
        address creator,
        address operator,
        address verifier,
        address auditor,
        address vault,
        address settlement,
        address paymaster
    ) private {
        Round memory round = _roundRecord(
            creator,
            operator,
            verifier,
            auditor,
            vault,
            settlement,
            paymaster
        );
        _rounds[id] = round;
        _emitRoundCreated(id, round);
    }

    function _roundRecord(
        address creator,
        address operator,
        address verifier,
        address auditor,
        address vault,
        address settlement,
        address paymaster
    ) private pure returns (Round memory) {
        return Round({
            creator: creator,
            operator: operator,
            verifier: verifier,
            auditor: auditor,
            vault: vault,
            settlement: settlement,
            paymaster: paymaster,
            initializedSteps: 0
        });
    }

    function _emitRoundCreated(bytes32 id, Round memory round) private {
        emit RoundCreated(
            id,
            round.creator,
            round.vault,
            round.settlement,
            round.paymaster,
            round.operator,
            round.verifier,
            round.auditor
        );
    }
}
