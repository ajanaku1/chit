// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FleetPool} from "../../contracts/fleet/FleetPool.sol";

/// The pool under a random sequence of honest actions: traders deposit, exit,
/// and are charged; the operator opens draws only against balances that exist,
/// funds, buys, commits or rolls back, posts every charge to the trader it
/// belongs to, and claims its gas. After every action the properties below
/// must hold. They are the accounting the contract cannot check itself because
/// it does not know which depositor is behind a campaign; the handler knows,
/// and asserts what the operator's ledger has to keep true.
///
/// A dishonest operator breaks these on purpose (see F2 in the pre-audit
/// report). This suite says what "the operator's ledger is right" means.
contract FleetPoolInvariants is StdInvariant, Test {
    FleetPool internal pool;
    Handler internal handler;

    function setUp() public {
        handler = new Handler();
        pool = handler.pool();
        targetContract(address(handler));
    }

    /// ETH in the contract is exactly what came in minus what went out. Any
    /// drift here is a path that moves ETH without counting it. totalOutflow
    /// is already net of rollbacks, so they do not appear separately.
    function invariant_balanceIsAccountedFor() public view {
        uint256 expected = handler.ghostDeposited() - pool.totalOutflow() - handler.ghostExitsPaid() - pool.totalClaimed();
        assertEq(address(pool).balance, expected, "balance != deposits - outflow - exits - claims");
    }

    /// The pool can always pay every honest trader what it owes them, once the
    /// operator has posted the spend it has already taken. What has been
    /// drawn but not yet posted is the only allowed gap, and it is bounded.
    function invariant_solventForHonestTraders() public view {
        // Charges the operator has taken or paid out but not yet posted: draw
        // spend, principal in flight, and withdrawals it paid from its own
        // wallet, minus everything already posted to a depositor.
        uint256 unposted = pool.totalDrawSpent() + handler.openPrincipal() + handler.ghostWithdrawn() - handler.ghostPosted();
        uint256 owed = handler.sumUnspent();
        assertGe(address(pool).balance + unposted, owed, "pool cannot cover honest balances");
    }

    /// Nothing the operator posted exceeds what campaigns spent plus what it
    /// paid out in withdrawals. The contract cannot check this (withdrawals
    /// are paid off chain on purpose); the ledger must.
    function invariant_postedNeverExceedsWhatWasTaken() public view {
        assertLe(handler.ghostPosted(), pool.totalDrawSpent() + handler.ghostWithdrawn(), "posted spend exceeds draw spend plus withdrawals");
    }

    /// Per campaign: spent plus in-flight never exceeds the draw, the draw
    /// never exceeds its cap.
    function invariant_drawsStayInsideTheirCaps() public view {
        uint256 n = pool.campaignCount();
        for (uint256 i = 0; i < n; i++) {
            FleetPool.Draw memory d = pool.drawOf(pool.campaignAt(i));
            assertLe(d.amount, pool.DRAW_CAP(), "draw above cap");
            assertLe(d.spent + d.reserved, d.amount, "draw overspent");
        }
    }

    /// The published caps hold for every depositor and for the pool.
    function invariant_depositCapsHold() public view {
        assertLe(pool.totalDeposited(), pool.POOL_CAP(), "pool over cap");
        for (uint256 i = 0; i < handler.traderCount(); i++) {
            (uint256 deposited,,,) = pool.depositorOf(handler.traders(i));
            assertLe(deposited, pool.DEPOSITOR_CAP(), "depositor over cap");
        }
    }

    /// The operator can never claim more than the gas it fronted.
    function invariant_claimableIsGasOnly() public view {
        uint256 owed = pool.totalOutflow() + pool.totalClaimed();
        uint256 expected = pool.totalDrawSpent() > owed ? pool.totalDrawSpent() - owed : 0;
        assertEq(pool.claimable(), expected, "claimable drifted");
        assertLe(pool.totalClaimed(), handler.ghostGasFronted(), "claimed more gas than fronted");
    }
}

/// Plays the traders and an honest operator. Every operator action is one the
/// service could take today; the ghost variables are the operator's ledger.
contract Handler is Test {
    FleetPool public immutable pool;

    address[] public traders;
    bytes32[] internal campaigns;
    mapping(bytes32 => address) internal campaignOwner;
    mapping(bytes32 => uint256) internal campaignAccountsFunded;
    mapping(address => uint256) internal drawnAgainst; // open draw amounts per trader

    uint256 public ghostDeposited;
    uint256 public ghostRolledBack;
    uint256 public ghostExitsPaid;
    uint256 public ghostPosted;
    uint256 public ghostWithdrawn;
    uint256 public ghostGasFronted;

    uint256[] internal sizes;

    constructor() {
        pool = new FleetPool(address(this));
        sizes.push(0.01 ether);
        sizes.push(0.05 ether);
        sizes.push(0.1 ether);
        for (uint160 i = 1; i <= 4; i++) {
            address t = address(uint160(0xA000) + i);
            traders.push(t);
            vm.deal(t, 100 ether);
        }
        vm.deal(address(this), 100 ether);
        vm.warp(1_700_000_000);
    }

    receive() external payable {}

    function traderCount() external view returns (uint256) {
        return traders.length;
    }

    // --- views the invariants need -----------------------------------------

    function sumUnspent() external view returns (uint256 total) {
        for (uint256 i = 0; i < traders.length; i++) {
            (uint256 deposited, uint256 spent,,) = pool.depositorOf(traders[i]);
            total += deposited > spent ? deposited - spent : 0;
        }
    }

    function openPrincipal() external view returns (uint256 total) {
        for (uint256 i = 0; i < campaigns.length; i++) {
            total += pool.drawOf(campaigns[i]).principalOut;
        }
    }

    // --- trader actions -------------------------------------------------------

    function deposit(uint256 who, uint256 size) external {
        address t = traders[who % traders.length];
        uint256 value = sizes[size % sizes.length];
        (uint256 deposited,, uint64 exitAt,) = pool.depositorOf(t);
        // The honest app refuses a deposit while an exit is pending (F1).
        if (exitAt != 0) return;
        if (deposited + value > pool.DEPOSITOR_CAP() || pool.totalDeposited() + value > pool.POOL_CAP() || pool.paused()) return;
        vm.prank(t);
        pool.deposit{value: value}();
        ghostDeposited += value;
    }

    function requestExit(uint256 who) external {
        address t = traders[who % traders.length];
        (uint256 deposited,,,) = pool.depositorOf(t);
        if (deposited == 0) return;
        // An honest service stops drawing for a trader who is leaving; its
        // open draws are closed first so nothing is in flight.
        for (uint256 i = 0; i < campaigns.length; i++) {
            if (campaignOwner[campaigns[i]] != t) continue;
            FleetPool.Draw memory d = pool.drawOf(campaigns[i]);
            if ((d.state == FleetPool.DrawState.Pending || d.state == FleetPool.DrawState.Funded) && d.reserved == 0) {
                pool.closeDraw(campaigns[i]);
                drawnAgainst[t] -= d.amount;
            }
        }
        vm.prank(t);
        pool.requestExit();
    }

    function executeExit(uint256 who, uint256 wait) external {
        address t = traders[who % traders.length];
        (uint256 deposited, uint256 spent, uint64 exitAt, uint256 exitAmount) = pool.depositorOf(t);
        if (exitAt == 0) return;
        vm.warp(block.timestamp + bound(wait, 24 hours, 48 hours));
        uint256 unspent = deposited > spent ? deposited - spent : 0;
        uint256 payout = exitAmount < unspent ? exitAmount : unspent;
        vm.prank(t);
        pool.executeExit();
        ghostExitsPaid += payout;
    }

    // --- operator actions, honest ---------------------------------------------

    /// A withdrawal is paid by the operator's wallet, never by the pool, and
    /// then charged to the depositor like any other spend.
    function withdraw(uint256 who, uint256 amount) external {
        address t = traders[who % traders.length];
        (uint256 deposited, uint256 spent, uint64 exitAt,) = pool.depositorOf(t);
        if (exitAt != 0) return;
        uint256 unspent = deposited > spent ? deposited - spent : 0;
        if (unspent <= drawnAgainst[t]) return;
        uint256 a = bound(amount, 1, unspent - drawnAgainst[t]);
        address destination = address(uint160(uint256(keccak256(abi.encode("payout", t, ghostWithdrawn)))));
        (bool ok, ) = destination.call{value: a}("");
        require(ok, "payout failed");
        ghostWithdrawn += a;
        _charge(t, a);
    }

    function openDraw(uint256 who, uint256 amount, uint256 delay) external {
        address t = traders[who % traders.length];
        (uint256 deposited, uint256 spent, uint64 exitAt,) = pool.depositorOf(t);
        if (exitAt != 0 || pool.paused()) return;
        uint256 unspent = deposited > spent ? deposited - spent : 0;
        if (unspent <= drawnAgainst[t]) return;
        uint256 room = unspent - drawnAgainst[t];
        uint256 cap = room < pool.DRAW_CAP() ? room : pool.DRAW_CAP();
        uint256 a = bound(amount, 1, cap);
        bytes32 c = keccak256(abi.encode(t, campaigns.length));
        pool.openDraw(c, a, uint64(block.timestamp + bound(delay, 60, 15 minutes)), "");
        campaigns.push(c);
        campaignOwner[c] = t;
        drawnAgainst[t] += a;
    }

    function fund(uint256 which, uint256 n) external {
        if (campaigns.length == 0) return;
        bytes32 c = campaigns[which % campaigns.length];
        FleetPool.Draw memory d = pool.drawOf(c);
        if (d.state != FleetPool.DrawState.Pending) return;
        uint256 count = bound(n, 1, 5);
        if (d.spent + pool.GAS_HEADROOM() * count > d.amount) return;
        vm.warp(d.dueAt > block.timestamp ? d.dueAt : block.timestamp);
        address[] memory accounts = new address[](count);
        for (uint256 i = 0; i < count; i++) accounts[i] = address(uint160(uint256(c)) + uint160(i));
        pool.fund(c, accounts);
        campaignAccountsFunded[c] = count;
        _charge(campaignOwner[c], pool.GAS_HEADROOM() * count);
    }

    /// One buy: principal out, then either commit at principal + gas or roll
    /// back. Gas is fronted by the operator and comes back through claim.
    function buy(uint256 which, uint256 principal, uint256 gas, bool fails) external {
        if (campaigns.length == 0) return;
        bytes32 c = campaigns[which % campaigns.length];
        FleetPool.Draw memory d = pool.drawOf(c);
        if (d.state != FleetPool.DrawState.Funded || d.reserved != 0 || pool.paused()) return;
        uint256 room = d.amount - d.spent;
        if (room < 2) return;
        uint256 gasCeiling = bound(gas, 1, room / 2);
        uint256 p = bound(principal, 1, room - gasCeiling);
        address account = address(uint160(uint256(c)));
        pool.fundPrincipal(c, account, p, gasCeiling);
        if (fails) {
            // The account keeps the principal (F3); the operator makes the pool whole.
            pool.rollback{value: p}(c, p);
            ghostRolledBack += p;
            return;
        }
        uint256 actual = p + gasCeiling;
        pool.commit(c, actual);
        ghostGasFronted += gasCeiling;
        _charge(campaignOwner[c], actual);
    }

    function closeDraw(uint256 which) external {
        if (campaigns.length == 0) return;
        bytes32 c = campaigns[which % campaigns.length];
        FleetPool.Draw memory d = pool.drawOf(c);
        if (d.state == FleetPool.DrawState.Closed || d.state == FleetPool.DrawState.None || d.reserved != 0) return;
        pool.closeDraw(c);
        drawnAgainst[campaignOwner[c]] -= d.amount;
    }

    function claim(uint256 amount) external {
        uint256 c = pool.claimable();
        if (c == 0) return;
        pool.claimOperator(bound(amount, 1, c));
    }

    function pause(bool on) external {
        pool.setPaused(on);
    }

    /// The honest operator queues each charge to the trader it belongs to and
    /// posts it inside the window; the ledger is this mapping.
    function _charge(address t, uint256 amount) internal {
        uint64 due = uint64(block.timestamp + 60);
        bytes[] memory refs = new bytes[](1);
        uint256[] memory amounts = new uint256[](1);
        uint64[] memory dues = new uint64[](1);
        amounts[0] = amount;
        dues[0] = due;
        uint256 id = pool.queueSpendBatch(refs, amounts, dues)[0];
        vm.warp(due);
        pool.postQueued(id, t);
        ghostPosted += amount;
    }
}
