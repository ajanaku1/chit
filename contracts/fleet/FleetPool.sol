// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

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
contract FleetPool {
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

    address public immutable operator;

    /// @notice Deposits come in fixed sizes so one deposit looks like any other
    ///         of its size and cannot be matched to a fleet's spending.
    uint256 public constant SIZE_SMALL = 0.01 ether;
    uint256 public constant SIZE_MEDIUM = 0.05 ether;
    uint256 public constant SIZE_LARGE = 0.1 ether;

    uint256 public constant DEPOSITOR_CAP = 0.5 ether;
    uint256 public constant DRAW_CAP = 0.2 ether;
    uint256 public constant POOL_CAP = 5 ether;
    uint256 public constant GAS_HEADROOM = 0.0002 ether;

    /// @notice How long a trader waits to recover their deposit without Chit.
    uint64 public constant EXIT_DELAY = 24 hours;

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

    mapping(address depositor => Depositor) private _depositors;
    mapping(bytes32 campaign => Draw) private _draws;
    bytes32[] private _campaigns;
    QueuedSpend[] private _queued;

    event Deposited(address indexed depositor, uint256 amount);
    event ExitRequested(address indexed depositor, uint256 amount, uint64 availableAt);
    event ExitPaid(address indexed depositor, uint256 amount);
    event SpendQueued(uint256 indexed id, uint256 amount, uint64 dueAt);
    event SpendPosted(address indexed depositor, uint256 amount);
    event OperatorClaimed(uint256 amount);
    event PausedSet(bool paused);

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
    error DelayTooShort();
    error ExitPending();
    error CommitBelowPrincipal();
    error DueBeyondWindow();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address operator_) {
        operator = operator_;
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
        emit Deposited(msg.sender, msg.value);
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

        emit ExitPaid(msg.sender, payout);
        if (payout != 0) _send(msg.sender, payout);
    }

    // --- operator side, depositor-keyed ------------------------------------

    function setPaused(bool paused_) external onlyOperator {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Records a spend to be charged to whoever `encDepositor` names,
    ///         after `dueAt`. Queuing and posting are separate so the charge
    ///         does not land in the same moment as the campaign-keyed
    ///         settlement that caused it.
    function queueSpend(bytes calldata encDepositor, uint256 amount, uint64 dueAt)
        external
        onlyOperator
        returns (uint256 id)
    {
        // POST_WINDOW runs from now; a dueAt past it is a charge that can
        // never be posted, and a charge never posted is the pool's loss.
        if (dueAt > block.timestamp + POST_WINDOW) revert DueBeyondWindow();
        id = _queued.length;
        _queued.push(
            QueuedSpend({
                encDepositor: encDepositor,
                amount: amount,
                dueAt: dueAt,
                queuedAt: uint64(block.timestamp),
                posted: false
            })
        );
        emit SpendQueued(id, amount, dueAt);
    }

    /// @notice Charges a queued spend to its depositor, inside its window.
    function postQueued(uint256 id, address depositor) external onlyOperator {
        QueuedSpend storage q = _queued[id];
        if (q.posted) revert AlreadyPosted();
        if (block.timestamp < q.dueAt) revert NotDue();
        if (block.timestamp > q.queuedAt + POST_WINDOW) revert PostWindowClosed();

        q.posted = true;
        _depositors[depositor].spent += q.amount;
        emit SpendPosted(depositor, q.amount);
    }

    /// @notice Reimburses the operator for gas it fronted, and never more. The
    ///         bound is campaign-side accounting only, so claiming publishes no
    ///         depositor.
    function claimOperator(uint256 amount) external onlyOperator {
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

    /// @notice Gas the operator has fronted and not yet reclaimed. Principal and
    ///         headroom already left the pool, so only the difference is owed.
    function claimable() public view returns (uint256) {
        uint256 owed = totalOutflow + totalClaimed;
        return totalDrawSpent > owed ? totalDrawSpent - owed : 0;
    }

    function campaignCount() external view returns (uint256) {
        return _campaigns.length;
    }

    function campaignAt(uint256 index) external view returns (bytes32) {
        return _campaigns[index];
    }

    function queuedSpendCount() external view returns (uint256) {
        return _queued.length;
    }

    function queuedSpendAt(uint256 index) external view returns (QueuedSpend memory) {
        return _queued[index];
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
