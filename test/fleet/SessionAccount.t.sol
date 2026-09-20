// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionAccount} from "../../contracts/fleet/SessionAccount.sol";
import {SessionAccountFactory} from "../../contracts/fleet/SessionAccountFactory.sol";
import {FleetTestSink} from "../../contracts/fleet/FleetTestSink.sol";
import {FleetSponsorProbe} from "../../contracts/fleet/FleetSponsorProbe.sol";
import {FleetVenueToken} from "../../contracts/fleet/FleetVenueToken.sol";

/// A Permit2 that only remembers: etched over the real address for the sell
/// tests, since the flag's whole promise is which (token, spender) pairs the
/// account ever approved there.
contract RecordingPermit2 {
    mapping(address owner => mapping(address token => mapping(address spender => uint160))) public amount;
    mapping(address owner => mapping(address token => mapping(address spender => uint48))) public expiration;

    function approve(address token, address spender, uint160 amount_, uint48 expiration_) external {
        amount[msg.sender][token][spender] = amount_;
        expiration[msg.sender][token][spender] = expiration_;
    }
}

/// The session account's promise, one test per clause: a key does only what
/// the owner said, to whom, for how much, until when; pause holds it, revoke
/// ends it; the owner is never gated and always gets the money back; a bot
/// cannot widen its own session or reach the owner's paths. Runs with
/// `npx hardhat test solidity`.
contract SessionAccountTest is Test {
    SessionAccount internal account;
    SessionAccountFactory internal factory;
    FleetTestSink internal sink;
    FleetSponsorProbe internal probe;

    address internal constant OWNER = address(0x0A11);
    address internal constant BOT = address(0xB07);
    address internal constant STRANGER = address(0x5717);

    FleetVenueToken internal token;
    RecordingPermit2 internal permit2;

    function setUp() public {
        factory = new SessionAccountFactory();
        account = factory.createAccount(OWNER, bytes32("one"));
        sink = new FleetTestSink();
        probe = new FleetSponsorProbe();
        token = new FleetVenueToken(1_000_000 ether);
        vm.etch(account.PERMIT2(), address(new RecordingPermit2()).code);
        permit2 = RecordingPermit2(account.PERMIT2());
        vm.deal(OWNER, 10 ether);
        vm.deal(BOT, 1 ether);
        vm.deal(STRANGER, 1 ether);
        vm.warp(1_700_000_000);
        vm.prank(OWNER);
        (bool ok, ) = address(account).call{value: 1 ether}("");
        assertTrue(ok);
    }

    function _buyRule() internal view returns (SessionAccount.Rule[] memory rules) {
        rules = new SessionAccount.Rule[](1);
        rules[0] = SessionAccount.Rule({target: address(sink), selector: FleetTestSink.buy.selector});
    }

    function _grantBuy(uint128 perCall, uint128 cap, uint48 expiry) internal {
        vm.prank(OWNER);
        account.grant(BOT, _buyRule(), perCall, cap, expiry);
    }

    // --- the factory ---------------------------------------------------------

    function test_factory_predicts_and_is_idempotent() public {
        address predicted = factory.accountOf(OWNER, bytes32("two"));
        assertEq(predicted.code.length, 0);
        SessionAccount created = factory.createAccount(OWNER, bytes32("two"));
        assertEq(address(created), predicted);
        assertEq(created.owner(), OWNER);
        SessionAccount again = factory.createAccount(OWNER, bytes32("two"));
        assertEq(address(again), predicted, "a retry returns the same account");
    }

    // --- the key does what it was told ---------------------------------------

    function test_key_executes_within_its_session() public {
        _grantBuy(0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        vm.prank(BOT);
        account.execute(address(sink), 0.1 ether, abi.encodeCall(FleetTestSink.buy, ()));
        assertEq(sink.bought(address(account)), 0.1 ether, "the account bought, not the bot");
        (, , , , , , uint128 spent, uint32 calls) = account.sessionOf(BOT);
        assertEq(spent, 0.1 ether);
        assertEq(calls, 1);
        assertEq(address(account).balance, 0.9 ether);
    }

    function test_key_refused_outside_its_rules() public {
        _grantBuy(0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        // another contract
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.RuleNotAllowed.selector);
        account.execute(address(probe), 0, abi.encodeCall(FleetSponsorProbe.ping, (bytes32(0))));
        // the right contract, another function
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.RuleNotAllowed.selector);
        account.execute(address(sink), 0, abi.encodeWithSignature("totalBought()"));
        // no calldata at all: a plain transfer is not a rule
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.EmptyCallData.selector);
        account.execute(STRANGER, 0.1 ether, "");
        assertEq(address(account).balance, 1 ether, "nothing left");
    }

    function test_key_refused_over_value_ceilings() public {
        _grantBuy(0.1 ether, 0.25 ether, uint48(block.timestamp + 1 days));
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.ValueOverCall.selector);
        account.execute(address(sink), 0.1 ether + 1, abi.encodeCall(FleetTestSink.buy, ()));
        // two calls fit the cap, the third does not
        for (uint256 i = 0; i < 2; ++i) {
            vm.prank(BOT);
            account.execute(address(sink), 0.1 ether, abi.encodeCall(FleetTestSink.buy, ()));
        }
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.ValueOverCap.selector);
        account.execute(address(sink), 0.1 ether, abi.encodeCall(FleetTestSink.buy, ()));
        // but a smaller one still does
        vm.prank(BOT);
        account.execute(address(sink), 0.05 ether, abi.encodeCall(FleetTestSink.buy, ()));
        assertEq(sink.bought(address(account)), 0.25 ether, "exactly the cap, never more");
    }

    function test_key_refused_after_expiry() public {
        _grantBuy(0.1 ether, 0.3 ether, uint48(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 1 hours);
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.SessionExpired.selector);
        account.execute(address(sink), 0.1 ether, abi.encodeCall(FleetTestSink.buy, ()));
    }

    function test_pause_holds_resume_releases() public {
        _grantBuy(0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        vm.prank(OWNER);
        account.pause(BOT);
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.SessionPausedError.selector);
        account.execute(address(sink), 0.1 ether, abi.encodeCall(FleetTestSink.buy, ()));
        vm.prank(OWNER);
        account.resume(BOT);
        vm.prank(BOT);
        account.execute(address(sink), 0.1 ether, abi.encodeCall(FleetTestSink.buy, ()));
        assertEq(sink.bought(address(account)), 0.1 ether);
    }

    function test_revoke_is_terminal() public {
        _grantBuy(0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        vm.prank(OWNER);
        account.revoke(BOT);
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.SessionRevokedError.selector);
        account.execute(address(sink), 0.1 ether, abi.encodeCall(FleetTestSink.buy, ()));
        // no resume, no re-grant for that key
        vm.prank(OWNER);
        vm.expectRevert(SessionAccount.SessionRevokedError.selector);
        account.resume(BOT);
        vm.prank(OWNER);
        vm.expectRevert(SessionAccount.SessionExists.selector);
        account.grant(BOT, _buyRule(), 0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        (bool can, string memory why) = account.canExecute(BOT, address(sink), FleetTestSink.buy.selector, 0.1 ether);
        assertFalse(can);
        assertEq(why, "revoked");
    }

    function test_strangers_and_bots_cannot_touch_the_owner_paths() public {
        _grantBuy(0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        vm.prank(STRANGER);
        vm.expectRevert(SessionAccount.NotAuthorized.selector);
        account.execute(address(sink), 0.1 ether, abi.encodeCall(FleetTestSink.buy, ()));
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.NotOwner.selector);
        account.withdraw(payable(BOT), 1 ether);
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.NotOwner.selector);
        account.grant(STRANGER, _buyRule(), 1 ether, 1 ether, uint48(block.timestamp + 1 days));
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.NotOwner.selector);
        account.revoke(BOT);
        // a bot cannot widen its session by calling the account itself: the account is not in its rules
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.RuleNotAllowed.selector);
        account.execute(address(account), 0, abi.encodeCall(SessionAccount.resume, (BOT)));
    }

    function test_owner_is_never_gated_and_gets_the_money_back() public {
        vm.prank(OWNER);
        account.execute(address(probe), 0, abi.encodeCall(FleetSponsorProbe.ping, (bytes32("hi"))));
        assertEq(probe.pings(address(account)), 1);
        vm.prank(OWNER);
        account.withdraw(payable(OWNER), 0.4 ether);
        assertEq(address(account).balance, 0.6 ether);
        assertEq(OWNER.balance, 9.4 ether);
    }

    function test_grant_validates() public {
        SessionAccount.Rule[] memory none = new SessionAccount.Rule[](0);
        vm.startPrank(OWNER);
        vm.expectRevert(SessionAccount.NoRules.selector);
        account.grant(BOT, none, 1, 1, uint48(block.timestamp + 1));
        vm.expectRevert(SessionAccount.BadExpiry.selector);
        account.grant(BOT, _buyRule(), 1, 1, uint48(block.timestamp));
        vm.expectRevert(SessionAccount.ValueOverCap.selector);
        account.grant(BOT, _buyRule(), 2, 1, uint48(block.timestamp + 1));
        vm.expectRevert(SessionAccount.ZeroKey.selector);
        account.grant(OWNER, _buyRule(), 1, 1, uint48(block.timestamp + 1));
        SessionAccount.Rule[] memory zero = new SessionAccount.Rule[](1);
        zero[0] = SessionAccount.Rule({target: address(0), selector: bytes4(0)});
        vm.expectRevert(SessionAccount.ZeroTarget.selector);
        account.grant(BOT, zero, 1, 1, uint48(block.timestamp + 1));
        vm.stopPrank();
    }

    function test_wildcard_selector_allows_any_function_of_that_target() public {
        SessionAccount.Rule[] memory rules = new SessionAccount.Rule[](1);
        rules[0] = SessionAccount.Rule({target: address(probe), selector: bytes4(0)});
        vm.prank(OWNER);
        account.grant(BOT, rules, 0, 0, uint48(block.timestamp + 1 days));
        vm.prank(BOT);
        account.execute(address(probe), 0, abi.encodeCall(FleetSponsorProbe.ping, (bytes32("x"))));
        assertEq(probe.pings(address(account)), 1);
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.ValueOverCall.selector);
        account.execute(address(probe), 1, abi.encodeCall(FleetSponsorProbe.ping, (bytes32("x"))));
    }

    function test_a_reverting_target_reverts_and_spends_nothing() public {
        _grantBuy(0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.CallFailed.selector);
        account.execute(address(sink), 0, abi.encodeCall(FleetTestSink.buy, ())); // the sink refuses zero value
        (, , , , , , uint128 spent, uint32 calls) = account.sessionOf(BOT);
        assertEq(spent, 0);
        assertEq(calls, 0);
    }

    // --- selling: one flag, not one rule per token ---------------------------

    function test_owner_toggles_sell_flag() public {
        _grantBuy(0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        assertFalse(account.sellAllowed(BOT), "off until the owner says");
        vm.prank(OWNER);
        vm.expectEmit(true, false, false, true);
        emit SessionAccount.SellAllowed(BOT, true);
        account.setSellAllowed(BOT, true);
        assertTrue(account.sellAllowed(BOT));
        vm.prank(OWNER);
        account.setSellAllowed(BOT, false);
        assertFalse(account.sellAllowed(BOT));
        // only the owner, only for a session that exists
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.NotOwner.selector);
        account.setSellAllowed(BOT, true);
        vm.prank(OWNER);
        vm.expectRevert(SessionAccount.SessionUnknown.selector);
        account.setSellAllowed(STRANGER, true);
    }

    function test_key_without_the_flag_cannot_approve_for_sell() public {
        _grantBuy(0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.SellNotAllowed.selector);
        account.approveForSell(address(token), address(sink));
        assertEq(token.allowance(address(account), account.PERMIT2()), 0);
        // a stranger has no session at all
        vm.prank(STRANGER);
        vm.expectRevert(SessionAccount.NotAuthorized.selector);
        account.approveForSell(address(token), address(sink));
    }

    function test_key_with_the_flag_approves_permit2_and_the_spender() public {
        _grantBuy(0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        vm.prank(OWNER);
        account.setSellAllowed(BOT, true);
        vm.prank(BOT);
        vm.expectEmit(true, true, true, true);
        emit SessionAccount.SellApproved(BOT, address(token), address(sink));
        account.approveForSell(address(token), address(sink));
        assertEq(token.allowance(address(account), account.PERMIT2()), type(uint256).max, "the token lets Permit2 pull");
        assertEq(permit2.amount(address(account), address(token), address(sink)), type(uint160).max, "Permit2 lets the spender pull");
        assertEq(permit2.expiration(address(account), address(token), address(sink)), type(uint48).max);
        // approving is not spending: the caps are untouched
        (, , , , , , uint128 spent, uint32 calls) = account.sessionOf(BOT);
        assertEq(spent, 0);
        assertEq(calls, 0);
        // and the flag never lets the key move the token itself
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.RuleNotAllowed.selector);
        account.execute(address(token), 0, abi.encodeCall(FleetVenueToken.transfer, (BOT, 1)));
    }

    function test_spender_outside_the_rules_is_refused() public {
        _grantBuy(0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        vm.prank(OWNER);
        account.setSellAllowed(BOT, true);
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.SpenderNotAllowed.selector);
        account.approveForSell(address(token), address(probe));
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.SpenderNotAllowed.selector);
        account.approveForSell(address(token), BOT);
        assertEq(token.allowance(address(account), account.PERMIT2()), 0, "nothing approved");
    }

    function test_paused_revoked_or_expired_key_cannot_approve_for_sell() public {
        _grantBuy(0.1 ether, 0.3 ether, uint48(block.timestamp + 1 hours));
        vm.prank(OWNER);
        account.setSellAllowed(BOT, true);
        vm.prank(OWNER);
        account.pause(BOT);
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.SessionPausedError.selector);
        account.approveForSell(address(token), address(sink));
        vm.prank(OWNER);
        account.resume(BOT);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.SessionExpired.selector);
        account.approveForSell(address(token), address(sink));
        vm.warp(block.timestamp - 1 hours);
        vm.prank(OWNER);
        account.revoke(BOT);
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.SessionRevokedError.selector);
        account.approveForSell(address(token), address(sink));
        // revoke also ends the owner's ability to flag that key again
        vm.prank(OWNER);
        vm.expectRevert(SessionAccount.SessionRevokedError.selector);
        account.setSellAllowed(BOT, true);
    }

    /// Fuzz: whatever the ceilings, spend never passes the cap and never a call passes the per-call limit.
    function testFuzz_spend_never_exceeds_caps(uint128 perCall, uint128 cap, uint8 n) public {
        perCall = uint128(bound(perCall, 1, 0.1 ether));
        cap = uint128(bound(cap, perCall, 1 ether));
        _grantBuy(perCall, cap, uint48(block.timestamp + 1 days));
        uint256 spent;
        for (uint256 i = 0; i < n; ++i) {
            uint256 value = perCall;
            vm.prank(BOT);
            if (spent + value > cap) {
                vm.expectRevert(SessionAccount.ValueOverCap.selector);
                account.execute(address(sink), value, abi.encodeCall(FleetTestSink.buy, ()));
            } else {
                account.execute(address(sink), value, abi.encodeCall(FleetTestSink.buy, ()));
                spent += value;
            }
        }
        assertLe(spent, cap);
        assertEq(sink.bought(address(account)), spent);
    }
}
