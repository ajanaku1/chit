// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FleetPool} from "../../contracts/fleet/FleetPool.sol";
import {FleetSessionPolicy} from "../../contracts/fleet/FleetSessionPolicy.sol";

/// The hot key and the cold key (pre-audit R2b, R2d). The operator is the key
/// the service holds and signs with all day; it moves money and nothing else.
/// The admin is a cold, two-step owner: it rotates the operator, unpauses,
/// names the guardian and claims gas. A leaked operator key can be rotated
/// out instead of the pool being abandoned, and it cannot unpause itself.
contract FleetPoolAdminTest is Test {
    FleetPool internal pool;
    FleetSessionPolicy internal policy;

    address internal constant ADMIN = address(0xAD);
    address internal constant OPERATOR = address(0x0e0e);
    address internal constant OPERATOR2 = address(0x0e0f);
    address internal constant GUARDIAN = address(0x6a);
    address internal constant ALICE = address(0xA11CE);
    bytes32 internal constant CAMPAIGN = keccak256("admin-1");

    function setUp() public {
        vm.deal(ALICE, 1 ether);
        vm.warp(1_700_000_000);
        pool = new FleetPool(ADMIN, OPERATOR, 0.5 ether, 0.2 ether, 5 ether);
        policy = new FleetSessionPolicy(ADMIN, OPERATOR);
    }

    function _unauthorized(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who);
    }

    // --- the operator moves money and nothing else ---------------------------

    function test_operatorCannotUnpauseNameTheGuardianOrClaim() public {
        vm.startPrank(OPERATOR);
        vm.expectRevert(_unauthorized(OPERATOR));
        pool.setPaused(false);
        vm.expectRevert(_unauthorized(OPERATOR));
        pool.setGuardian(GUARDIAN);
        vm.expectRevert(_unauthorized(OPERATOR));
        pool.claimOperator(0);
        vm.expectRevert(_unauthorized(OPERATOR));
        pool.setOperator(OPERATOR2);
        vm.stopPrank();
    }

    function test_operatorCanStillPauseButNotUnpause() public {
        vm.prank(OPERATOR);
        pool.pause();
        assertTrue(pool.paused());
        vm.prank(OPERATOR);
        vm.expectRevert(_unauthorized(OPERATOR));
        pool.setPaused(false);
        vm.prank(ADMIN);
        pool.setPaused(false);
        assertFalse(pool.paused(), "only the admin unpauses");
    }

    // --- the admin administers and never moves money -------------------------

    function test_adminCannotOpenADrawOrFund() public {
        vm.startPrank(ADMIN);
        vm.expectRevert(FleetPool.NotOperator.selector);
        pool.openDraw(CAMPAIGN, 0.01 ether, uint64(block.timestamp + 60), "");
        vm.expectRevert(FleetPool.NotOperator.selector);
        pool.queueSpendBatch(new bytes[](0), new uint256[](0), new uint64[](0));
        vm.stopPrank();
    }

    function test_adminNamesTheGuardianAndAnyOfTheThreeCanPause() public {
        vm.prank(ADMIN);
        pool.setGuardian(GUARDIAN);
        assertEq(pool.guardian(), GUARDIAN);

        vm.prank(GUARDIAN);
        pool.pause();
        assertTrue(pool.paused());
        vm.prank(ADMIN);
        pool.setPaused(false);

        vm.prank(ADMIN);
        pool.pause();
        assertTrue(pool.paused(), "the admin can pause too");
        vm.prank(ADMIN);
        pool.setPaused(false);

        vm.prank(ALICE);
        vm.expectRevert(FleetPool.NotGuardian.selector);
        pool.pause();
    }

    // --- rotation: a leaked hot key is replaced, not the pool -------------------

    function test_setOperatorRotatesTheHotKey() public {
        vm.prank(ADMIN);
        pool.setOperator(OPERATOR2);
        assertEq(pool.operator(), OPERATOR2);

        vm.prank(OPERATOR);
        vm.expectRevert(FleetPool.NotOperator.selector);
        pool.openDraw(CAMPAIGN, 0.01 ether, uint64(block.timestamp + 60), "");

        vm.prank(OPERATOR2);
        pool.openDraw(CAMPAIGN, 0.01 ether, uint64(block.timestamp + 60), "");
        assertEq(uint256(pool.drawOf(CAMPAIGN).state), uint256(FleetPool.DrawState.Pending));
    }

    function test_setOperatorRefusesTheZeroAddress() public {
        vm.prank(ADMIN);
        vm.expectRevert(FleetPool.ZeroAddress.selector);
        pool.setOperator(address(0));
    }

    function test_adminHandoverIsTwoStep() public {
        address next = address(0xAE);
        vm.prank(ADMIN);
        pool.transferOwnership(next);
        assertEq(pool.owner(), ADMIN, "nothing changes until the new admin accepts");
        assertEq(pool.pendingOwner(), next);
        vm.prank(next);
        pool.acceptOwnership();
        assertEq(pool.owner(), next);
        vm.prank(ADMIN);
        vm.expectRevert(_unauthorized(ADMIN));
        pool.setGuardian(GUARDIAN);
    }

    function test_constructorRefusesZeroRoles() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new FleetPool(address(0), OPERATOR, 0.5 ether, 0.2 ether, 5 ether);
        vm.expectRevert(FleetPool.ZeroAddress.selector);
        new FleetPool(ADMIN, address(0), 0.5 ether, 0.2 ether, 5 ether);
    }

    // --- the policy follows the same split -----------------------------------

    function test_policyPoolIsSetByTheAdminAndOperatorRotates() public {
        vm.prank(OPERATOR);
        vm.expectRevert(_unauthorized(OPERATOR));
        policy.setPool(address(pool));
        vm.prank(ADMIN);
        policy.setPool(address(pool));
        assertEq(policy.pool(), address(pool));

        vm.prank(ADMIN);
        policy.setOperator(OPERATOR2);
        assertEq(policy.operator(), OPERATOR2);
        vm.prank(OPERATOR);
        vm.expectRevert(FleetSessionPolicy.NotOperator.selector);
        policy.pause(CAMPAIGN);
    }
}
