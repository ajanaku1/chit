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
        pool = new FleetPool(ADMIN, OPERATOR);
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

    /// M2. The service pays a withdrawal from the operator's wallet and posts
    /// the charge (pool-buy.ts withdraw). research.md says claimOperator
    /// reimburses it; claimable() counts fronted gas only, so it never does.
    function test_finding_M2_aWithdrawalIsNeverReimbursed() public {
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

        assertEq(OPERATOR.balance, operatorBefore - 0.1 ether, "the operator is out 0.1");
        assertEq(address(pool).balance, 0.1 ether, "the pool holds it");
        assertEq(pool.totalDeposited(), 0, "for no depositor");
        assertEq(pool.claimable(), 0, "and none of it is claimable");
        vm.prank(ADMIN);
        vm.expectRevert(FleetPool.ClaimExceeded.selector);
        pool.claimOperator(1);
    }

    /// M3. A charge that misses POST_WINDOW is a hole in the pool. The trader it
    /// belonged to exits whole; the last trader out cannot exit at all, because
    /// executeExit pays in full or reverts.
    function test_finding_M3_anExpiredChargeMakesTheLastExitRevert() public {
        _deposit(ALICE, 0.1 ether);
        _deposit(BOB, 0.1 ether);

        // Alice's fleet spends 0.05 of the pool.
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
        assertEq(address(pool).balance, 0.15 ether);

        // The charge is queued, and the sweep does not get to it for twelve hours.
        bytes32 id = _queue(0.05 ether);
        vm.warp(block.timestamp + 12 hours + 1);
        vm.prank(OPERATOR);
        vm.expectRevert(FleetPool.PostWindowClosed.selector);
        pool.postQueued(id, ALICE);

        // Alice leaves with everything she deposited, 0.05 of it Bob's.
        uint256 aliceBefore = ALICE.balance;
        _exit(ALICE);
        assertEq(ALICE.balance - aliceBefore, 0.1 ether);

        // Bob cannot leave: not with 0.05, not with anything.
        vm.prank(BOB);
        pool.requestExit();
        vm.warp(block.timestamp + 24 hours);
        vm.prank(BOB);
        vm.expectRevert(FleetPool.TransferFailed.selector);
        pool.executeExit();
    }

    /// M3, the remedy that exists. The pool takes no plain ETH, so the hole is
    /// closed by a deposit of a published size from a wallet that then never
    /// exits. That works, and not while the pool is paused: which is when it
    /// would be needed.
    function test_finding_M3_thePoolIsMadeWholeOnlyThroughADeposit() public {
        vm.prank(OPERATOR);
        (bool ok, ) = address(pool).call{value: 0.05 ether}("");
        assertFalse(ok, "no receive(): the pool refuses plain ETH");

        vm.prank(OPERATOR);
        pool.deposit{value: 0.05 ether}();
        assertEq(address(pool).balance, 0.05 ether, "a deposit is the top-up");

        vm.prank(OPERATOR);
        pool.pause();
        vm.prank(OPERATOR);
        vm.expectRevert(FleetPool.Paused.selector);
        pool.deposit{value: 0.05 ether}();
    }
}
