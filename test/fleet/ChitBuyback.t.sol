// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChitBuyback} from "../../contracts/chit/ChitBuyback.sol";

/// What ChitBuyback promises without a pool: the constructor refuses
/// nonsense, the spend follows the balance between its floor and cap, the
/// interval holds, and ETH can arrive but never leave. The buy itself is
/// exercised against the live pool on a mainnet fork
/// (test/fork/chit-buyback.test.ts). Runs with `npx hardhat test solidity`.
contract ChitBuybackTest is Test {
    address internal constant TOKEN = address(0xC417);
    address internal constant ROUTER = address(0x8876);
    address internal constant MANAGER = address(0x8366);
    address internal constant HOOK = address(0xE5e7);

    function make(uint16 spendBps, uint256 minSpend, uint256 maxSpend, uint32 interval, uint16 maxSlip) internal returns (ChitBuyback) {
        return new ChitBuyback(TOKEN, ROUTER, MANAGER, 0, 200, HOOK, spendBps, minSpend, maxSpend, interval, maxSlip);
    }

    function test_constructorRefusesNonsense() public {
        vm.expectRevert(ChitBuyback.BadParams.selector);
        new ChitBuyback(address(0), ROUTER, MANAGER, 0, 200, HOOK, 100, 1, 2, 60, 500);
        vm.expectRevert(ChitBuyback.BadParams.selector);
        make(0, 1, 2, 60, 500);
        vm.expectRevert(ChitBuyback.BadParams.selector);
        make(10_001, 1, 2, 60, 500);
        vm.expectRevert(ChitBuyback.BadParams.selector);
        make(100, 0, 2, 60, 500);
        vm.expectRevert(ChitBuyback.BadParams.selector);
        make(100, 3, 2, 60, 500);
        vm.expectRevert(ChitBuyback.BadParams.selector);
        make(100, 1, 2, 0, 500);
        vm.expectRevert(ChitBuyback.BadParams.selector);
        make(100, 1, 2, 60, 10_000);
    }

    function test_poolIdIsTheKeyHash() public {
        ChitBuyback b = make(100, 0.002 ether, 0.1 ether, 3600, 500);
        bytes32 expected = keccak256(abi.encode(address(0), TOKEN, uint24(0), int24(200), HOOK));
        assertEq(b.poolId(), expected);
    }

    function test_nextSpendFollowsTheBalanceBetweenFloorAndCap() public {
        ChitBuyback b = make(100, 0.002 ether, 0.1 ether, 3600, 500);
        assertEq(b.nextSpend(), 0, "empty spends nothing");
        vm.deal(address(b), 1 ether);
        assertEq(b.nextSpend(), 0.01 ether, "one percent");
        vm.deal(address(b), 0.003 ether);
        assertEq(b.nextSpend(), 0.002 ether, "under the floor, the floor");
        vm.deal(address(b), 0.001 ether);
        assertEq(b.nextSpend(), 0.001 ether, "less than the floor left, all of it");
        vm.deal(address(b), 50 ether);
        assertEq(b.nextSpend(), 0.1 ether, "the cap");
    }

    function testFuzz_nextSpendNeverExceedsBalanceOrCap(uint96 balance) public {
        ChitBuyback b = make(100, 0.002 ether, 0.1 ether, 3600, 500);
        vm.deal(address(b), balance);
        uint256 spend = b.nextSpend();
        assertLe(spend, balance);
        assertLe(spend, 0.1 ether);
        if (balance > 0) assertGt(spend, 0);
        if (balance >= 0.002 ether) assertGe(spend, 0.002 ether);
    }

    function test_fundingCountsAndEmits() public {
        ChitBuyback b = make(100, 0.002 ether, 0.1 ether, 3600, 500);
        vm.deal(address(this), 3 ether);
        vm.expectEmit(true, false, false, true);
        emit ChitBuyback.Funded(address(this), 1 ether, 1 ether);
        (bool ok,) = address(b).call{value: 1 ether}("");
        assertTrue(ok);
        b.fund{value: 2 ether}();
        assertEq(b.totalReceived(), 3 ether);
        assertEq(address(b).balance, 3 ether);
    }

    function test_nothingTakesEthOut() public {
        ChitBuyback b = make(100, 0.002 ether, 0.1 ether, 3600, 500);
        vm.deal(address(b), 1 ether);
        (bool ok,) = address(b).call(abi.encodeWithSignature("withdraw(uint256)", 1 ether));
        assertFalse(ok, "no withdraw");
        (ok,) = address(b).call(abi.encodeWithSignature("transfer(address,uint256)", address(this), 1 ether));
        assertFalse(ok, "no transfer");
        assertEq(address(b).balance, 1 ether);
    }

    function test_intervalHoldsBeforeAnyPoolRead() public {
        ChitBuyback b = make(100, 0.002 ether, 0.1 ether, 3600, 500);
        vm.deal(address(b), 1 ether);
        vm.warp(1_700_000_000);
        // No pool here: the first call gets past the clock and fails on the manager; the clock is what this checks.
        vm.expectRevert();
        b.buyAndBurn();
        assertEq(b.lastBuyAt(), 0, "a failed buy leaves the clock alone");
    }

    receive() external payable {}
}
