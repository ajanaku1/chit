// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FleetSessionPolicy} from "./FleetSessionPolicy.sol";

/// @title Fleet account
/// @notice A newly generated smart account owned by one browser-generated
///         credential. It is never an imported EOA (FR-005).
/// @dev Every call it makes is checked against the campaign's session policy
///      first, so the account cannot transfer assets, change ownership, withdraw
///      gas, authorize a key, or reach an unapproved contract (FR-008).
contract FleetAccount {
    address public immutable owner;
    address public immutable operator;
    FleetSessionPolicy public immutable policy;
    bytes32 public immutable campaign;

    error NotOperator();
    error CallFailed();
    error EmptyCallData();

    constructor(address owner_, address operator_, FleetSessionPolicy policy_, bytes32 campaign_) {
        owner = owner_;
        operator = operator_;
        policy = policy_;
        campaign = campaign_;
    }

    /// @notice Runs one policy-authorized call on behalf of the campaign.
    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory) {
        if (msg.sender != operator) revert NotOperator();
        if (data.length < 4) revert EmptyCallData();

        policy.check(campaign, address(this), target, bytes4(data[:4]), value, 0);

        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) revert CallFailed();
        return result;
    }

    receive() external payable {}
}

/// @title Fleet account factory
/// @notice Deterministically creates a campaign's 5-50 distinct fleet accounts
///         (FR-001) and returns the same addresses on a retry (FR-014).
contract FleetAccountFactory {
    struct FleetAccountInit {
        address ownerAddress;
        bytes32 salt;
    }

    uint256 public constant MIN_ACCOUNTS = 5;
    uint256 public constant MAX_ACCOUNTS = 50;

    address public immutable operator;

    event FleetAccountCreated(bytes32 indexed campaign, address indexed account, address indexed owner, bytes32 salt);

    error NotOperator();
    error AccountCountOutOfRange();
    error OwnersNotStrictlyIncreasing();

    constructor(address operator_) {
        operator = operator_;
    }

    /// @notice Creates, or returns, the campaign's fleet.
    /// @param inits Initializations in strictly increasing owner-address order.
    ///        The ordering is what enforces distinct owners in one pass; distinct
    ///        salts follow from the deterministic address of each account.
    /// @dev Re-running an interrupted activation redeploys nothing: an address
    ///      that already holds code is returned as it stands.
    function createFleet(
        bytes32 campaign,
        FleetSessionPolicy policy,
        FleetAccountInit[] calldata inits
    ) external returns (address[] memory accounts) {
        if (msg.sender != operator) revert NotOperator();
        if (inits.length < MIN_ACCOUNTS || inits.length > MAX_ACCOUNTS) revert AccountCountOutOfRange();

        accounts = new address[](inits.length);
        address previousOwner = address(0);

        for (uint256 index = 0; index < inits.length; ++index) {
            FleetAccountInit calldata init = inits[index];
            if (init.ownerAddress <= previousOwner) revert OwnersNotStrictlyIncreasing();
            previousOwner = init.ownerAddress;

            address predicted = accountAddress(campaign, policy, init.ownerAddress, init.salt);
            accounts[index] = predicted;
            if (predicted.code.length != 0) continue;

            FleetAccount created = new FleetAccount{salt: _salt(campaign, init.salt)}(
                init.ownerAddress,
                operator,
                policy,
                campaign
            );
            emit FleetAccountCreated(campaign, address(created), init.ownerAddress, init.salt);
        }
    }

    /// @notice The address a fleet account will occupy before it is deployed.
    function accountAddress(
        bytes32 campaign,
        FleetSessionPolicy policy,
        address ownerAddress,
        bytes32 salt
    ) public view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(FleetAccount).creationCode, abi.encode(ownerAddress, operator, policy, campaign))
        );
        return
            address(
                uint160(
                    uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(campaign, salt), initCodeHash)))
                )
            );
    }

    function _salt(bytes32 campaign, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(campaign, salt));
    }
}
