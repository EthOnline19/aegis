// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BulwarkTypes} from "./BulwarkTypes.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";
import {IBlocklist} from "./interfaces/IBlocklist.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IGuardAccount} from "./interfaces/IGuardAccount.sol";

/// @title BULWARK GuardAccount — the protected wallet.
/// @notice A smart account that classifies every proposed transfer into one
///          of three lanes:
///            ROUTINE   — within policy → executes instantly (99% of life).
///            ELEVATED  — near-limit / new recipient / unusual → hold window:
///                        funds lock, the TEE watcher judges, the owner can
///                        always release or freeze. "The attack never settles."
///            VIOLATION — breaks policy outright → reverts before broadcast.
///          BULWARK is never custodian: the owner keeps full control via
///          kill-switch, key rotation, manual release, and withdrawal.
contract GuardAccount is IGuardAccount {
    // ----------------------------------------------------------------- //
    //                              Events                               //
    // ----------------------------------------------------------------- //

    /// @dev Lane classification outcome for every proposed transfer.
    event Classified(uint8 tier, address indexed to, uint96 amount, bytes4 tag);

    /// @dev A transfer entered the hold window (funds locked).
    event Held(uint256 indexed holdId, address indexed to, uint96 amount, uint64 releaseAt);

    /// @dev A held transfer was released as clean by the TEE verdict.
    event Released(uint256 indexed holdId, address indexed to, uint96 amount);

    /// @dev Owner decision on a frozen hold: approve / freeze / freeze+rotate.
    event OwnerDecision(uint256 indexed holdId, uint8 decision, address actor);

    /// @dev Owner withdrew funds (any token) — custody is never locked.
    event Withdrawn(address indexed token, address indexed to, uint96 amount);
    /// @dev A routine transfer executed.
    event ExecutedRoutine(address indexed to, uint96 amount);

    /// @dev Hard policy violation — blocked before broadcast.
    event ViolationBlocked(bytes4 indexed tag, address indexed to, uint96 amount);

    /// @dev Spending authority revoked (freeze+rotate / kill-switch).
    event AuthorityRevoked(address actor);

    /// @dev The agent key was rotated.
    event AgentKeyRotated(address indexed newAgentKey);

    /// @dev Hold window elapsed with no verdict and no owner action:
    ///      fail-safe → extend (60 min), then auto-freeze.
    event HoldLapsed(uint256 indexed holdId, uint64 extendedTo);

    /// @dev Attempted-breach signal for the pricing engine (near-misses matter).
    event AttemptedBreach(uint256 indexed holdId, bytes32 evidence, bytes4 tag);

    /// @dev The watcher authority was wired.
    event VerdictContractSet(address indexed previous, address indexed next);
    /// @dev Native gas or tokens received.
    event Received(address indexed from, uint256 value);

    // ----------------------------------------------------------------- //
    //                              Errors                               //
    // ----------------------------------------------------------------- //

    error NotOwner();
    error NotAgent();
    error NotWatcher();
    error AuthorityRevokedErr();
    error ZeroAddress();
    error ZeroAmount();
    error Violation(bytes4 tag);
    error HoldNotPending();
    error HoldNotExpired();
    error HoldExpired();
    error NothingToWithdraw();
    error HoldNotFrozen();
    error UnsupportedToken();
    error TransferFailed();
    error NoHoldWindow();
    error InsufficientBalance();

    // ----------------------------------------------------------------- //
    //                       Lanes & decisions                           //
    // ----------------------------------------------------------------- //

    /// @dev Three-lane classification (BulwarkTypes.Tier values as uint8).
    uint8 public constant TIER_ROUTINE = 0;
    uint8 public constant TIER_ELEVATED = 1;
    uint8 public constant TIER_VIOLATION = 2;

    /// @dev Owner decisions on frozen holds (Case 3: approve/freeze/freeze+rotate).
    enum Decision {
        APPROVE,
        FREEZE,
        FREEZE_ROTATE
    }

    /// @dev Hold lifecycle.
    uint8 public constant HOLD_PENDING = 0;
    uint8 public constant HOLD_RELEASED = 1; // verdict clean → executed
    uint8 public constant HOLD_FROZEN = 2; // suspicious or lapsed → owner decides
    uint8 public constant HOLD_EXECUTED_OWNER = 3; // owner approved manually
    uint8 public constant HOLD_CANCELLED = 4; // owner froze → funds returned to spendable

    // ----------------------------------------------------------------- //
    //                            Storage                                //
    // ----------------------------------------------------------------- //

    /// @dev The immutable owner — the human whose money this is. Never BULWARK.
    address public immutable OWNER;

    /// @dev The agent key: may propose transfers. Rotatable by owner.
    address public agentKey;

    /// @dev The VerdictContract (watcher authority for hold release/freeze).
    address public verdictContract;

    /// @dev PolicyRegistry: seatbelt rules + insurance terms.
    IPolicyRegistry public immutable REGISTRY;

    /// @dev Shared blocklist — shared memory of attackers.
    IBlocklist public immutable BLOCKLIST;

    /// @dev USDC — unit of account.
    IERC20 public immutable USDC;

    /// @dev Spending authority. Fail-safe: once revoked, only owner paths remain.
    bool public authorityRevoked;

    // Daily enforcement counters (UTC-day keyed).
    uint256 private _day;
    uint96 private _dailySpent;
    uint256 private _dailyCount;

    // ----------------------------------------------------------------- //
    //                         Hold window                               //
    // ----------------------------------------------------------------- //

    struct Hold {
        address to; // destination
        uint96 amount; // locked amount (USDC units)
        uint64 releaseAt; // timestamp when fail-safe handling begins
        uint64 createdAt; // timestamp when held
        uint64 extendedTo; // lapsed-extend target (0 = not extended)
        uint8 status; // HOLD_* constant
    }

    mapping(uint256 => Hold) public holds;
    uint256 public nextHoldId = 1;

    /// @dev Running total of USDC locked in PENDING holds. O(1) accounting
    ///      replaces the old O(n) scan over every hold id ever created —
    ///      the scan was a gas-griefing DoS on spendableUsdc()/withdraw()
    ///      (review C2). Maintained at every status transition below.
    uint256 private _totalLocked;

    /// @dev After a hold lapses without verdict/owner action: extend 60 min,
    ///      then auto-freeze. "Fail-safe, not fail-fast."
    uint64 public constant HOLD_EXTEND_SEC = 3600;

    // ----------------------------------------------------------------- //
    //                          Constructor                              //
    // ----------------------------------------------------------------- //

    constructor(
        address owner_,
        address agentKey_,
        address registry_,
        address blocklist_,
        address usdc_
    ) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (registry_ == address(0)) revert ZeroAddress();
        if (blocklist_ == address(0)) revert ZeroAddress();
        if (usdc_ == address(0)) revert ZeroAddress();

        OWNER = owner_;
        // A zero agentKey means "owner is the agent" (simple setups) —
        // normalize once so the lint sees a checked assignment.
        address agentKeyNormalized = agentKey_ == address(0) ? owner_ : agentKey_;
        agentKey = agentKeyNormalized;
        REGISTRY = IPolicyRegistry(registry_);
        BLOCKLIST = IBlocklist(blocklist_);
        USDC = IERC20(usdc_);

        _resetDaily();
    }

    // ----------------------------------------------------------------- //
    //                          Receive hook                             //
    // ----------------------------------------------------------------- //

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    // ----------------------------------------------------------------- //
    //                          Wiring (owner)                           //
    // ----------------------------------------------------------------- //

    /// @notice Wire the VerdictContract after deployment (watcher authority).
    function setVerdictContract(address vc) external {
        if (msg.sender != OWNER) revert NotOwner();
        if (vc == address(0)) revert ZeroAddress();
        address previous = verdictContract;
        verdictContract = vc;
        emit VerdictContractSet(previous, vc);
    }

    // ----------------------------------------------------------------- //
    //                   Classification (agent entrypoint)               //
    // ----------------------------------------------------------------- //

    /// @notice The agent proposes a USDC transfer. Routine executes instantly;
    ///         elevated locks funds in a hold; violation reverts before broadcast.
    /// @return holdId 0 for the routine lane, else the new hold's id.
    function propose(address token, address to, uint96 amount) external returns (uint256) {
        if (authorityRevoked) revert AuthorityRevokedErr();
        if (msg.sender != agentKey) revert NotAgent();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (token != address(USDC)) revert UnsupportedToken();

        BulwarkTypes.Policy memory p = REGISTRY.getPolicy(address(this));
        if (p.holdWindowSec == 0) revert NoHoldWindow();

        (uint8 tier, bytes4 tag) = _classify(p, to, amount);

        emit Classified(tier, to, amount, tag);

        if (tier == TIER_VIOLATION) {
            emit ViolationBlocked(tag, to, amount);
            // The agent's attempt is logged as an attempted breach (pricing signal).
            emit AttemptedBreach(0, bytes32(uint256(uint32(tag))), tag);
            revert Violation(tag);
        }

        if (tier == TIER_ROUTINE) {
            _spendDaily(p, amount);
            emit ExecutedRoutine(to, amount);
            _transferUsdc(to, amount);
            return 0;
        }

        // Elevated lane: the hold must be backed by spendable balance —
        // holds are IOUs against funds actually in the account. Without
        // this check the agent key could lock unbacked IOUs until
        // spendableUsdc() underflows and withdraw() reverts (review C2).
        if (uint256(amount) > _spendableUsdc()) revert InsufficientBalance();

        return _createHold(p, to, amount);
    }

    /// @notice Persist the fact of a blocked VIOLATION-lane attempt (pricing
    ///         signal for the telematics engine; subgraph-indexed).
    /// @dev  propose() reverts on violations, so its events never persist.
    ///      This non-reverting path is the on-chain record: anyone may relay
    ///      the attempt (observed from the reverted call), and the counter
    ///      + event survive. Unpermissioned by design — the attempt is a
    ///      public fact from the reverted transaction; spam only inflates
    ///      the counter, which pricing treats as a signal, not a fault.
    function reportAttempt(address to, uint96 amount, bytes4 tag) external {
        _attemptedBreaches += 1;
        emit AttemptedBreach(0, bytes32(uint256(uint32(tag))), tag);
        emit Classified(TIER_VIOLATION, to, amount, tag);
    }

    /// @dev Total blocked attempts, monotonic. Feeds the pricing flywheel
    ///      (+15% load for 30 days after an attempted breach).
    uint256 public _attemptedBreaches;

    /// @dev Attempted-breach counter view (idiomatic accessor).
    function attemptedBreaches() external view returns (uint256) {
        return _attemptedBreaches;
    }

    // ----------------------------------------------------------------- //
    //                        Verdict path (TEE)                         //
    // ----------------------------------------------------------------- //

    /// @notice Watcher verdict on a pending hold: clean → release and execute.
    /// @dev  Only the VerdictContract (verifying TEE signatures off-chain) may call.
    function releaseHold(uint256 holdId) external {
        if (msg.sender != verdictContract) revert NotWatcher();
        Hold storage h = holds[holdId];
        if (h.status != HOLD_PENDING) revert HoldNotPending();
        if (block.timestamp > h.releaseAt + HOLD_EXTEND_SEC) revert HoldExpired();

        BulwarkTypes.Policy memory p = REGISTRY.getPolicy(address(this));
        _spendDaily(p, h.amount);
        h.status = HOLD_RELEASED;
        _totalLocked -= h.amount;
        emit Released(holdId, h.to, h.amount);
        _transferUsdc(h.to, h.amount);
    }

    /// @notice Watcher verdict: suspicious → freeze pending owner decision.
    function freezeHold(uint256 holdId) external {
        if (msg.sender != verdictContract) revert NotWatcher();
        Hold storage h = holds[holdId];
        if (h.status != HOLD_PENDING) revert HoldNotPending();
        h.status = HOLD_FROZEN;
        _totalLocked -= h.amount;
        emit OwnerDecision(holdId, 0xFF, msg.sender); // 0xFF = watcher-frozen sentinel
    }

    // ----------------------------------------------------------------- //
    //                        Owner decisions                            //
    // ----------------------------------------------------------------- //

    /// @notice The owner resolves a frozen hold (Approve / Freeze / Freeze+rotate).
    function decide(uint256 holdId, Decision decision) external {
        if (msg.sender != OWNER) revert NotOwner();
        Hold storage h = holds[holdId];

        if (h.status == HOLD_PENDING) {
            // Owner may short-circuit any pending hold (custody is never locked).
            if (decision == Decision.APPROVE) {
                BulwarkTypes.Policy memory p = REGISTRY.getPolicy(address(this));
                _spendDaily(p, h.amount);
                h.status = HOLD_EXECUTED_OWNER;
                _totalLocked -= h.amount;
                emit Released(holdId, h.to, h.amount);
                emit OwnerDecision(holdId, uint8(decision), OWNER);
                _transferUsdc(h.to, h.amount);
                return;
            }
            h.status = HOLD_CANCELLED;
            _totalLocked -= h.amount;
            if (decision == Decision.FREEZE_ROTATE) _revokeAuthority();
            emit OwnerDecision(holdId, uint8(decision), OWNER);
            return;
        }

        if (h.status != HOLD_FROZEN) revert HoldNotFrozen();

        if (decision == Decision.APPROVE) {
            BulwarkTypes.Policy memory p = REGISTRY.getPolicy(address(this));
            _spendDaily(p, h.amount);
            h.status = HOLD_EXECUTED_OWNER;
            // No _totalLocked change: the hold left the pending pool when
            // it was frozen (freezeHold/lapseHold already decremented).
            emit Released(holdId, h.to, h.amount);
            emit OwnerDecision(holdId, uint8(decision), OWNER);
            _transferUsdc(h.to, h.amount);
            return;
        }
        h.status = HOLD_CANCELLED;
        // No _totalLocked change: already decremented at freeze time.
        if (decision == Decision.FREEZE_ROTATE) _revokeAuthority();
        emit OwnerDecision(holdId, uint8(decision), OWNER);
    }

    // ----------------------------------------------------------------- //
    //                     Fail-safe lapse handling                      //
    // ----------------------------------------------------------------- //

    /// @notice Anyone may advance a lapsed pending hold: first extend 60 min,
    ///         then auto-freeze. Funds never move without verdict or owner.
    function lapseHold(uint256 holdId) external {
        Hold storage h = holds[holdId];
        if (h.status != HOLD_PENDING) revert HoldNotPending();
        if (block.timestamp <= h.releaseAt) revert HoldNotExpired();

        if (h.extendedTo == 0) {
            h.extendedTo = uint64(block.timestamp + HOLD_EXTEND_SEC);
            emit HoldLapsed(holdId, h.extendedTo);
            return;
        }
        if (block.timestamp <= h.extendedTo) revert HoldNotExpired();
        h.status = HOLD_FROZEN;
        _totalLocked -= h.amount;
        emit OwnerDecision(holdId, 0xFE, msg.sender); // 0xFE = auto-frozen sentinel
    }

    // ----------------------------------------------------------------- //
    //                      Owner-only controls                          //
    // ----------------------------------------------------------------- //

    /// @notice Kill-switch: revoke the agent's spending authority entirely.
    function killSwitch() external {
        if (msg.sender != OWNER) revert NotOwner();
        _revokeAuthority();
    }

    /// @notice Rotate the agent key (freeze + rotate case).
    function rotateAgentKey(address newKey) external {
        if (msg.sender != OWNER) revert NotOwner();
        if (newKey == address(0)) revert ZeroAddress();
        agentKey = newKey;
        emit AgentKeyRotated(newKey);
    }

    /// @notice Owner withdrawal — custody is never locked. Bypasses policy.
    function withdraw(address token, address to, uint96 amount) external {
        if (msg.sender != OWNER) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        if (token == address(USDC)) {
            uint256 bal = USDC.balanceOf(address(this));
            uint256 locked = _lockedUsdc();
            if (amount > bal - locked) revert NothingToWithdraw();
        }
        emit Withdrawn(token, to, amount);
        if (token == address(USDC)) {
            _transferUsdc(to, amount);
        } else if (token == address(0)) {
            (bool ok,) = payable(to).call{value: uint256(amount)}("");
            if (!ok) revert TransferFailed();
        } else if (!IERC20(token).transfer(to, amount)) {
            revert TransferFailed();
        }
    }

    // ----------------------------------------------------------------- //
    //                       View helpers                                //
    // ----------------------------------------------------------------- //

    /// @notice Spendable balance: total minus funds locked in pending holds.
    function spendableUsdc() external view returns (uint256) {
        return USDC.balanceOf(address(this)) - _lockedUsdc();
    }

    /// @notice Today's enforcement counters (UTC).
    function dailyState() external view returns (uint256 day, uint96 spent, uint256 count) {
        uint256 today = _today();
        day = today;
        spent = _day == today ? _dailySpent : 0;
        count = _day == today ? _dailyCount : 0;
    }

    // ----------------------------------------------------------------- //
    //                        Internals                                  //
    // ----------------------------------------------------------------- //

    /// @dev The classifier: pure function of policy × transfer × daily state.
    ///      Returns the tier and the first reason tag (mirrors TS engine).
    function _classify(
        BulwarkTypes.Policy memory p,
        address to,
        uint96 amount
    ) internal returns (uint8 tier, bytes4 tag) {
        _resetDaily();

        // --- Hard rules first: the wall. ---
        uint96 effectiveLimit = _effectiveLimit(p, to);

        if (amount > effectiveLimit) {
            return (TIER_VIOLATION, bytes4(keccak256("OVER_PER_TX")));
        }
        uint256 day = _today();
        if (_dailySpent + amount > p.dailyLimit) {
            return (TIER_VIOLATION, bytes4(keccak256("OVER_DAILY")));
        }
        if (_dailyCount + 1 > p.velocityLimit) {
            return (TIER_VIOLATION, bytes4(keccak256("OVER_VELOCITY")));
        }
        if (BLOCKLIST.isFlagged(to)) {
            return (TIER_VIOLATION, bytes4(keccak256("ON_BLOCKLIST")));
        }

        // --- Soft signals: the yellow lane. ---
        bool newRecipient = _recipientCap(p, to) == 0 && !_inArray(p, to);
        if (newRecipient) {
            return (TIER_ELEVATED, bytes4(keccak256("NEW_RECIPIENT")));
        }
        if (_curfewActive(p)) {
            return (TIER_ELEVATED, bytes4(keccak256("CURFEW_HOUR")));
        }
        // NOTE: near-limit amounts, hour-of-day deviation, and amount-
        // distribution anomalies are the WATCHER's behavioral signals —
        // deliberately NOT on-chain lanes. On-chain elevates only on hard
        // novelty (new recipient, curfew, blocklist strike); the soft 1%
        // gets its forensic pass in the TEE, keeping routine instant.
        if (BLOCKLIST.hasAnyStrike(to) && !BLOCKLIST.isFlagged(to)) {
            return (TIER_ELEVATED, bytes4(keccak256("BLOCKLIST_STRIKE")));
        }

        return (TIER_ROUTINE, bytes4(keccak256("ROUTINE")));
    }

    function _effectiveLimit(BulwarkTypes.Policy memory p, address to) internal pure returns (uint96) {
        uint96 cap = _recipientCap(p, to);
        return cap > 0 ? cap : p.perTxLimit;
                                    }

    function _recipientCap(BulwarkTypes.Policy memory p, address to) internal pure returns (uint96) {
        for (uint256 i = 0; i < p.allowlist.length; i++) {
            if (p.allowlist[i].recipient == to) return p.allowlist[i].cap;
        }
        return 0;
    }

    function _inArray(BulwarkTypes.Policy memory p, address to) internal pure returns (bool) {
        for (uint256 i = 0; i < p.allowlist.length; i++) {
            if (p.allowlist[i].recipient == to) return true;
        }
        return false;
    }

    /// @dev Minute-of-day in UTC; curfew applies when start < end  night window.
    function _curfewActive(BulwarkTypes.Policy memory p) internal view returns (bool) {
        if (p.curfewStart == NO_CURFEW || p.curfewEnd == NO_CURFEW) return false;
        uint32 minuteOfDay = uint32((block.timestamp % 86_400) / 60);
        if (p.curfewStart == p.curfewEnd) return true;
        if (p.curfewStart < p.curfewEnd) {
            return minuteOfDay >= p.curfewStart && minuteOfDay < p.curfewEnd;
        }
        // Overnight wrap (e.g. 2:00 → 5:00 is start<end; 22:00 → 5:00 wraps).
        return minuteOfDay >= p.curfewStart || minuteOfDay < p.curfewEnd;
    }

    uint32 public constant NO_CURFEW = 1440;

    function _createHold(
        BulwarkTypes.Policy memory p,
        address to,
        uint96 amount
    ) internal returns (uint256 holdId) {
        holdId = nextHoldId++;
        holds[holdId] = Hold({
            to: to,
            amount: amount,
            releaseAt: uint64(block.timestamp + p.holdWindowSec),
            createdAt: uint64(block.timestamp),
            extendedTo: 0,
            status: HOLD_PENDING
        });
        _totalLocked += amount;
        emit Held(holdId, to, amount, holds[holdId].releaseAt);
    }

    function _spendDaily(BulwarkTypes.Policy memory /*p*/, uint96 amount) internal {
        _resetDaily();
        _dailySpent += amount;
        _dailyCount += 1;
    }

    function _today() internal view returns (uint256) {
        return block.timestamp / 86_400;
    }

    function _resetDaily() internal {
        uint256 day = _today();
        if (_day != day) {
            _day = day;
            _dailySpent = 0;
            _dailyCount = 0;
        }
    }

    /// @dev USDC locked in pending holds — O(1) running total (review C2:
    ///      the old O(n) scan over every hold id ever created griefed
    ///      spendableUsdc()/withdraw() gas: ~4.4k gas per historical hold,
    ///      1.1M gas at 500 holds, brick at ~900).
    function _lockedUsdc() internal view returns (uint256) {
        return _totalLocked;
    }

    /// @dev Balance minus pending-hold locks. Never underflows once holds
    ///      are balance-checked at creation (see propose).
    function _spendableUsdc() internal view returns (uint256) {
        return USDC.balanceOf(address(this)) - _totalLocked;
    }

    function _revokeAuthority() internal {
        authorityRevoked = true;
        emit AuthorityRevoked(OWNER);
    }

    function _transferUsdc(address to, uint96 amount) internal {
        if (!USDC.transfer(to, amount)) revert TransferFailed();
    }
}
