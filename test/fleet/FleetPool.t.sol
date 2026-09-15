// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FleetPool} from "../../contracts/fleet/FleetPool.sol";

/// Pre-audit tests for FleetPool. Each `test_finding_*` was written to
/// reproduce one item in docs/audit/2026-09-14-fleet-pool-pre-audit.md against
/// the contract as it was. F1, F4 and F5 are fixed and their tests now assert
/// the refusal; F2 and F3 still pass as reproductions, because they are the
/// custody and the atomicity questions a later change answers. The rest pin
/// behaviour the contract promises in its own comments.
///
/// Runs with `npx hardhat test solidity`. The invariant suite is in
/// FleetPoolInvariants.t.sol.
contract FleetPoolTest is Test {
    FleetPool internal pool;

    address internal constant OPERATOR = address(0x0e0e);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant FLEET_ACCOUNT = address(0xF1EE7);
    bytes32 internal constant CAMPAIGN = keccak256("campaign-1");

    function setUp() public {
        pool = new FleetPool(OPERATOR);
        vm.deal(ALICE, 10 ether);
        vm.deal(BOB, 10 ether);
        vm.deal(OPERATOR, 10 ether);
        vm.warp(1_700_000_000);
    }

    // --- helpers ---------------------------------------------------------

    function _deposit(address who, uint256 size) internal {
        vm.prank(who);
        pool.deposit{value: size}();
    }

    function _openAndFund(bytes32 campaign, uint256 amount, address account) internal {
        address[] memory accounts = new address[](1);
        accounts[0] = account;
        vm.startPrank(OPERATOR);
        pool.openDraw(campaign, amount, uint64(block.timestamp + 60), "");
        vm.warp(block.timestamp + 60);
        pool.fund(campaign, accounts);
        vm.stopPrank();
    }

    function _unspent(address who) internal view returns (uint256) {
        (uint256 deposited, uint256 spent,,) = pool.depositorOf(who);
        return deposited > spent ? deposited - spent : 0;
    }

    // --- F1, fixed: no deposit while an exit is pending -----------------------

    /// A deposit after requestExit used to be paid out as min(exitAmount,
    /// unspent) and then deleted with the record. It is refused now; Alice
    /// exits, then deposits again.
    function test_finding_F1_depositAfterExitRequestIsRefused() public {
        _deposit(ALICE, 0.05 ether);
        vm.prank(ALICE);
        pool.requestExit();

        vm.prank(ALICE);
        vm.expectRevert(FleetPool.ExitPending.selector);
        pool.deposit{value: 0.1 ether}();

        vm.warp(block.timestamp + 24 hours);
        vm.prank(ALICE);
        pool.executeExit();
        _deposit(ALICE, 0.1 ether);
        (uint256 deposited,,,) = pool.depositorOf(ALICE);
        assertEq(deposited, 0.1 ether, "after the exit, a fresh record");
    }

    // --- F2: the operator can move the whole pool, not only what it charged --

    /// Draws are bounded by DRAW_CAP per campaign and by nothing else. An
    /// operator, or whoever holds its key, opens as many campaigns as it likes
    /// and funds accounts it controls until the pool is empty. Alice's exit
    /// then fails on transfer. This is the custody the README discloses; the
    /// test pins its size: everything, not "spend the operator posted".
    function test_finding_F2_operatorCanEmptyThePool() public {
        _deposit(ALICE, 0.1 ether);
        _deposit(ALICE, 0.1 ether);
        _deposit(BOB, 0.1 ether);
        assertEq(address(pool).balance, 0.3 ether);

        address drain = address(0xD4A1);
        uint256 rest = 0.15 ether - pool.GAS_HEADROOM();
        for (uint256 i = 0; i < 2; i++) {
            bytes32 campaign = keccak256(abi.encode("rogue", i));
            _openAndFund(campaign, 0.15 ether, drain);
            vm.startPrank(OPERATOR);
            pool.fundPrincipal(campaign, drain, rest, 0);
            pool.commit(campaign, rest);
            vm.stopPrank();
        }
        assertEq(address(pool).balance, 0, "nothing left");
        assertEq(drain.balance, 0.3 ether, "all of it went to the operator's addresses");

        vm.prank(ALICE);
        pool.requestExit();
        vm.warp(block.timestamp + 24 hours);
        vm.prank(ALICE);
        vm.expectRevert(FleetPool.TransferFailed.selector);
        pool.executeExit();
    }

    // --- F3: a failed buy hands the principal to the trader ----------------

    /// The service sends principal with fundPrincipal, executes the buy in a
    /// second transaction, and on failure calls rollback with the operator's
    /// own ETH. At the contract level that means: principal is in the fleet
    /// account (the trader's), the draw is charged nothing, the operator is
    /// down by the principal. A trader who can make the buy revert is paid
    /// the principal by the operator, every time.
    function test_finding_F3_failedBuyIsPaidByTheOperator() public {
        _deposit(ALICE, 0.1 ether);
        _openAndFund(CAMPAIGN, 0.1 ether, FLEET_ACCOUNT);

        uint256 principal = 0.05 ether;
        uint256 operatorBefore = OPERATOR.balance;
        uint256 accountBefore = FLEET_ACCOUNT.balance;

        vm.prank(OPERATOR);
        pool.fundPrincipal(CAMPAIGN, FLEET_ACCOUNT, principal, 0.001 ether);
        // the buy reverts off chain; the service rolls back with its own ETH
        vm.prank(OPERATOR);
        pool.rollback{value: principal}(CAMPAIGN, principal);

        FleetPool.Draw memory draw = pool.drawOf(CAMPAIGN);
        assertEq(draw.spent, pool.GAS_HEADROOM(), "the draw was charged nothing for the buy");
        assertEq(FLEET_ACCOUNT.balance - accountBefore, principal, "the trader's account keeps the principal");
        assertEq(operatorBefore - OPERATOR.balance, principal, "the operator paid it");
        assertEq(_unspent(ALICE), 0.1 ether, "and Alice's balance is untouched");
    }

    // --- F4, fixed: a commit never charges less than the principal that left ---

    function test_finding_F4_commitBelowPrincipalIsRefused() public {
        _deposit(ALICE, 0.1 ether);
        _openAndFund(CAMPAIGN, 0.1 ether, FLEET_ACCOUNT);

        vm.startPrank(OPERATOR);
        pool.fundPrincipal(CAMPAIGN, FLEET_ACCOUNT, 0.05 ether, 0.001 ether);
        vm.expectRevert(FleetPool.CommitBelowPrincipal.selector);
        pool.commit(CAMPAIGN, 0.05 ether - 1);
        pool.commit(CAMPAIGN, 0.05 ether);
        vm.stopPrank();

        FleetPool.Draw memory draw = pool.drawOf(CAMPAIGN);
        assertEq(draw.spent, pool.GAS_HEADROOM() + 0.05 ether, "charged at least the principal");
        assertEq(draw.reserved, 0);
    }

    // --- F5, fixed: a queued spend is born inside its window -------------------

    function test_finding_F5_queuedSpendBeyondWindowIsRefused() public {
        vm.startPrank(OPERATOR);
        (bytes[] memory refs, uint256[] memory amounts, uint64[] memory dues) = _batch(1);
        amounts[0] = 0.01 ether;
        dues[0] = uint64(block.timestamp + 12 hours + 1);
        vm.expectRevert(FleetPool.DueBeyondWindow.selector);
        pool.queueSpendBatch(refs, amounts, dues);
        bytes32 id = _queueOne(0.01 ether, uint64(block.timestamp + 12 hours));
        vm.warp(block.timestamp + 12 hours);
        pool.postQueued(id, ALICE);
        vm.stopPrank();
        (, uint256 spent,,) = pool.depositorOf(ALICE);
        assertEq(spent, 0.01 ether, "a charge at the edge of the window still posts");
    }

    // --- F6: posted spend is bounded by nothing --------------------------

    /// postQueued names any depositor for any amount. The contract cannot know
    /// the depositor (that is the design) but it could know the aggregate: the
    /// sum of posted spend has no reason ever to exceed the sum of draw spend.
    /// Today it can.
    function test_finding_F6_postedSpendExceedsAllDrawSpend() public {
        _deposit(ALICE, 0.1 ether);
        assertEq(pool.totalDrawSpent(), 0, "no campaign has spent anything");

        vm.prank(OPERATOR);
        bytes32 id = _queueOne(1 ether, uint64(block.timestamp));
        vm.prank(OPERATOR);
        pool.postQueued(id, ALICE);

        assertEq(_unspent(ALICE), 0, "Alice was charged 1 ETH against 0 of draw spend");
    }

    // --- behaviour the contract promises, pinned ---------------------------

    function testFuzz_onlyPublishedSizesAreAccepted(uint256 value) public {
        value = bound(value, 1, 1 ether);
        vm.assume(value != 0.01 ether && value != 0.05 ether && value != 0.1 ether);
        vm.prank(ALICE);
        vm.expectRevert(FleetPool.SizeNotAllowed.selector);
        pool.deposit{value: value}();
    }

    function test_capsHold() public {
        for (uint256 i = 0; i < 5; i++) _deposit(ALICE, 0.1 ether);
        vm.prank(ALICE);
        vm.expectRevert(FleetPool.DepositorCapExceeded.selector);
        pool.deposit{value: 0.01 ether}();

        vm.prank(OPERATOR);
        vm.expectRevert(FleetPool.DrawCapExceeded.selector);
        pool.openDraw(CAMPAIGN, 0.2 ether + 1, uint64(block.timestamp + 60), "");
    }

    /// A36, fixed: pause stops every outflow and every widening of a claim,
    /// not only deposits and principal. A guardian that can only pause is
    /// worth having only if pause actually stops the money.
    function test_pauseGatesFundingTopUpAndClaim() public {
        _deposit(ALICE, 0.1 ether);
        address[] memory accounts = new address[](1);
        accounts[0] = FLEET_ACCOUNT;
        vm.startPrank(OPERATOR);
        pool.openDraw(CAMPAIGN, 0.05 ether, uint64(block.timestamp + 60), "");
        vm.warp(block.timestamp + 60);
        pool.setPaused(true);
        vm.expectRevert(FleetPool.Paused.selector);
        pool.fund(CAMPAIGN, accounts);
        vm.expectRevert(FleetPool.Paused.selector);
        pool.topUpDraw(CAMPAIGN, 0.01 ether);
        vm.expectRevert(FleetPool.Paused.selector);
        pool.claimOperator(0);
        pool.setPaused(false);
        pool.fund(CAMPAIGN, accounts);
        vm.stopPrank();
        assertEq(FLEET_ACCOUNT.balance, pool.GAS_HEADROOM(), "and funds again once unpaused");
    }

    /// R2a: a guardian can stop the money and nothing else. It cannot
    /// unpause, cannot move funds, cannot change itself.
    function test_guardianCanPauseAndOnlyPause() public {
        address guardian = address(0x6a4d);
        _deposit(ALICE, 0.1 ether);

        vm.prank(guardian);
        vm.expectRevert(FleetPool.NotGuardian.selector);
        pool.pause();

        vm.prank(OPERATOR);
        pool.setGuardian(guardian);
        vm.prank(guardian);
        pool.pause();
        assertTrue(pool.paused(), "the guardian stopped the money");

        vm.startPrank(guardian);
        vm.expectRevert(FleetPool.NotOperator.selector);
        pool.setPaused(false);
        vm.expectRevert(FleetPool.NotOperator.selector);
        pool.setGuardian(guardian);
        vm.expectRevert(FleetPool.NotOperator.selector);
        pool.openDraw(CAMPAIGN, 0.05 ether, uint64(block.timestamp + 60), "");
        vm.stopPrank();

        vm.prank(OPERATOR);
        vm.expectRevert(FleetPool.Paused.selector);
        pool.openDraw(CAMPAIGN, 0.05 ether, uint64(block.timestamp + 60), "");

        vm.prank(OPERATOR);
        pool.setPaused(false);
        assertFalse(pool.paused(), "only the operator releases the brake");
    }

    function test_exitWorksWhilePausedAndWithoutTheOperator() public {
        _deposit(ALICE, 0.05 ether);
        vm.prank(OPERATOR);
        pool.setPaused(true);

        vm.prank(ALICE);
        pool.requestExit();
        vm.warp(block.timestamp + 24 hours);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.executeExit();
        assertEq(ALICE.balance - before, 0.05 ether);
    }

    function test_spendPostedAfterExitRequestStillCounts() public {
        _deposit(ALICE, 0.1 ether);
        vm.prank(ALICE);
        pool.requestExit();

        vm.prank(OPERATOR);
        bytes32 id = _queueOne(0.03 ether, uint64(block.timestamp + 60));
        vm.warp(block.timestamp + 60);
        vm.prank(OPERATOR);
        pool.postQueued(id, ALICE);

        vm.warp(block.timestamp + 24 hours);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.executeExit();
        assertEq(ALICE.balance - before, 0.07 ether, "the bill posted during the wait is honoured");
    }

    function test_fundingBeforeDueIsRefused() public {
        _deposit(ALICE, 0.1 ether);
        address[] memory accounts = new address[](1);
        accounts[0] = FLEET_ACCOUNT;
        vm.startPrank(OPERATOR);
        pool.openDraw(CAMPAIGN, 0.1 ether, uint64(block.timestamp + 60), "");
        vm.expectRevert(FleetPool.NotDue.selector);
        pool.fund(CAMPAIGN, accounts);
        vm.expectRevert(FleetPool.DelayTooShort.selector);
        pool.openDraw(keccak256("c2"), 0.1 ether, uint64(block.timestamp + 59), "");
        vm.stopPrank();
    }

    function test_claimableIsExactlyTheGasFronted() public {
        _deposit(ALICE, 0.1 ether);
        _openAndFund(CAMPAIGN, 0.1 ether, FLEET_ACCOUNT);
        assertEq(pool.claimable(), 0, "headroom left the pool, nothing is owed for it");

        vm.startPrank(OPERATOR);
        pool.fundPrincipal(CAMPAIGN, FLEET_ACCOUNT, 0.05 ether, 0.001 ether);
        pool.commit(CAMPAIGN, 0.05 ether + 0.0007 ether);
        vm.stopPrank();
        assertEq(pool.claimable(), 0.0007 ether, "only the gas is owed");

        vm.prank(OPERATOR);
        vm.expectRevert(FleetPool.ClaimExceeded.selector);
        pool.claimOperator(0.0007 ether + 1);
    }

    /// A reentrant account cannot pull a second headroom or principal: state
    /// moves before ETH does, so the re-entered call sees the draw already
    /// funded and reverts, and the outer call's revert bubbles up.
    function test_reentrantAccountCannotDoubleFund() public {
        _deposit(ALICE, 0.1 ether);
        Reenterer evil = new Reenterer(pool, CAMPAIGN);
        address[] memory accounts = new address[](1);
        accounts[0] = address(evil);
        vm.startPrank(OPERATOR);
        pool.openDraw(CAMPAIGN, 0.1 ether, uint64(block.timestamp + 60), "");
        vm.warp(block.timestamp + 60);
        vm.expectRevert(FleetPool.TransferFailed.selector);
        pool.fund(CAMPAIGN, accounts);
        vm.stopPrank();
    }
    // --- batch queueing: charges leave the operator in one sweep, never after a buy ---

    /// The join the pool exists to break was the operator's own transaction
    /// order: a buy, then its charge, next nonce. Charges now queue in one
    /// batch, each with its own due time, in a transaction that follows no buy.
    function test_queueSpendBatch_queuesEveryEntryWithItsOwnDueTime() public {
        (bytes[] memory refs, uint256[] memory amounts, uint64[] memory dues) = _batch(3);
        vm.prank(OPERATOR);
        bytes32[] memory ids = pool.queueSpendBatch(refs, amounts, dues);
        assertEq(ids.length, 3);
        assertEq(pool.queuedSpendCount(), 3);
        for (uint256 i = 0; i < 3; i++) {
            (bytes32 id, FleetPool.QueuedSpend memory q) = pool.queuedSpendAt(i);
            assertEq(id, ids[i]);
            assertEq(q.amount, amounts[i]);
            assertEq(q.dueAt, dues[i]);
            assertEq(q.queuedAt, uint64(block.timestamp));
            assertEq(q.posted, false);
        }
    }

    // --- random ids: a posting cannot be matched to its queueing by counting ---

    /// Sequential ids made SpendPosted a lookup: the k-th posting was the k-th
    /// queueing, which was the k-th buy. Ids are now hashes with chain entropy
    /// in them, so two identical entries in one batch still get two ids, and
    /// neither says where in the batch it sat.
    function test_queueIds_areDistinctForIdenticalEntriesAndNotSequential() public {
        (bytes[] memory refs, uint256[] memory amounts, uint64[] memory dues) = _batch(3);
        refs[1] = refs[0];
        amounts[1] = amounts[0];
        dues[1] = dues[0];
        vm.prank(OPERATOR);
        bytes32[] memory ids = pool.queueSpendBatch(refs, amounts, dues);
        assertTrue(ids[0] != ids[1], "identical entries, distinct ids");
        assertTrue(ids[0] != bytes32(0) && ids[1] != bytes32(0) && ids[2] != bytes32(0));
        assertTrue(uint256(ids[1]) != uint256(ids[0]) + 1 && uint256(ids[2]) != uint256(ids[1]) + 1, "not a counter");
    }

    function test_postQueued_refusesAnUnknownId() public {
        vm.prank(OPERATOR);
        vm.expectRevert(FleetPool.UnknownSpend.selector);
        pool.postQueued(keccak256("never queued"), ALICE);
    }

    function test_queueSpendBatch_refusesTheWholeBatchWhenOneEntryIsBeyondTheWindow() public {
        (bytes[] memory refs, uint256[] memory amounts, uint64[] memory dues) = _batch(3);
        dues[1] = uint64(block.timestamp + 12 hours + 1);
        vm.prank(OPERATOR);
        vm.expectRevert(FleetPool.DueBeyondWindow.selector);
        pool.queueSpendBatch(refs, amounts, dues);
        assertEq(pool.queuedSpendCount(), 0, "nothing from a refused batch is queued");
    }

    function test_queueSpendBatch_refusesMismatchedLengthsAndAnEmptyBatch() public {
        (bytes[] memory refs, uint256[] memory amounts, uint64[] memory dues) = _batch(2);
        uint64[] memory shortDues = new uint64[](1);
        shortDues[0] = dues[0];
        vm.startPrank(OPERATOR);
        vm.expectRevert(FleetPool.LengthMismatch.selector);
        pool.queueSpendBatch(refs, amounts, shortDues);
        vm.expectRevert(FleetPool.EmptyBatch.selector);
        pool.queueSpendBatch(new bytes[](0), new uint256[](0), new uint64[](0));
        vm.stopPrank();
    }

    function test_queueSpendBatch_onlyTheOperator() public {
        (bytes[] memory refs, uint256[] memory amounts, uint64[] memory dues) = _batch(1);
        vm.prank(ALICE);
        vm.expectRevert(FleetPool.NotOperator.selector);
        pool.queueSpendBatch(refs, amounts, dues);
    }

    function _batch(uint256 n) internal view returns (bytes[] memory refs, uint256[] memory amounts, uint64[] memory dues) {
        refs = new bytes[](n);
        amounts = new uint256[](n);
        dues = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            refs[i] = abi.encodePacked("ref", i);
            amounts[i] = (i + 1) * 0.001 ether;
            dues[i] = uint64(block.timestamp + 90 + i * 300);
        }
    }

    /// One charge through the batch entry point; the single-entry function is gone.
    function _queueOne(uint256 amount, uint64 due) internal returns (bytes32 id) {
        bytes[] memory refs = new bytes[](1);
        uint256[] memory amounts = new uint256[](1);
        uint64[] memory dues = new uint64[](1);
        amounts[0] = amount;
        dues[0] = due;
        bytes32[] memory ids = pool.queueSpendBatch(refs, amounts, dues);
        return ids[0];
    }

}

/// A fleet account that tries to be funded twice from inside its receive.
contract Reenterer {
    FleetPool internal immutable pool;
    bytes32 internal immutable campaign;

    constructor(FleetPool pool_, bytes32 campaign_) {
        pool = pool_;
        campaign = campaign_;
    }

    receive() external payable {
        address[] memory me = new address[](1);
        me[0] = address(this);
        pool.fund(campaign, me);
    }
}
