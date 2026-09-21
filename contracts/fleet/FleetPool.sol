// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title Fleet private funding pool
/// @notice Stage 2 custody boundary. Traders deposit fixed sizes into one shared
///         pool that carries no campaign identifier; the operator funds each
///         fleet's gas headroom and, just in time, each buy's principal from a
///         campaign-keyed draw. Deposits and spend are keyed by depositor;
///         draws and funding are keyed by campaign; no function or event names
///         both, so no transaction publishes the link (FR-009).
/// @dev The depositor behind a draw or a queued spend travels as `ownerRef` /
///      `encDepositor`: a ciphertext only the operator's ledger key opens. This
///      contract cannot decrypt it, so it cannot check that a posting names the
///      right depositor; that is operator trust, disclosed in the product, and
///      auditable after the fact by anyone holding the ledger key.
interface IFleetAccount {
    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory);
}

/// @dev Two keys. The operator is hot: the service signs with it all day, and
///      it can move money and nothing else. The owner is the admin, cold and
///      two-step: it rotates the operator, unpauses, names the guardian and
///      claims gas. A leaked operator key is replaced; the pool is not.
contract FleetPool is Ownable2Step {
    enum DrawState {
        None,
        Pending,
        Funded,
        Closed
    }

    struct Depositor {
        uint256 deposited;
        uint256 spent;
        uint64 exitRequestedAt;
        uint256 exitAmount;
    }

    struct Draw {
        uint256 amount;
        uint256 spent;
        uint256 reserved;
        uint256 principalOut;
        uint64 dueAt;
        bytes ownerRef;
        DrawState state;
    }

    struct QueuedSpend {
        bytes encDepositor;
        uint256 amount;
        uint64 dueAt;
        uint64 queuedAt;
        bool posted;
    }

    /// @notice What one entry of a batch posting came to. A batch never reverts
    ///         for one entry that cannot post; it says so per entry instead.
    enum PostResult {
        Posted,
        Expired,
        AlreadyPosted
    }

    /// @notice The most entries one postQueuedBatch takes. Measured in
    ///         test/fleet/FleetPool.t.sol (test_aFullBatchFitsInHalfATransaction):
    ///         the RPC reports a nominal 2^50 block gas limit on both chains, and
    ///         the binding limit is Arbitrum's 32,000,000 per transaction; this
    ///         many entries stay inside half of it.
    uint256 public constant MAX_POST_BATCH = 256;

    /// @notice The hot key. Set by the admin; see `setOperator`.
    address public operator;

    /// @notice A second key that can stop the money and nothing else. The
    ///         operator key moves funds; if it is compromised, the pause is the
    ///         only brake, and a brake only the same key can pull is no brake.
    ///         The guardian may pause. Only the admin may unpause or change
    ///         the guardian. A monitor, a second person or a multisig can hold
    ///         it without ever being able to move a wei.
    address public guardian;

    /// @notice Deposits come in fixed sizes so one deposit looks like any other
    ///         of its size and cannot be matched to a fleet's spending.
    uint256 public constant SIZE_SMALL = 0.01 ether;
    uint256 public constant SIZE_MEDIUM = 0.05 ether;
    uint256 public constant SIZE_LARGE = 0.1 ether;

    /// @notice The caps are set at deployment and never change: a testnet
    ///         pool and a mainnet beta run the same code with different
    ///         numbers, and a bigger cap is a new pool, after an audit, not
    ///         a switch. The getters keep their old names.
    uint256 public immutable DEPOSITOR_CAP;
    uint256 public immutable DRAW_CAP;
    uint256 public immutable POOL_CAP;
    uint256 public constant GAS_HEADROOM = 0.0002 ether;

    /// @notice How long a trader waits to recover their deposit without Chit.
    uint64 public constant EXIT_DELAY = 24 hours;

    /// @notice Gas the outer transaction spends around the inner call, added to
    ///         what the inner call measured so the charge covers the whole
    ///         transaction and not only the buy. Capped by the ceiling either way.
    uint256 public constant EXECUTE_OVERHEAD_GAS = 90_000;

    bool private _executing;

    /// @notice The shortest wait between opening a draw and funding its fleet.
    ///         The wait is what stops a deposit and its fleet funding from
    ///         pairing by timing, so the floor lives here rather than in the
    ///         service that chooses the actual delay.
    uint64 public constant MIN_FUNDING_DELAY = 60;

    /// @notice How long the operator has to post a queued spend before it
    ///         expires unposted. Shorter than EXIT_DELAY on purpose: a trader
    ///         who waits out the exit can never be surprised by a stale charge,
    ///         so the exit needs no cooperation from a vanished operator.
    uint64 public constant POST_WINDOW = 12 hours;

    /// @notice Stops every path that moves ETH out or widens a claim on the
    ///         pool: deposits, draws, funding, principal, top-ups and the
    ///         operator's claim. Exits keep working, on purpose.
    bool public paused;
    uint256 public totalDeposited;
    uint256 public totalDrawSpent;
    uint256 public totalOutflow;
    uint256 public totalClaimed;
    /// @notice Charge posted to depositors, counting only the part of each
    ///         charge still backed by unspent deposit (FR-033); the excess
    ///         falls to the operator. What the operator may claim is measured
    ///         against this, so a claim never reaches what is still owed.
    uint256 public totalPosted;
    /// @notice The monitor's counters (FR-027): everything that ever came in
    ///         as a deposit, everything paid out in exits, everything donated.
    ///         With totalOutflow and totalClaimed they state the identity
    ///         balance == everDeposited + donated - totalOutflow - exitsPaid - totalClaimed,
    ///         from public views alone. Deposited and ExitPaid fire on each
    ///         change of the first two; Donated on the third.
    uint256 public everDeposited;
    uint256 public exitsPaid;
    uint256 public donated;

    mapping(address depositor => Depositor) private _depositors;
    mapping(bytes32 campaign => Draw) private _draws;
    bytes32[] private _campaigns;
    /// @dev Keyed by a hash, not a counter: a counter made the k-th posting the
    ///      k-th queueing, which was the k-th buy. The id list keeps enumeration
    ///      possible for the operator's sweep and for anyone auditing the queue.
    mapping(bytes32 id => QueuedSpend) private _queued;
    bytes32[] private _queueIds;

    event Deposited(address indexed depositor, uint256 amount);
    event ExitRequested(address indexed depositor, uint256 amount, uint64 availableAt);
    event ExitPaid(address indexed depositor, uint256 amount);
    event SpendQueued(bytes32 indexed id, uint256 amount, uint64 dueAt);
    event SpendPosted(address indexed depositor, uint256 amount);
    event OperatorClaimed(uint256 amount);
    event Donated(address indexed from, uint256 amount);
    event PausedSet(bool paused);
    event GuardianSet(address guardian);

    event DrawOpened(bytes32 indexed campaign, uint256 amount, uint64 dueAt);
    event DrawFunded(bytes32 indexed campaign, uint256 seeded);
    event PrincipalSent(bytes32 indexed campaign, address indexed account, uint256 principal);
    event Committed(bytes32 indexed campaign, uint256 amount);
    event RolledBack(bytes32 indexed campaign, uint256 amount);
    event DrawToppedUp(bytes32 indexed campaign, uint256 amount);
    event DrawClosed(bytes32 indexed campaign, uint256 unspent);

    error NotOperator();
    error Paused();
    error SizeNotAllowed();
    error DepositorCapExceeded();
    error PoolCapExceeded();
    error DrawCapExceeded();
    error DrawExists();
    error DrawNotPending();
    error DrawNotFunded();
    error DrawNotOpen();
    error DrawExceeded();
    error NotDue();
    error PostWindowClosed();
    error AlreadyPosted();
    error NothingReserved();
    error ReservationOpen();
    error CommitExceedsReservation();
    error PrincipalMismatch();
    error NothingDeposited();
    error ExitNotRequested();
    error ExitNotDue();
    error ClaimExceeded();
    error TransferFailed();
    error NoAccounts();
    error NotGuardian();
    error Reentered();
    error BadCaps();
    error DelayTooShort();
    error ExitPending();
    error CommitBelowPrincipal();
    error DueBeyondWindow();
    error EmptyBatch();
    error BatchTooLarge();
    error LengthMismatch();
    error UnknownSpend();
    error ZeroAddress();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    event OperatorSet(address operator);

    constructor(address admin_, address operator_, uint256 depositorCap_, uint256 drawCap_, uint256 poolCap_) Ownable(admin_) {
        if (operator_ == address(0)) revert ZeroAddress();
        // A depositor must be able to make at least one small deposit, a draw
        // must fit in the pool, and no single depositor may be the whole pool
        // (or the anonymity set is one).
        if (depositorCap_ < SIZE_SMALL || drawCap_ == 0 || drawCap_ > poolCap_ || depositorCap_ >= poolCap_) revert BadCaps();
        operator = operator_;
        DEPOSITOR_CAP = depositorCap_;
        DRAW_CAP = drawCap_;
        POOL_CAP = poolCap_;
    }

    /// @notice Replaces the hot key. Every money path is gated on the new one
    ///         from this block; nothing in flight is affected, because nothing
    ///         is ever in flight across blocks (the buy is one transaction).
    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    // --- trader side: nothing here names a campaign ------------------------

    /// @notice Deposits one published size into the pool. Nothing recorded here
    ///         ties the deposit to a fleet, now or later.
    function deposit() external payable {
        if (paused) revert Paused();
        if (msg.value != SIZE_SMALL && msg.value != SIZE_MEDIUM && msg.value != SIZE_LARGE) {
            revert SizeNotAllowed();
        }
        Depositor storage d = _depositors[msg.sender];
        // A deposit made after requestExit would be paid out as min(exitAmount,
        // unspent) and then deleted with the record: lost to the depositor and
        // owned by nobody. Leave first, then deposit again.
        if (d.exitRequestedAt != 0) revert ExitPending();
        if (d.deposited + msg.value > DEPOSITOR_CAP) revert DepositorCapExceeded();
        if (totalDeposited + msg.value > POOL_CAP) revert PoolCapExceeded();

        d.deposited += msg.value;
        totalDeposited += msg.value;
        everDeposited += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Gives ETH to the pool, crediting no depositor: how a pool that is
    ///         short is made whole (FR-036). Works while paused, because that
    ///         is when it is needed; a deposit does not, on purpose.
    function donate() external payable {
        if (msg.value == 0) revert SizeNotAllowed();
        donated += msg.value;
        emit Donated(msg.sender, msg.value);
    }

    /// @notice Starts the self-serve exit. Works whether or not Chit is running.
    function requestExit() external {
        Depositor storage d = _depositors[msg.sender];
        if (d.deposited == 0) revert NothingDeposited();
        uint64 requestedAt = uint64(block.timestamp);
        d.exitRequestedAt = requestedAt;
        d.exitAmount = _unspent(d);
        emit ExitRequested(msg.sender, d.exitAmount, requestedAt + EXIT_DELAY);
    }

    /// @notice Pays the exit after the delay. The amount is capped again at
    ///         execution time, so spend posted after the request still counts
    ///         and exiting is never a way to escape a bill.
    function executeExit() external {
        Depositor storage d = _depositors[msg.sender];
        if (d.exitRequestedAt == 0) revert ExitNotRequested();
        if (block.timestamp < d.exitRequestedAt + EXIT_DELAY) revert ExitNotDue();

        uint256 unspent = _unspent(d);
        uint256 payout = d.exitAmount < unspent ? d.exitAmount : unspent;
        totalDeposited -= d.deposited;
        delete _depositors[msg.sender];
        exitsPaid += payout;

        emit ExitPaid(msg.sender, payout);
        if (payout != 0) _send(msg.sender, payout);
    }

    // --- operator side, depositor-keyed ------------------------------------

    /// @notice Unpausing is the admin's: a compromised hot key that pauses
    ///         itself out of the guardian's reach cannot then resume.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice The brake. Callable by the guardian or the operator; releasing
    ///         it is the operator's alone, through setPaused(false).
    function pause() external {
        if (msg.sender != guardian && msg.sender != operator && msg.sender != owner()) revert NotGuardian();
        paused = true;
        emit PausedSet(true);
    }

    /// @notice Records a batch of spends, each to be charged to whoever its
    ///         `encDepositors[i]` names after its own `dueAts[i]`. One batch per
    ///         sweep, in a transaction that follows no buy: the operator's
    ///         next nonce after a campaign-keyed settlement used to be the
    ///         depositor-keyed charge for it, which was a join of its own.
    ///         Batching, with the entries shuffled and each on its own timer,
    ///         is what breaks it; the contract's part is to accept them in one
    ///         call and refuse the whole batch if any entry could never post.
    function queueSpendBatch(bytes[] calldata encDepositors, uint256[] calldata amounts, uint64[] calldata dueAts)
        external
        onlyOperator
        returns (bytes32[] memory ids)
    {
        uint256 n = encDepositors.length;
        if (n == 0) revert EmptyBatch();
        if (amounts.length != n || dueAts.length != n) revert LengthMismatch();
        ids = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            ids[i] = _queue(encDepositors[i], amounts[i], dueAts[i]);
        }
    }

    function _queue(bytes calldata encDepositor, uint256 amount, uint64 dueAt) private returns (bytes32 id) {
        // POST_WINDOW runs from now; a dueAt past it is a charge that can
        // never be posted, and a charge never posted is the pool's loss.
        if (dueAt > block.timestamp + POST_WINDOW) revert DueBeyondWindow();
        // The position mixes in so identical entries in one batch part ways;
        // prevrandao so the id is not computable from the entry alone.
        id = keccak256(abi.encode(encDepositor, amount, dueAt, block.prevrandao, _queueIds.length));
        _queueIds.push(id);
        _queued[id] = QueuedSpend({
            encDepositor: encDepositor,
            amount: amount,
            dueAt: dueAt,
            queuedAt: uint64(block.timestamp),
            posted: false
        });
        emit SpendQueued(id, amount, dueAt);
    }

    /// @notice Charges a queued spend to its depositor, inside its window.
    function postQueued(bytes32 id, address depositor) external onlyOperator {
        PostResult result = _post(id, depositor);
        if (result == PostResult.AlreadyPosted) revert AlreadyPosted();
        if (result == PostResult.Expired) revert PostWindowClosed();
    }

    /// @notice Charges many queued spends in one transaction. One entry that
    ///         cannot post never costs the others: each reports posted,
    ///         expired or already posted. An unknown id or one not yet due is
    ///         a caller's error and reverts as postQueued would.
    function postQueuedBatch(bytes32[] calldata ids, address[] calldata depositors)
        external
        onlyOperator
        returns (PostResult[] memory results)
    {
        uint256 n = ids.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_POST_BATCH) revert BatchTooLarge();
        if (depositors.length != n) revert LengthMismatch();
        results = new PostResult[](n);
        for (uint256 i = 0; i < n; ++i) {
            results[i] = _post(ids[i], depositors[i]);
        }
    }

    /// @dev Posts what the deposit still backs and no more (FR-033): the rest of
    ///      the charge is the operator's loss, never a depositor's debt, and
    ///      totalPosted grows by the same figure so the claim cannot reach it.
    function _post(bytes32 id, address depositor) private returns (PostResult) {
        QueuedSpend storage q = _queued[id];
        if (q.queuedAt == 0) revert UnknownSpend();
        if (q.posted) return PostResult.AlreadyPosted;
        if (block.timestamp < q.dueAt) revert NotDue();
        if (block.timestamp > q.queuedAt + POST_WINDOW) return PostResult.Expired;

        q.posted = true;
        Depositor storage d = _depositors[depositor];
        uint256 backed = _unspent(d);
        uint256 counted = q.amount > backed ? backed : q.amount;
        d.spent += counted;
        totalPosted += counted;
        emit SpendPosted(depositor, counted);
        return PostResult.Posted;
    }

    /// @notice Reimburses the operator for what it fronted, gas and withdrawals
    ///         alike, out of the pool's surplus and never more (FR-030). The
    ///         bound is pool-wide accounting only, so claiming publishes no
    ///         depositor.
    /// @dev Paid to the operator, which fronted it; claimed by the admin.
    function claimOperator(uint256 amount) external onlyOwner {
        if (paused) revert Paused();
        if (amount > claimable()) revert ClaimExceeded();
        totalClaimed += amount;
        emit OperatorClaimed(amount);
        _send(operator, amount);
    }

    // --- operator side, campaign-keyed -------------------------------------

    /// @notice Opens a campaign's claim on the pool. `dueAt` is when the fleet
    ///         may be funded; the wait is what breaks the timing link between a
    ///         deposit and a fleet.
    function openDraw(bytes32 campaign, uint256 amount, uint64 dueAt, bytes calldata ownerRef)
        external
        onlyOperator
    {
        if (paused) revert Paused();
        Draw storage draw = _draws[campaign];
        if (draw.state != DrawState.None) revert DrawExists();
        if (amount == 0 || amount > DRAW_CAP) revert DrawCapExceeded();
        if (dueAt < block.timestamp + MIN_FUNDING_DELAY) revert DelayTooShort();

        draw.amount = amount;
        draw.dueAt = dueAt;
        draw.ownerRef = ownerRef;
        draw.state = DrawState.Pending;
        _campaigns.push(campaign);
        emit DrawOpened(campaign, amount, dueAt);
    }

    /// @notice Seeds each fleet account with gas headroom once the wait is over.
    function fund(bytes32 campaign, address[] calldata accounts) external onlyOperator {
        if (paused) revert Paused();
        Draw storage draw = _draws[campaign];
        if (draw.state != DrawState.Pending) revert DrawNotPending();
        if (block.timestamp < draw.dueAt) revert NotDue();
        if (accounts.length == 0) revert NoAccounts();

        uint256 seeded = GAS_HEADROOM * accounts.length;
        if (draw.spent + seeded > draw.amount) revert DrawExceeded();

        draw.spent += seeded;
        draw.state = DrawState.Funded;
        totalDrawSpent += seeded;
        totalOutflow += seeded;

        emit DrawFunded(campaign, seeded);
        for (uint256 i = 0; i < accounts.length; ++i) {
            _send(accounts[i], GAS_HEADROOM);
        }
    }

    /// @notice Raises an open draw so a campaign that ran out can keep trading
    ///         without another deposit. The per-draw cap still binds.
    function topUpDraw(bytes32 campaign, uint256 amount) external onlyOperator {
        if (paused) revert Paused();
        Draw storage draw = _draws[campaign];
        if (draw.state != DrawState.Pending && draw.state != DrawState.Funded) revert DrawNotOpen();
        if (amount == 0 || draw.amount + amount > DRAW_CAP) revert DrawCapExceeded();

        draw.amount += amount;
        emit DrawToppedUp(campaign, draw.amount);
    }

    /// @notice Sends one buy's principal to one fleet account, immediately
    ///         before the operator executes that buy. Unspent draw never leaves.
    function fundPrincipal(bytes32 campaign, address account, uint256 principal, uint256 gasCeiling)
        external
        onlyOperator
    {
        if (paused) revert Paused();
        Draw storage draw = _draws[campaign];
        if (draw.state != DrawState.Funded) revert DrawNotFunded();
        if (draw.reserved != 0) revert ReservationOpen();
        if (draw.spent + principal + gasCeiling > draw.amount) revert DrawExceeded();

        draw.reserved = principal + gasCeiling;
        draw.principalOut = principal;
        totalOutflow += principal;

        emit PrincipalSent(campaign, account, principal);
        if (principal != 0) _send(account, principal);
    }

    /// @notice Funds one buy's principal and runs the buy, in one transaction.
    ///         The account is sent the principal and told to execute; if the
    ///         buy reverts, this whole call reverts and the principal never
    ///         left. The draw is charged the principal plus the gas measured
    ///         here, capped by the ceiling. No reservation, no rollback, and
    ///         nothing the account's owner can pull between the two steps,
    ///         because there are no two steps.
    /// @dev The account admits this contract through its policy's `pool`.
    function fundAndExecute(
        bytes32 campaign,
        address account,
        uint256 principal,
        uint256 gasCeiling,
        address target,
        bytes calldata data
    ) external onlyOperator returns (bytes memory result) {
        if (paused) revert Paused();
        if (_executing) revert Reentered();
        Draw storage draw = _draws[campaign];
        if (draw.state != DrawState.Funded) revert DrawNotFunded();
        if (draw.reserved != 0) revert ReservationOpen();
        if (draw.spent + principal + gasCeiling > draw.amount) revert DrawExceeded();

        _executing = true;
        uint256 gasBefore = gasleft();
        totalOutflow += principal;
        emit PrincipalSent(campaign, account, principal);
        if (principal != 0) _send(account, principal);
        result = IFleetAccount(account).execute(target, principal, data);

        uint256 gasCost = (gasBefore - gasleft() + EXECUTE_OVERHEAD_GAS) * tx.gasprice;
        uint256 actual = principal + (gasCost > gasCeiling ? gasCeiling : gasCost);
        draw.spent += actual;
        totalDrawSpent += actual;
        emit Committed(campaign, actual);
        _executing = false;
    }

    /// @notice Settles the in-flight buy at its real cost (principal plus gas).
    function commit(bytes32 campaign, uint256 actual) external onlyOperator {
        Draw storage draw = _draws[campaign];
        if (draw.reserved == 0) revert NothingReserved();
        if (actual > draw.reserved) revert CommitExceedsReservation();
        // The principal has already left. Charging less than it would leave
        // the difference in a fleet account, uncharged and invisible to every
        // view; the service never does this, and now the contract never lets it.
        if (actual < draw.principalOut) revert CommitBelowPrincipal();

        draw.spent += actual;
        draw.reserved = 0;
        draw.principalOut = 0;
        totalDrawSpent += actual;
        emit Committed(campaign, actual);
    }

    /// @notice Undoes an in-flight buy: the principal comes back and the draw is
    ///         charged nothing, so a failed buy costs the trader nothing.
    function rollback(bytes32 campaign, uint256 principalReturned) external payable onlyOperator {
        Draw storage draw = _draws[campaign];
        if (draw.reserved == 0) revert NothingReserved();
        if (principalReturned != draw.principalOut || msg.value != principalReturned) revert PrincipalMismatch();

        draw.reserved = 0;
        draw.principalOut = 0;
        totalOutflow -= principalReturned;
        emit RolledBack(campaign, principalReturned);
    }

    /// @notice Ends a campaign's claim. The unspent part was never moved, so
    ///         closing transfers nothing and publishes nothing.
    function closeDraw(bytes32 campaign) external onlyOperator {
        Draw storage draw = _draws[campaign];
        if (draw.state != DrawState.Pending && draw.state != DrawState.Funded) revert DrawNotOpen();
        if (draw.reserved != 0) revert ReservationOpen();

        draw.state = DrawState.Closed;
        emit DrawClosed(campaign, draw.amount - draw.spent);
    }

    // --- views --------------------------------------------------------------

    function depositorOf(address depositor)
        external
        view
        returns (uint256 deposited, uint256 spent, uint64 exitRequestedAt, uint256 exitAmount)
    {
        Depositor storage d = _depositors[depositor];
        return (d.deposited, d.spent, d.exitRequestedAt, d.exitAmount);
    }

    function drawOf(bytes32 campaign) external view returns (Draw memory) {
        return _draws[campaign];
    }

    /// @notice What this address may still deposit, and what the pool may still
    ///         take, so the app can refuse an over-cap deposit before it is sent.
    function headroom(address depositor) external view returns (uint256 perDepositor, uint256 perPool) {
        uint256 held = _depositors[depositor].deposited;
        perDepositor = held >= DEPOSITOR_CAP ? 0 : DEPOSITOR_CAP - held;
        perPool = totalDeposited >= POOL_CAP ? 0 : POOL_CAP - totalDeposited;
    }

    /// @notice The pool's surplus over what it owes depositors: charge posted
    ///         against deposits, less what already left the pool as principal
    ///         and headroom, less what was claimed. It covers fronted gas and
    ///         fronted withdrawals alike, and a full claim leaves every unspent
    ///         deposit in the pool (test/fleet/FleetPoolInvariants.t.sol).
    function claimable() public view returns (uint256) {
        uint256 owed = totalOutflow + totalClaimed;
        return totalPosted > owed ? totalPosted - owed : 0;
    }

    function campaignCount() external view returns (uint256) {
        return _campaigns.length;
    }

    function campaignAt(uint256 index) external view returns (bytes32) {
        return _campaigns[index];
    }

    function queuedSpendCount() external view returns (uint256) {
        return _queueIds.length;
    }

    function queuedSpendAt(uint256 index) external view returns (bytes32 id, QueuedSpend memory entry) {
        id = _queueIds[index];
        entry = _queued[id];
    }

    // --- internals ----------------------------------------------------------

    function _unspent(Depositor storage d) private view returns (uint256) {
        return d.deposited > d.spent ? d.deposited - d.spent : 0;
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
