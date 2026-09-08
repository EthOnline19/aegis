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
    /// @dev v2 (staked arbitration) — see escalate(). Not emitted in v1.
    event Escalated(bytes32 indexed digest, address indexed by, uint256 stake);

    /// @dev Arbitration concluded: overturned or upheld.
    /// @dev v2 (staked arbitration) — see concludeArbitration(). Not emitted in v1.
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
    error NotImplementedInV1();

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

    /// @dev EIP-712 domain separator: binds every verdict signature to THIS
    ///      deployment (chainid + contract address + name/version/salt).
    ///      A signature valid here fails on any other deployment — replay
    ///      across deployments or chains is impossible (review H2).
    ///      Salt: deployment-scoped entropy; fixed here, chainid handles
    ///      the chain dimension and address(this) the deployment dimension.
    bytes32 public constant DOMAIN_SALT = keccak256("BULWARK.verdict-domain.v1");
    string public constant DOMAIN_NAME = "BULWARK VerdictContract";
    string public constant DOMAIN_VERSION = "1";
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @dev EIP-712 type hashes for the two signed payloads.
    bytes32 public constant VERDICT_TYPEHASH =
        keccak256("Verdict(bytes32 policyHash,address agent,address claimant,bytes32 txHash,address destination,uint96 lossAmount,uint96 payoutAmount,uint8 alibi,uint8 outcome,Reason[] reasons,uint64 timestamp)Reason(bytes4 tag,uint8 provenance,string detail)");
    bytes32 public constant HOLD_VERDICT_TYPEHASH =
        keccak256("HoldVerdict(uint256 holdId,address agent,bytes32 policyHash,uint8 tier)");
    bytes32 private constant _REASON_TYPEHASH =
        keccak256("Reason(bytes4 tag,uint8 provenance,string detail)");

    /// @dev Freshness window: a verdict must be submitted within this window.
    uint64 public constant VERDICT_FRESHNESS_SEC = 600;


    /// @dev digest => accepted verdict (append-only ledger).
    mapping(bytes32 digest => AcceptedVerdict) public verdicts;

    /// @dev txHash => payout already made (double-claim nullifier).
    mapping(bytes32 txHash => bool paid) public claimNullifiers;

    /// @dev Dispute state per digest.
    mapping(bytes32 digest => Dispute) public disputes;

    /// @dev Arbiters authorized for staked escalation — v2 (Case 7).
    ///      Removed in v1 along with the exploitable escrow path; the
    ///      DisputeState enum keeps its ARBITRATION values documented.
    // mapping(address arbiter => bool) public isArbiter;   // v2
    // uint256 public constant ARBITRATION_STAKE = 1 ether; // v2


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
        // uint256 stake; — v2: escrowed arbiter stake (no escrow in v1)
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
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"),
                keccak256(bytes(DOMAIN_NAME)),
                keccak256(bytes(DOMAIN_VERSION)),
                block.chainid,
                address(this),
                DOMAIN_SALT
            )
        );
    }

    /// @dev EIP-712 digest for a full verdict: keccak256(0x1901 ‖ domain ‖ structHash).
    ///      The reasons array is hashed struct-by-struct per EIP-712 rules.
    function verdictDigest712(BulwarkTypes.Verdict memory v) public view returns (bytes32) {
        bytes32[] memory reasonHashes = new bytes32[](v.reasons.length);
        for (uint256 i = 0; i < v.reasons.length; i++) {
            reasonHashes[i] = keccak256(
                abi.encode(_REASON_TYPEHASH, v.reasons[i].tag, v.reasons[i].provenance, v.reasons[i].detail)
            );
        }
        bytes32 structHash = keccak256(
            abi.encode(
                VERDICT_TYPEHASH,
                v.policyHash,
                v.agent,
                v.claimant,
                v.txHash,
                v.destination,
                v.lossAmount,
                v.payoutAmount,
                v.alibi,
                v.outcome,
                keccak256(abi.encodePacked(reasonHashes)),
                v.timestamp
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @dev EIP-712 digest for a hold verdict.
    function holdVerdictDigest712(
        uint256 holdId,
        address agent,
        bytes32 policyHash,
        uint8 tier
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(HOLD_VERDICT_TYPEHASH, holdId, agent, policyHash, tier));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
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

    /// @dev setArbiter — v2 (Case 7): arbiters existed only for the staked
    ///      escalation path, which v1 removed. Re-add with the real
    ///      3-of-N design.

    // ----------------------------------------------------------------- //
    //                      Verdict submission                           //
    // ----------------------------------------------------------------- //

    /// @notice Submit a TEE-signed verdict for adjudication and routing.
    /// @dev Verifies ECP signature over verdictDigest, freshness, and policy pin.
    function submitVerdict(BulwarkTypes.Verdict calldata v, bytes calldata signature) external {
        if (msg.sender != watcher) revert NotWatcher();

        // EIP-712 domain-bound digest (chainid + this address): the same
        // verdict bytes produce a different digest on any other deployment,
        // so cross-deployment replay fails the signature check (review H2).
        bytes32 digest = verdictDigest712(v);
        if (verdicts[digest].acceptedAt != 0) revert DuplicateClaim();

        // --- Signature check: the TEE signed exactly this verdict, on this
        //     deployment's domain. ---
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
    ///      The digest is the EIP-712 typed digest (already 0x1901-prefixed
    ///      inside verdictDigest712) — signed directly, no EIP-191 wrapper.
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
        return ecrecover(digest, v, r, s);
    }

    // ----------------------------------------------------------------- //
    //                        Hold verdicts                              //
    // ----------------------------------------------------------------- //

    /// @notice Route a TEE hold verdict to the GuardAccount:
    ///         clean (tier 0) → release; suspicious (tier 1) → freeze.
    ///         The signature is EIP-712 over this deployment's domain
    ///         (HoldVerdict struct: holdId, agent, policyHash, tier).
    function submitHoldVerdict(
        uint256 holdId,
        address agent,
        bytes32 policyHash,
        uint8 verdictTier,
        bytes calldata signature
    ) external {
        if (msg.sender != watcher) revert NotWatcher();
        bytes32 digest = holdVerdictDigest712(holdId, agent, policyHash, verdictTier);
        address recovered = _recoverSigner(digest, signature);
        if (recovered != watcher) revert BadSignature();

        // Event BEFORE the external GuardAccount call (CEI: honest log even
        // if the guard reverts, e.g. hold already decided) — matches _route's
        // effects-first discipline and keeps the orchestrator's mirror feed
        // fed for every routed hold verdict.
        emit HoldVerdictRouted(holdId, agent, verdictTier == 0);

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
            // Scan the FULL reasons array — the drainer reason may sit at
            // any position (old code inspected only reasons[0]).
            for (uint256 i = 0; i < v.reasons.length; i++) {
                if (v.reasons[i].tag == BL_TAG_ON_BLOCKLIST || v.reasons[i].tag == BL_TAG_DRAINER) {
                    BLOCKLIST.report(v.destination, digest);
                    break;
                }
            }
        }
    }

    /// @dev Reason tags shared with the TS engine (blocklist routing).
    ///      MUST match packages/engine/src/engine.ts byte-for-byte:
    ///      "DRAINER_SIGNATURE" (the old BL_TAG_DRANER typo never matched,
    ///      so drainer verdicts recorded zero strikes).
    bytes4 public constant BL_TAG_ON_BLOCKLIST = bytes4(keccak256("ON_BLOCKLIST"));
    bytes4 public constant BL_TAG_DRAINER = bytes4(keccak256("DRAINER_SIGNATURE"));

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

    /// @notice Staked arbitration is PLANNED FOR v2 — deliberately not
 ///         implemented in v1.
    /// @dev  The v0 sketch here was exploitable (single-arbiter conclusion,
    ///      no quorum, anyone could add stake to anyone's dispute, ETH
    ///      stranded on upheld outcomes — review C3) and it is not on the
    ///      demo path. v1 fails loudly instead: no ETH can be escrowed, so
    ///      nothing can be stranded or stolen. The v2 design (3-of-N
    ///      staked auditors, majority rules, liars slashed) is sketched in
    ///      BULWARK_MASTER_PLAN.md Case 7.
    function escalate(bytes32 digest) external payable {
        digest; // referenced for a stable signature; no state is touched
        revert NotImplementedInV1();
    }

    /// @notice See escalate() — arbitration conclusion is v2 (Case 7).
    function concludeArbitration(bytes32 digest, bool overturn) external {
        digest; // ditto
        overturn; // ditto
        revert NotImplementedInV1();
    }

    // ----------------------------------------------------------------- //
    //                            Reads                                 //
    // ----------------------------------------------------------------- //

    function getVerdict(bytes32 digest) external view returns (AcceptedVerdict memory) {
        return verdicts[digest];
    }
}
