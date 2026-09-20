// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionAccount} from "../../contracts/fleet/SessionAccount.sol";
import {SessionAccountFactory} from "../../contracts/fleet/SessionAccountFactory.sol";
import {FleetTestSink} from "../../contracts/fleet/FleetTestSink.sol";
import {FleetSponsorProbe} from "../../contracts/fleet/FleetSponsorProbe.sol";
import {FleetVenueToken} from "../../contracts/fleet/FleetVenueToken.sol";
import {PoolKey} from "../../contracts/fleet/FleetPoolSeeder.sol";

/// A Permit2 that keeps allowances the way the real one does, as far as a
/// sale needs: `approve` records amount and expiry per (owner, token,
/// spender); `transferFrom` moves the token for a spender within its
/// allowance and before its expiry, and refuses otherwise. Etched over the
/// real address, since the flag's whole promise is that no allowance the
/// account makes there outlives the sale.
contract RecordingPermit2 {
    struct Allowance {
        uint160 amount;
        uint48 expiration;
    }

    mapping(address owner => mapping(address token => mapping(address spender => Allowance))) public allowance;

    error AllowanceExpired();
    error InsufficientAllowance();

    /// A zero expiry is stored as this block, as the real Permit2 does.
    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        allowance[msg.sender][token][spender] = Allowance(amount, expiration == 0 ? uint48(block.timestamp) : expiration);
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        Allowance storage a = allowance[from][token][msg.sender];
        if (block.timestamp > a.expiration) revert AllowanceExpired();
        if (a.amount < amount) revert InsufficientAllowance();
        if (a.amount != type(uint160).max) a.amount -= amount;
        FleetVenueToken(token).transferFrom(from, to, amount);
    }
}

/// A router that sells the way the Universal Router does, minus the pool: it
/// reads the calldata the account wrote, pulls the input through Permit2
/// from its caller and pays ETH at a fixed rate to its caller, or, when a
/// test turns it hostile, to somebody else, or for more than the input. It
/// keeps the calldata and the allowance it saw mid-call for the assertions.
contract SwapRouterDouble {
    RecordingPermit2 internal immutable permit2;
    /// Tokens per ETH; the fork's venue price.
    uint256 public tokensPerEth = 1000;
    /// Zero pays the caller, as the real router does; anything else is the hostile case.
    address public payTo;
    /// Pulled on top of the input, to prove the allowance is the input and no more.
    uint256 public pullExtra;
    bytes public lastCalldata;
    uint160 public seenAllowance;
    uint48 public seenExpiry;

    error PayFailed();

    constructor(RecordingPermit2 permit2_) {
        permit2 = permit2_;
    }

    function setTokensPerEth(uint256 n) external { tokensPerEth = n; }
    function setPayTo(address to) external { payTo = to; }
    function setPullExtra(uint256 extra) external { pullExtra = extra; }

    function execute(bytes calldata, bytes[] calldata inputs, uint256) external payable {
        lastCalldata = msg.data;
        (, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        (address token, uint256 amountIn) = abi.decode(params[1], (address, uint256));
        (seenAllowance, seenExpiry) = permit2.allowance(msg.sender, token, address(this));
        permit2.transferFrom(msg.sender, address(this), uint160(amountIn + pullExtra), token);
        address to = payTo == address(0) ? msg.sender : payTo;
        (bool ok, ) = to.call{value: amountIn / tokensPerEth}("");
        if (!ok) revert PayFailed();
    }

    receive() external payable {}
}

/// The session account's promise, one test per clause: a key does only what
/// the owner said, to whom, for how much, until when; pause holds it, revoke
/// ends it; the owner is never gated and always gets the money back; a bot
/// cannot widen its own session or reach the owner's paths; a sale moves its
/// amount out and its ETH in, into the account, and leaves nothing behind.
/// Runs with `npx hardhat test solidity`.
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
    SwapRouterDouble internal router;

    function setUp() public {
        factory = new SessionAccountFactory();
        account = factory.createAccount(OWNER, bytes32("one"));
        sink = new FleetTestSink();
        probe = new FleetSponsorProbe();
        token = new FleetVenueToken(1_000_000 ether);
        vm.etch(account.PERMIT2(), address(new RecordingPermit2()).code);
        permit2 = RecordingPermit2(account.PERMIT2());
        router = new SwapRouterDouble(permit2);
        vm.deal(address(router), 10 ether);
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

    /// The bot's real rule: the router's `execute`, and nothing else.
    function _routerRule() internal view returns (SessionAccount.Rule[] memory rules) {
        rules = new SessionAccount.Rule[](1);
        rules[0] = SessionAccount.Rule({target: address(router), selector: SwapRouterDouble.execute.selector});
    }

    /// A key on the router with the sell flag, and 1000 tokens in the account to sell.
    function _grantSeller(address key) internal {
        vm.prank(OWNER);
        account.grant(key, _routerRule(), 0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        vm.prank(OWNER);
        account.setSellAllowed(key, true);
        token.transfer(address(account), 1000 ether);
    }

    function _pool() internal view returns (PoolKey memory) {
        return PoolKey({currency0: address(0), currency1: address(token), fee: 3000, tickSpacing: 60, hooks: address(0)});
    }

    function _sell(address key, uint128 amountIn, uint128 minOut) internal {
        vm.prank(key);
        account.sell(address(router), _pool(), amountIn, minOut, block.timestamp + 3600);
    }

    function _assertNothingApproved() internal view {
        assertEq(token.allowance(address(account), account.PERMIT2()), 0, "the token lets Permit2 pull nothing");
        (uint160 amount, uint48 expiration) = permit2.allowance(address(account), address(token), address(router));
        assertEq(amount, 0, "Permit2 lets the router pull nothing");
        assertLe(expiration, block.timestamp, "and nothing past this block");
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

    function test_key_without_the_flag_cannot_sell() public {
        vm.prank(OWNER);
        account.grant(BOT, _routerRule(), 0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        token.transfer(address(account), 1000 ether);
        (bool can, string memory why) = account.canSell(BOT, address(router));
        assertFalse(can);
        assertEq(why, "sell not allowed");
        vm.expectRevert(SessionAccount.SellNotAllowed.selector);
        _sell(BOT, 400 ether, 0.3 ether);
        // a stranger has no session, and no flag either way
        vm.expectRevert(SessionAccount.SellNotAllowed.selector);
        _sell(STRANGER, 400 ether, 0.3 ether);
        assertEq(token.balanceOf(address(account)), 1000 ether, "nothing left");
        _assertNothingApproved();
    }

    function test_key_with_the_flag_sells_into_the_account() public {
        _grantSeller(BOT);
        (bool can, string memory why) = account.canSell(BOT, address(router));
        assertTrue(can, why);
        vm.expectEmit(true, true, true, true);
        emit SessionAccount.Sold(BOT, address(token), address(router), 400 ether, 0.4 ether);
        _sell(BOT, 400 ether, 0.3 ether);
        assertEq(token.balanceOf(address(account)), 600 ether, "the amount sold left, and only that");
        assertEq(address(account).balance, 1.4 ether, "the ETH landed in the account");
        assertEq(BOT.balance, 1 ether, "the bot got none of it");
        assertEq(token.balanceOf(BOT), 0);
        // a sale is a call inside the session but spends none of the caps
        (, , , , , , uint128 spent, uint32 calls) = account.sessionOf(BOT);
        assertEq(spent, 0);
        assertEq(calls, 1);
    }

    function test_a_sale_approves_only_its_amount_for_this_block_and_clears_it() public {
        _grantSeller(BOT);
        _sell(BOT, 400 ether, 0.3 ether);
        assertEq(router.seenAllowance(), 400 ether, "mid-call, Permit2 let the router pull the input and no more");
        assertEq(router.seenExpiry(), uint48(block.timestamp), "and only in this block");
        _assertNothingApproved();
    }

    function test_the_account_writes_the_sale_calldata_itself() public {
        _grantSeller(BOT);
        _sell(BOT, 400 ether, 0.3 ether);
        bytes memory data = router.lastCalldata();
        assertEq(bytes4(data), SwapRouterDouble.execute.selector);
        bytes memory args = new bytes(data.length - 4);
        for (uint256 i = 0; i < args.length; ++i) args[i] = data[i + 4];
        (bytes memory commands, bytes[] memory inputs, uint256 deadline) = abi.decode(args, (bytes, bytes[], uint256));
        assertEq(commands, hex"10", "one V4_SWAP command");
        assertEq(inputs.length, 1);
        assertEq(deadline, block.timestamp + 3600);
        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        assertEq(actions, hex"060c0f", "SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL: the router pays its caller");
        assertEq(params.length, 3);
        SessionAccount.ExactInputSingleParams memory swap = abi.decode(params[0], (SessionAccount.ExactInputSingleParams));
        assertEq(swap.poolKey.currency0, address(0));
        assertEq(swap.poolKey.currency1, address(token));
        assertEq(swap.poolKey.fee, 3000);
        assertEq(swap.poolKey.tickSpacing, 60);
        assertEq(swap.poolKey.hooks, address(0));
        assertFalse(swap.zeroForOne, "token in, ETH out");
        assertEq(swap.amountIn, 400 ether);
        assertEq(swap.amountOutMinimum, 0.3 ether);
        assertEq(swap.hookData.length, 0);
        (address settleCurrency, uint256 settleAmount) = abi.decode(params[1], (address, uint256));
        assertEq(settleCurrency, address(token));
        assertEq(settleAmount, 400 ether);
        (address takeCurrency, uint256 takeMin) = abi.decode(params[2], (address, uint256));
        assertEq(takeCurrency, address(0));
        assertEq(takeMin, 0.3 ether);
    }

    function test_a_sale_paid_elsewhere_is_refused() public {
        _grantSeller(BOT);
        router.setPayTo(BOT);
        vm.expectRevert(SessionAccount.ProceedsShort.selector);
        _sell(BOT, 400 ether, 0.3 ether);
        assertEq(token.balanceOf(address(account)), 1000 ether, "the whole sale unwound");
        assertEq(BOT.balance, 1 ether);
        _assertNothingApproved();
    }

    function test_a_sale_under_its_floor_is_refused() public {
        _grantSeller(BOT);
        router.setTokensPerEth(2000);
        vm.expectRevert(SessionAccount.ProceedsShort.selector);
        _sell(BOT, 400 ether, 0.3 ether);
        assertEq(token.balanceOf(address(account)), 1000 ether);
        assertEq(address(account).balance, 1 ether);
    }

    function test_a_sale_cannot_take_more_than_its_amount() public {
        _grantSeller(BOT);
        router.setPullExtra(1);
        vm.expectRevert(SessionAccount.CallFailed.selector);
        _sell(BOT, 400 ether, 0.3 ether);
        assertEq(token.balanceOf(address(account)), 1000 ether);
        _assertNothingApproved();
    }

    function test_nothing_of_a_sale_outlives_it_for_any_key() public {
        _grantSeller(BOT);
        address other = address(0x0B0B);
        vm.prank(OWNER);
        account.grant(other, _routerRule(), 0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        _sell(BOT, 400 ether, 0.3 ether);
        bytes memory raw = router.lastCalldata();
        // the same calldata through a plain execute finds no allowance: not for another key on the router
        vm.prank(other);
        vm.expectRevert(SessionAccount.CallFailed.selector);
        account.execute(address(router), 0, raw);
        // and not for the flagged key itself
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.CallFailed.selector);
        account.execute(address(router), 0, raw);
        // the other key has no flag, so `sell` is not its either
        vm.expectRevert(SessionAccount.SellNotAllowed.selector);
        _sell(other, 100 ether, 0.05 ether);
        // taking the flag back is complete: the key that sold cannot sell again
        vm.prank(OWNER);
        account.setSellAllowed(BOT, false);
        vm.expectRevert(SessionAccount.SellNotAllowed.selector);
        _sell(BOT, 100 ether, 0.05 ether);
        assertEq(token.balanceOf(address(account)), 600 ether, "only the one sale moved anything");
    }

    function test_a_sale_needs_the_router_in_the_rules_an_eth_pool_and_a_floor() public {
        // the flag on a key whose rules do not name the router
        _grantBuy(0.1 ether, 0.3 ether, uint48(block.timestamp + 1 days));
        vm.prank(OWNER);
        account.setSellAllowed(BOT, true);
        token.transfer(address(account), 1000 ether);
        (bool can, string memory why) = account.canSell(BOT, address(router));
        assertFalse(can);
        assertEq(why, "rule not allowed");
        vm.expectRevert(SessionAccount.RuleNotAllowed.selector);
        _sell(BOT, 400 ether, 0.3 ether);
        // the flag never lets the key move the token itself
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.RuleNotAllowed.selector);
        account.execute(address(token), 0, abi.encodeCall(FleetVenueToken.transfer, (BOT, 1)));
        // a pool that is not the token against ETH
        PoolKey memory wrong = PoolKey({currency0: address(token), currency1: address(sink), fee: 3000, tickSpacing: 60, hooks: address(0)});
        vm.prank(BOT);
        vm.expectRevert(SessionAccount.NotEthPool.selector);
        account.sell(address(router), wrong, 400 ether, 0.3 ether, block.timestamp + 3600);
        // no floor at all
        vm.expectRevert(SessionAccount.NoFloor.selector);
        _sell(BOT, 400 ether, 0);
        assertEq(token.balanceOf(address(account)), 1000 ether);
    }

    function test_paused_revoked_or_expired_key_cannot_sell() public {
        vm.prank(OWNER);
        account.grant(BOT, _routerRule(), 0.1 ether, 0.3 ether, uint48(block.timestamp + 1 hours));
        vm.prank(OWNER);
        account.setSellAllowed(BOT, true);
        token.transfer(address(account), 1000 ether);
        vm.prank(OWNER);
        account.pause(BOT);
        (bool can, string memory why) = account.canSell(BOT, address(router));
        assertFalse(can);
        assertEq(why, "paused");
        vm.expectRevert(SessionAccount.SessionPausedError.selector);
        _sell(BOT, 400 ether, 0.3 ether);
        vm.prank(OWNER);
        account.resume(BOT);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(SessionAccount.SessionExpired.selector);
        _sell(BOT, 400 ether, 0.3 ether);
        vm.warp(block.timestamp - 1 hours);
        vm.prank(OWNER);
        account.revoke(BOT);
        vm.expectRevert(SessionAccount.SessionRevokedError.selector);
        _sell(BOT, 400 ether, 0.3 ether);
        // revoke also ends the owner's ability to flag that key again
        vm.prank(OWNER);
        vm.expectRevert(SessionAccount.SessionRevokedError.selector);
        account.setSellAllowed(BOT, true);
        assertEq(token.balanceOf(address(account)), 1000 ether);
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
