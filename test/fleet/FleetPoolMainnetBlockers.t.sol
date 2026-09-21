// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FleetPool} from "../../contracts/fleet/FleetPool.sol";

/// Mainnet readiness, contract side: each `test_finding_*` reproduces one item
/// of chit-fleet-mainnet-readiness-2026-09-19.md on FleetPool as it is at
/// 40aee16. They pass today, in the idiom of FleetPool.t.sol; the fix flips them.
///
/// Runs with `npx hardhat test solidity`.
contract FleetPoolMainnetBlockersTest is Test {
    FleetPool internal pool;

    address internal constant ADMIN = address(0xAD);
    address internal constant OPERATOR = address(0x0e0e);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant PAYEE = address(0xFEE5);
    address internal constant FLEET_ACCOUNT = address(0xF1EE7);
    bytes32 internal constant CAMPAIGN = keccak256("campaign-1");

    function setUp() public {
        pool = new FleetPool(ADMIN, OPERATOR, 0.5 ether, 0.2 ether, 5 ether);
        vm.deal(ALICE, 10 ether);
        vm.deal(BOB, 10 ether);
        vm.deal(OPERATOR, 10 ether);
        vm.warp(1_700_000_000);
    }

    function _deposit(address who, uint256 size) internal {
        vm.prank(who);
        pool.deposit{value: size}();
    }

    function _queue(uint256 amount) internal returns (bytes32 id) {
        bytes[] memory refs = new bytes[](1);
        uint256[] memory amounts = new uint256[](1);
        uint64[] memory dues = new uint64[](1);
        amounts[0] = amount;
        dues[0] = uint64(block.timestamp + 60);
        vm.prank(OPERATOR);
        id = pool.queueSpendBatch(refs, amounts, dues)[0];
    }

    function _exit(address who) internal {
        vm.prank(who);
        pool.requestExit();
        vm.warp(block.timestamp + 24 hours);
        vm.prank(who);
        pool.executeExit();
    }

    /// M2, fixed (T038). The service pays a withdrawal from the operator's
    /// wallet and posts the charge; the claim now reimburses it out of the
    /// pool's surplus, through the same claim that reimburses fronted gas.
    function test_fixed_M2_aWithdrawalIsReimbursedFromTheSurplus() public {
        _deposit(ALICE, 0.1 ether);

        // The payout: operator to payee, outside the pool, on purpose.
        uint256 operatorBefore = OPERATOR.balance;
        vm.prank(OPERATOR);
        (bool ok, ) = PAYEE.call{value: 0.1 ether}("");
        assertTrue(ok);

        // The charge, queued and posted inside its window.
        bytes32 id = _queue(0.1 ether);
        vm.warp(block.timestamp + 60);
        vm.prank(OPERATOR);
        pool.postQueued(id, ALICE);

        // Alice has been paid in full and leaves with nothing more.
        _exit(ALICE);

        assertEq(address(pool).balance, 0.1 ether, "the pool holds what was posted");
        assertEq(pool.totalDeposited(), 0, "for no depositor");
        assertEq(pool.claimable(), 0.1 ether, "and all of it is the operator's to claim");
        vm.prank(ADMIN);
        pool.claimOperator(0.1 ether);
        assertEq(OPERATOR.balance, operatorBefore, "the operator is made whole");
        assertEq(address(pool).balance, 0, "and the pool owes nobody");
    }

    /// M3, fixed (T039). A batch posts what it can and reports the rest: an
    /// expired charge says so and the charge beside it still posts, in one
    /// transaction that reverts for neither.
    function test_fixed_M3_aBatchPostsWhatItCanAndReportsTheRest() public {
        _deposit(ALICE, 0.1 ether);
        _deposit(BOB, 0.1 ether);
        bytes32 stale = _queue(0.02 ether);
        vm.warp(block.timestamp + 12 hours + 1);
        bytes32 fresh = _queue(0.03 ether);
        vm.warp(block.timestamp + 60);

        bytes32[] memory ids = new bytes32[](3);
        address[] memory whos = new address[](3);
        ids[0] = stale; whos[0] = ALICE;
        ids[1] = fresh; whos[1] = BOB;
        ids[2] = fresh; whos[2] = BOB;
        vm.prank(OPERATOR);
        FleetPool.PostResult[] memory results = pool.postQueuedBatch(ids, whos);

        assertEq(uint256(results[0]), uint256(FleetPool.PostResult.Expired));
        assertEq(uint256(results[1]), uint256(FleetPool.PostResult.Posted));
        assertEq(uint256(results[2]), uint256(FleetPool.PostResult.AlreadyPosted));
        (, uint256 aliceSpent,,) = pool.depositorOf(ALICE);
        (, uint256 bobSpent,,) = pool.depositorOf(BOB);
        assertEq(aliceSpent, 0, "the expired charge posted nothing");
        assertEq(bobSpent, 0.03 ether, "the fresh one posted once");
        assertEq(pool.totalPosted(), 0.03 ether);
    }

    /// M3, fixed (T039). The hole an expired charge leaves is closed by
    /// donate(), which credits nobody and works while paused; a deposit does
    /// not, and the last trader out is paid in full.
    function test_fixed_M3_thePoolIsMadeWholeByDonateWhilePaused() public {
        _deposit(ALICE, 0.1 ether);
        _deposit(BOB, 0.1 ether);

        // Alice's fleet spends 0.05 of the pool and the charge misses its window.
        address[] memory accounts = new address[](1);
        accounts[0] = FLEET_ACCOUNT;
        vm.startPrank(OPERATOR);
        pool.openDraw(CAMPAIGN, 0.06 ether, uint64(block.timestamp + 60), "");
        vm.warp(block.timestamp + 60);
        pool.fund(CAMPAIGN, accounts);
        pool.fundPrincipal(CAMPAIGN, FLEET_ACCOUNT, 0.05 ether - pool.GAS_HEADROOM(), 0);
        pool.commit(CAMPAIGN, 0.05 ether - pool.GAS_HEADROOM());
        pool.closeDraw(CAMPAIGN);
        vm.stopPrank();
        bytes32 id = _queue(0.05 ether);
        vm.warp(block.timestamp + 12 hours + 1);
        vm.prank(OPERATOR);
        vm.expectRevert(FleetPool.PostWindowClosed.selector);
        pool.postQueued(id, ALICE);
        _exit(ALICE);
        assertEq(address(pool).balance, 0.05 ether, "0.05 short of what Bob is owed");

        // The guardian pauses; a deposit is refused, a donation is not.
        vm.prank(OPERATOR);
        pool.pause();
        vm.prank(OPERATOR);
        vm.expectRevert(FleetPool.Paused.selector);
        pool.deposit{value: 0.05 ether}();
        vm.prank(OPERATOR);
        pool.donate{value: 0.05 ether}();
        assertEq(pool.donated(), 0.05 ether);
        assertEq(pool.totalDeposited(), 0.1 ether, "the donation credits nobody");

        // Bob leaves whole, paused or not.
        uint256 bobBefore = BOB.balance;
        _exit(BOB);
        assertEq(BOB.balance - bobBefore, 0.1 ether);
        assertEq(address(pool).balance, 0);
    }
}
