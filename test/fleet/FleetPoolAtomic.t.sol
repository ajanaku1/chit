// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FleetPool} from "../../contracts/fleet/FleetPool.sol";
import {FleetAccount} from "../../contracts/fleet/FleetAccountFactory.sol";
import {FleetSessionPolicy} from "../../contracts/fleet/FleetSessionPolicy.sol";
import {FleetTestSink} from "../../contracts/fleet/FleetTestSink.sol";

/// The atomic buy, which answers F3 and A22: the pool funds the principal and
/// runs the buy in one transaction, so a buy that reverts leaves no principal
/// anywhere, the owner's escape hatch has no gap to act in, and there is no
/// rollback for the operator to pay.
contract FleetPoolAtomicTest is Test {
    FleetPool internal pool;
    FleetSessionPolicy internal policy;
    FleetTestSink internal sink;
    FleetAccount[] internal fleet;

    address internal constant OPERATOR = address(0x0e0e);
    address internal constant OWNER = address(0x0111);
    address internal constant ALICE = address(0xA11CE);
    bytes32 internal constant CAMPAIGN = keccak256("atomic-1");

    function setUp() public {
        vm.deal(ALICE, 1 ether);
        vm.deal(OPERATOR, 1 ether);
        vm.warp(1_700_000_000);
        vm.txGasPrice(1 gwei);

        pool = new FleetPool(OPERATOR, OPERATOR);
        policy = new FleetSessionPolicy(OPERATOR, OPERATOR);
        sink = new FleetTestSink();

        vm.startPrank(OPERATOR);
        policy.setPool(address(pool));
        address[] memory accounts = new address[](5);
        for (uint256 i = 0; i < 5; i++) {
            FleetAccount a = new FleetAccount(OWNER, OPERATOR, policy, CAMPAIGN);
            fleet.push(a);
        }
        // strictly increasing addresses, as openSession requires
        for (uint256 i = 0; i < 5; i++) accounts[i] = address(fleet[i]);
        _sort(accounts);
        policy.openSession(
            CAMPAIGN,
            FleetSessionPolicy.Session({
                chainId: block.chainid, router: address(sink), selector: FleetTestSink.buy.selector,
                maxTradeValue: 0.01 ether, perAccountGas: 0.001 ether, totalGas: 0.01 ether,
                expiry: uint64(block.timestamp + 1 days), spentGas: 0, paused: false, revoked: false, exists: false
            }),
            accounts
        );
        vm.stopPrank();

        vm.prank(ALICE);
        pool.deposit{value: 0.1 ether}();
        vm.startPrank(OPERATOR);
        pool.openDraw(CAMPAIGN, 0.05 ether, uint64(block.timestamp + 60), "");
        vm.warp(block.timestamp + 60);
        pool.fund(CAMPAIGN, accounts);
        vm.stopPrank();
    }

    function _sort(address[] memory a) internal pure {
        for (uint256 i = 0; i < a.length; i++) {
            for (uint256 j = i + 1; j < a.length; j++) {
                if (a[j] < a[i]) { address t = a[i]; a[i] = a[j]; a[j] = t; }
            }
        }
    }

    function test_atomicBuyLandsAndChargesPrincipalPlusMeasuredGas() public {
        FleetAccount account = fleet[0];
        uint256 poolBefore = address(pool).balance;
        uint256 spentBefore = pool.drawOf(CAMPAIGN).spent;

        vm.prank(OPERATOR);
        pool.fundAndExecute(CAMPAIGN, address(account), 0.005 ether, 0.001 ether, address(sink), abi.encodeCall(FleetTestSink.buy, ()));

        assertEq(sink.bought(address(account)), 0.005 ether, "the venue received the principal");
        assertEq(poolBefore - address(pool).balance, 0.005 ether, "the pool paid exactly the principal");
        FleetPool.Draw memory draw = pool.drawOf(CAMPAIGN);
        uint256 charged = draw.spent - spentBefore;
        assertGt(charged, 0.005 ether, "charged the principal and some gas");
        assertLe(charged, 0.005 ether + 0.001 ether, "never above the ceiling");
        assertEq(draw.reserved, 0, "nothing in flight afterwards");
    }

    /// A buy of zero is what the sink refuses; the whole transaction reverts,
    /// the pool keeps its ETH, the account holds only its headroom, and the
    /// operator paid gas and nothing else.
    function test_atomicBuyThatRevertsMovesNoPrincipal() public {
        FleetAccount account = fleet[1];
        uint256 poolBefore = address(pool).balance;
        uint256 accountBefore = address(account).balance;
        uint256 spentBefore = pool.drawOf(CAMPAIGN).spent;

        vm.prank(OPERATOR);
        vm.expectRevert(FleetAccount.CallFailed.selector);
        pool.fundAndExecute(CAMPAIGN, address(account), 0, 0.001 ether, address(sink), abi.encodeCall(FleetTestSink.buy, ()));

        assertEq(address(pool).balance, poolBefore, "no principal left the pool");
        assertEq(address(account).balance, accountBefore, "the account gained nothing");
        assertEq(pool.drawOf(CAMPAIGN).spent, spentBefore, "the draw was charged nothing");
        assertEq(pool.drawOf(CAMPAIGN).reserved, 0, "and there is no reservation to roll back");
    }

    /// The owner cannot pull the principal mid-buy: there is no mid-buy.
    /// Whatever the owner does before or after is on their own balance.
    function test_ownerHasNoGapBetweenFundingAndExecution() public {
        FleetAccount account = fleet[2];
        vm.prank(OWNER);
        account.withdrawEth(OWNER, address(account).balance); // takes the headroom, which is theirs
        assertEq(address(account).balance, 0);

        vm.prank(OPERATOR);
        pool.fundAndExecute(CAMPAIGN, address(account), 0.004 ether, 0.001 ether, address(sink), abi.encodeCall(FleetTestSink.buy, ()));
        assertEq(sink.bought(address(account)), 0.004 ether, "the principal went to the venue, not to the owner");
        assertEq(address(account).balance, 0, "and none of it stayed behind");
    }

    function test_onlyThePolicyNamedPoolMayExecute() public {
        FleetPool stranger = new FleetPool(OPERATOR, OPERATOR);
        vm.prank(address(stranger));
        vm.expectRevert(FleetAccount.NotOperator.selector);
        fleet[3].execute(address(sink), 0, abi.encodeCall(FleetTestSink.buy, ()));
    }

    function test_atomicBuyRespectsPauseAndTheDraw() public {
        vm.startPrank(OPERATOR);
        pool.setPaused(true);
        vm.expectRevert(FleetPool.Paused.selector);
        pool.fundAndExecute(CAMPAIGN, address(fleet[0]), 0.001 ether, 0.001 ether, address(sink), abi.encodeCall(FleetTestSink.buy, ()));
        pool.setPaused(false);
        vm.expectRevert(FleetPool.DrawExceeded.selector);
        pool.fundAndExecute(CAMPAIGN, address(fleet[0]), 0.05 ether, 0.001 ether, address(sink), abi.encodeCall(FleetTestSink.buy, ()));
        vm.stopPrank();
    }
}
