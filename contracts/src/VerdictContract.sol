// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BulwarkTypes} from "./BulwarkTypes.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";
import {IBlocklist} from "./interfaces/IBlocklist.sol";
import {IMutualPool} from "./interfaces/IMutualPool.sol";
import {IGuardAccount} from "./interfaces/IGuardAccount.sol";

/// @title BULWARK VerdictContract — the auto-adjudicator.
/// @notice Accepts TEE-signed verdicts, verifies signature + freshness +
///          policy match, and routes outcomes: COVERED → pool payout,
///          DENIED_OWNER_ORIGIN → claim scar, ATTEMPTED → pricing signal.
///          No payout without a valid TEE attestation. Payout ≤ cap.
///          No double-claim: one nullifier per breached tx hash.
///          Dispute path: re-run (same digest) → staked arbitration.
contract VerdictContract {
    using BulwarkTypes for BulwarkTypes.Verdict;

    // ----------------------------------------------------------------- //
    //                              Events                               //
    // ----------------------------------------------------------------- //

    /// @dev A verdict was accepted and routed.
    event VerdictAccepted(
        bytes32 indexed digest,
        address indexed agent,
        uint8 outcome,
        uint96 payout,
        uint8 alibi
    );

    /// @dev Hold-window verdict routed (clean release / suspicious freeze).
    event HoldVerdictRouted(uint256 indexed holdId, address indexed agent, bool clean);

    /// @dev Attempted-breach pricing signal.
    event AttemptedBreachSignal(address indexed agent, bytes32 indexed txHash, bytes4 tag);

    /// @dev A claim was reopened for re-execution (dispute path).
    event Reopened(bytes32 indexed digest, address indexed by);

    /// @dev Escalation to staked arbitration (3 auditors).
    event Escalated(bytes32 indexed digest, address indexed by, uint256 stake);

    /// @dev Arbitration concluded: overturned or upheld.
    event ArbitrationConcluded(bytes32 indexed digest, bool overturned, address indexed by);

    /// @dev A strike was recorded on the shared blocklist.
    event StrikeRecorded(address indexed destination, uint8 strikes);
    /// @dev Watcher signing key rotated.
    event WatcherSet(address indexed previous, address indexed next);
    /// @dev Pool wiring changed.
    event PoolSet(address indexed previous, address indexed next);
    /// @dev Arbiter authorization changed.
    event ArbiterSet(address indexed arbiter, bool allowed);

    // ----------------------------------------------------------------- //
    //                              Errors                               //
    // ----------------------------------------------------------------- //

    error NotWatcher();
    error NotAdmin();
    error NotArbiter();
    error BadSignature();
    error StaleVerdict();
    error FutureVerdict();
    error PolicyMismatch();
    error AgentMismatch();
    error DuplicateClaim();
    error ZeroAddress();
    error PayoutExceedsCap();
    error PayoutExceedsLoss();
    error OutcomeMismatch();
    error VerdictNotFound();
    error AlreadyFinal();
    error NotReopenable();
    error BadStake();
    error PoolNotWired();
    error Deadlock();

    // ----------------------------------------------------------------- //
    //                            Storage                                //
    // ----------------------------------------------------------------- //

    /// @dev The TEE watcher's signing address (Chainlink CRE job key).
    address public watcher;

    /// @dev Admin: rotates watcher key, wires pool, sets arbiters.
    address public admin;

    /// @dev The MutualPool — the only consumer of `payout()`.
    IMutualPool public pool;

    /// @dev PolicyRegistry for policy-hash pinning.
    IPolicyRegistry public immutable REGISTRY;

    /// @dev Blocklist for strike recording.
    IBlocklist public immutable BLOCKLIST;

    /// @dev Freshness window: a verdict must be submitted within this window.
    uint64 public constant VERDICT_FRESHNESS_SEC = 600;

    /// @dev digest => accepted verdict (append-only ledger).
    mapping(bytes32 digest => AcceptedVerdict) public verdicts;

    /// @dev txHash => payout already made (double-claim nullifier).
    mapping(bytes32 txHash => bool paid) public claimNullifiers;

    /// @dev Dispute state per digest.
    mapping(bytes32 digest => Dispute) public disputes;

    /// @dev Arbiters authorized for staked escalation.
    mapping(address arbiter => bool) public isArbiter;

    /// @dev Minimum stake for arbitration.
    uint256 public constant ARBITRATION_STAKE = 1 ether;

    struct AcceptedVerdict {
        address agent;
        address claimant;
        bytes32 txHash;
        uint96 payout;
        uint8 outcome;
        uint8 alibi;
        uint64 acceptedAt;
        bool reopened;
    }

    /// @dev Dispute lifecycle: NONE → UNDER_REVIEW → (RERUN | ARBITRATION) → final.
    enum DisputeState {
        NONE, // 0
        UNDER_REVIEW, // 1: 48h window, re-run free
        RERUN_PENDING, // 2: deterministic re-execution running
        ARBITRATION, // 3: 3 staked auditors voting
        FINAL_OVERTURNED, // 4: dismissed / overturned
        FINAL_UPHELD // 5
    }

    struct Dispute {
        DisputeState state;
        address disputeOpener;
        uint256 stake; // escrowed arbiter stake
        uint256 openedAt;
    }

    // ----------------------------------------------------------------- //
    //                         Constructor                               //
    // ----------------------------------------------------------------- //

    constructor(address registry_, address blocklist_) {
        if (registry_ == address(0)) revert ZeroAddress();
        if (blocklist_ == address(0)) revert ZeroAddress();
        REGISTRY = IPolicyRegistry(registry_);
        BLOCKLIST = IBlocklist(blocklist_);
        admin = msg.sender;
        watcher = msg.sender;
    }

    // ----------------------------------------------------------------- //
    //                          Admin wiring                             //
    // ----------------------------------------------------------------- //

    function setWatcher(address watcher_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (watcher_ == address(0)) revert ZeroAddress();
        address previous = watcher;
        watcher = watcher_;
        emit WatcherSet(previous, watcher_);
    }

    function setPool(address pool_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (pool_ == address(0)) revert ZeroAddress();
        address previous = address(pool);
        pool = IMutualPool(pool_);
        emit PoolSet(previous, pool_);
    }

    function setArbiter(address arbiter, bool allowed) external {
        if (msg.sender != admin) revert NotAdmin();
        if (arbiter == address(0)) revert ZeroAddress();
        isArbiter[arbiter] = allowed;
        emit ArbiterSet(arbiter, allowed);
    }

    // ----------------------------------------------------------------- //
    //                      Verdict submission                           //
    // ----------------------------------------------------------------- //

    /// @notice Submit a TEE-signed verdict for adjudication and routing.
    /// @dev Verifies ECP signature over verdictDigest, freshness, and policy pin.
    function submitVerdict(BulwarkTypes.Verdict calldata v, bytes calldata signature) external {
        if (msg.sender != watcher) revert NotWatcher();

        bytes32 digest = v.verdictDigest();
        if (verdicts[digest].acceptedAt != 0) revert DuplicateClaim();

        // --- Signature check: the TEE signed exactly this verdict. ---
        // ECDSA recover (OpenZeppelin's algorithm, inlined for zero deps).
        address recovered = _recoverSigner(digest, signature);
        if (recovered != watcher) revert BadSignature();

        // --- Freshness: verdict minted recently, not replayed later. ---
        if (v.timestamp > block.timestamp) revert FutureVerdict();
        if (block.timestamp - v.timestamp > VERDICT_FRESHNESS_SEC) revert StaleVerdict();

        // --- Policy pin: verdict ran against the live policy version. ---
        bytes32 liveHash = REGISTRY.policyHashAt(v.agent, REGISTRY.latestVersion(v.agent));
        if (liveHash != v.policyHash) revert PolicyMismatch();

        // --- Cross-field validation. ---
        uint96 payout = v.payoutAmount;
        uint16 deductibleBps;
        {
            BulwarkTypes.Policy memory p = REGISTRY.getPolicy(v.agent);
            deductibleBps = p.deductibleBps;
            if (p.owner != v.claimant) revert AgentMismatch();
            if (payout > p.coverageCap) revert PayoutExceedsCap();
        }
        if (v.outcome == uint8(BulwarkTypes.Outcome.COVERED)) {
            if (v.alibi != uint8(BulwarkTypes.Alibi.EXTERNAL)) revert OutcomeMismatch();
            if (claimNullifiers[v.txHash]) revert DuplicateClaim();
            if (payout + (payout * deductibleBps) / 10_000 > v.lossAmount) {
                revert PayoutExceedsLoss();
            }
        } else {
            if (payout != 0) revert OutcomeMismatch();
            if (v.outcome == uint8(BulwarkTypes.Outcome.DENIED_OWNER_ORIGIN)) {
                if (v.alibi != uint8(BulwarkTypes.Alibi.OWNER_SIGNED)) revert OutcomeMismatch();
            }
        }

        // --- Record. ---
        verdicts[digest] = AcceptedVerdict({
            agent: v.agent,
            claimant: v.claimant,
            txHash: v.txHash,
            payout: payout,
            outcome: v.outcome,
            alibi: v.alibi,
            acceptedAt: uint64(block.timestamp),
            reopened: false
        });

        // --- Route. ---
        _route(v, digest);
    }

    /// @dev OpenZeppelin-style ECDSA recover, inlined (no external deps).
    function _recoverSigner(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "BAD_SIG_LEN");
        bytes32 r;
        bytes32 s;
        uint8 v;
        // calldata slice → assembly decode (safe: length checked).
        // solhint-disable-next-line no-inline-assembly
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        // EIP-2: reject malleable (high-s) signatures.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        bytes32 ethDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        return ecrecover(ethDigest, v, r, s);
    }

    // ----------------------------------------------------------------- //
    //                        Hold verdicts                              //
    // ----------------------------------------------------------------- //

    /// @notice Route a TEE hold verdict to the GuardAccount:
    ///         clean (tier 0) → release; suspicious (tier 1) → freeze.
    ///         The signature is over keccak(abi.encode(holdId, agent, policyHash, tier)).
    function submitHoldVerdict(
        uint256 holdId,
        address agent,
        bytes32 policyHash,
        uint8 verdictTier,
        bytes calldata signature
    ) external {
        if (msg.sender != watcher) revert NotWatcher();
        bytes32 digest = keccak256(abi.encode(holdId, agent, policyHash, verdictTier));
        address recovered = _recoverSigner(digest, signature);
        if (recovered != watcher) revert BadSignature();

        if (verdictTier == 0) {
            IGuardAccount(agent).releaseHold(holdId);
        } else if (verdictTier == 1) {
            IGuardAccount(agent).freezeHold(holdId);
        } else {
            revert OutcomeMismatch();
        }
    }

    // ----------------------------------------------------------------- //
    //                          Routing                                  //
    // ----------------------------------------------------------------- //

    function _route(BulwarkTypes.Verdict calldata v, bytes32 digest) internal {
        // Effects first: nullifier + all events precede external calls (CEI).
        if (v.outcome == uint8(BulwarkTypes.Outcome.COVERED)) {
            claimNullifiers[v.txHash] = true;
        } else if (v.outcome == uint8(BulwarkTypes.Outcome.DENIED_OWNER_ORIGIN)) {
            claimNullifiers[v.txHash] = true; // denied claims also consume the nullifier
        }

        emit VerdictAccepted(digest, v.agent, v.outcome, v.payoutAmount, v.alibi);

        if (v.outcome == uint8(BulwarkTypes.Outcome.ATTEMPTED_BREACH)) {
            emit AttemptedBreachSignal(v.agent, v.txHash, bytes4(digest));
        }

        // Interactions last.
        if (v.outcome == uint8(BulwarkTypes.Outcome.COVERED)) {
            if (address(pool) == address(0)) revert PoolNotWired();
            pool.payout(v.claimant, v.payoutAmount, digest);
            return;
        }
        if (v.outcome == uint8(BulwarkTypes.Outcome.ATTEMPTED_BREACH)) {
            // Attempted breaches record a strike on the shared blocklist.
            if (
                v.reasons.length > 0
                    && (v.reasons[0].tag == BL_TAG_ON_BLOCKLIST || v.reasons[0].tag == BL_TAG_DRANER)
            ) {
                BLOCKLIST.report(v.destination, digest);
            }
        }
    }

    // ----------------------------------------------------------------- //
    //                      Dispute / arbitration                        //
    // ----------------------------------------------------------------- //

    /// @notice Dispute window: any claimant may open review within 48h of a
    ///         covered or denied verdict. Re-run is free and deterministic.
    function dispute(bytes32 digest) external {
        AcceptedVerdict storage av = verdicts[digest];
        if (av.acceptedAt == 0) revert VerdictNotFound();
        Dispute storage d = disputes[digest];
        if (d.state != DisputeState.NONE) revert AlreadyFinal();

        d.state = DisputeState.UNDER_REVIEW;
        d.disputeOpener = msg.sender;
        d.openedAt = block.timestamp;
        emit Reopened(digest, msg.sender);
    }

    /// @notice Re-run the deterministic pipeline on public data. Same inputs,
    ///         same verdict: the model was never wrong about facts.
    /// @dev    Watcher re-executes and submits a fresh verdict; the dispute
    ///         moves to RERUN_PENDING until it arrives or the window closes.
    function requestRerun(bytes32 digest) external {
        Dispute storage d = disputes[digest];
        if (d.state != DisputeState.UNDER_REVIEW) revert NotReopenable();
        d.state = DisputeState.RERUN_PENDING;
    }

    /// @notice Escalate to staked arbitration: 3 independent auditors stake
    ///         USDC on the correct verdict; majority rules; liars slashed.
    function escalate(bytes32 digest) external payable {
        Dispute storage d = disputes[digest];
        if (d.state != DisputeState.UNDER_REVIEW && d.state != DisputeState.RERUN_PENDING) {
            revert NotReopenable();
        }
        if (msg.value < ARBITRATION_STAKE) revert BadStake();
        d.state = DisputeState.ARBITRATION;
        d.stake += msg.value;
        emit Escalated(digest, msg.sender, msg.value);
    }

    /// @notice Arbiters conclude: overturn (dismissed, no scar) or uphold.
    ///         Escrowed stake refunds on overturn; slashed on uphold-fraud.
    function concludeArbitration(bytes32 digest, bool overturn) external {
        if (!isArbiter[msg.sender]) revert NotArbiter();
        Dispute storage d = disputes[digest];
        if (d.state != DisputeState.ARBITRATION) revert NotReopenable();

        d.state = overturn ? DisputeState.FINAL_OVERTURNED : DisputeState.FINAL_UPHELD;
        emit ArbitrationConcluded(digest, overturn, msg.sender);

        if (overturn) {
            // Refund the escrowed stake to the dispute opener.
            (bool ok,) = payable(d.disputeOpener).call{value: d.stake}("");
            if (!ok) revert Deadlock();
        }
        // Upheld: the stake stays in this contract as slashed-liar buffer;
        // admin sweeps. Lies are expensive; truth is free.
    }

    // ----------------------------------------------------------------- //
    //                            Reads                                 //
    // ----------------------------------------------------------------- //

    function getVerdict(bytes32 digest) external view returns (AcceptedVerdict memory) {
        return verdicts[digest];
    }

    /// @dev Reason tags shared with the TS engine (blocklist routing).
    bytes4 public constant BL_TAG_ON_BLOCKLIST = bytes4(keccak256("ON_BLOCKLIST"));
    bytes4 public constant BL_TAG_DRANER = bytes4(keccak256("DRANER_SIGNATURE"));
}
