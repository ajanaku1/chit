// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FleetPool} from "../../contracts/fleet/FleetPool.sol";

/// Pre-audit tests for FleetPool. Each `test_finding_*` reproduces one item in
/// docs/audit/2026-09-14-fleet-pool-pre-audit.md against the contract as it is,
/// so the finding is a failing-or-passing predicate rather than an opinion,
/// and a fix flips the test. The rest pin behaviour the contract promises in
/// its own comments: caps, sizes, the exit path, checks-effects-interactions.
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

    // --- F1: a deposit made after requestExit is lost on executeExit --------

    /// Alice holds 0.05, requests exit, then deposits 0.1 more (nothing stops
    /// her). Twenty-four hours later executeExit pays min(exitAmount, unspent)
    /// = 0.05 and deletes her record, which held 0.15. The other 0.1 stays in
    /// the pool with no depositor attached to it.
    function test_finding_F1_depositAfterExitRequestIsLost() public {
        _deposit(ALICE, 0.05 ether);
        vm.prank(ALICE);
        pool.requestExit();

        _deposit(ALICE, 0.1 ether);
        (uint256 deposited,,,) = pool.depositorOf(ALICE);
        assertEq(deposited, 0.15 ether, "the second deposit was accepted");

        vm.warp(block.timestamp + 24 hours);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.executeExit();

        assertEq(ALICE.balance - before, 0.05 ether, "paid only the snapshot");
        (deposited,,,) = pool.depositorOf(ALICE);
        assertEq(deposited, 0, "record deleted, the 0.1 is gone from Alice's side");
        assertEq(address(pool).balance, 0.1 ether, "and it is still in the pool, owned by nobody");
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

    // --- F4: commit may charge less than the principal that left -------------

    /// The service always charges principal plus gas, so this never happens
    /// today. The contract lets it happen, and a service bug or a replaced
    /// service would leak the difference out of the pool uncharged.
    function test_finding_F4_commitBelowPrincipalIsAccepted() public {
        _deposit(ALICE, 0.1 ether);
        _openAndFund(CAMPAIGN, 0.1 ether, FLEET_ACCOUNT);

        vm.prank(OPERATOR);
        pool.fundPrincipal(CAMPAIGN, FLEET_ACCOUNT, 0.05 ether, 0.001 ether);
        vm.prank(OPERATOR);
        pool.commit(CAMPAIGN, 1 wei);

        FleetPool.Draw memory draw = pool.drawOf(CAMPAIGN);
        assertEq(draw.spent, pool.GAS_HEADROOM() + 1 wei, "0.05 ETH left, 1 wei charged");
        assertEq(draw.reserved, 0);
    }

    // --- F5: a queued spend can be born unpostable -------------------------

    /// POST_WINDOW runs from queuedAt, dueAt is unchecked. A dueAt later than
    /// queuedAt + 12h yields a spend that is never due inside its window, so
    /// the charge is silently lost and the pool is short by that amount.
    function test_finding_F5_queuedSpendCanNeverBePosted() public {
        vm.prank(OPERATOR);
        uint256 id = pool.queueSpend("", 0.01 ether, uint64(block.timestamp + 13 hours));

        vm.warp(block.timestamp + 12 hours + 1);
        vm.prank(OPERATOR);
        vm.expectRevert(FleetPool.NotDue.selector);
        pool.postQueued(id, ALICE);

        vm.warp(block.timestamp + 1 hours);
        vm.prank(OPERATOR);
        vm.expectRevert(FleetPool.PostWindowClosed.selector);
        pool.postQueued(id, ALICE);
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
        uint256 id = pool.queueSpend("", 1 ether, uint64(block.timestamp));
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
        uint256 id = pool.queueSpend("", 0.03 ether, uint64(block.timestamp + 60));
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
