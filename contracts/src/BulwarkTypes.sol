// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title BULWARK shared types
/// @notice Core structs + enums shared by every contract in the protocol.
///          "The AI narrates, the code decides" — everything here is deterministic.
library BulwarkTypes {
    // ---------------------------------------------------------------------
    // Lanes — the three lanes of the GuardAccount.
    // ---------------------------------------------------------------------

    /// @dev Lane classification for a proposed transaction.
    enum Tier {
        ROUTINE, // 0: within policy → executes instantly
        ELEVATED, // 1: near-limit / new recipient / unusual → hold window
        VIOLATION // 2: breaks policy outright → blocked before broadcast
    }

    // ---------------------------------------------------------------------
    // Policy — "the rules of normal", on-chain and versioned.
    // ---------------------------------------------------------------------

    /// @dev Per-recipient sub-cap: `payrollContract: $400` (Case 1 in the plan).
    ///      For an allowlisted recipient the sub-cap *replaces* the global
    ///      per-tx limit; the global limit governs everyone else.
    struct RecipientCap {
        address recipient;
        uint96 cap;
    }

    /// @dev The Policy. All amounts are USDC base units (6 decimals).
    struct Policy {
        uint32 version; // bumped by exactly 1 on every update
        address agent; // the GuardAccount this policy governs
        address owner; // the human: only key with owner powers
        uint96 coverageCap; // max payout per claim (e.g. 2_500e6)
        uint16 deductibleBps; // 1000 = 10% of each claim
        uint96 perTxLimit; // hard cap per tx for non-allowlisted recipients
        uint96 dailyLimit; // hard cap per UTC day
        uint32 velocityLimit; // max executed txs per UTC day
        RecipientCap[] allowlist; // approved recipients w/ per-recipient caps
        uint32 curfewStart; // minute-of-day; 1440 = no curfew
        uint32 curfewEnd; // minute-of-day; 1440 = no curfew
        uint32 holdWindowSec; // elevated-tx hold duration (plan default: 120)
        bool sdkInstalled; // alibi hash-chain available → pricing discount
    }

    /// @dev Distilled, flat view used by GuardAccount enforcement loops.
    struct PolicyView {
        uint32 version;
        address agent;
        address owner;
        uint96 coverageCap;
        uint16 deductibleBps;
        uint96 perTxLimit;
        uint96 dailyLimit;
        uint32 velocityLimit;
        address[] recipients;
        uint96[] caps;
        uint32 curfewStart;
        uint32 curfewEnd;
        uint32 holdWindowSec;
        bool sdkInstalled;
    }

    /// @dev Flatten a policy to a single commitment (verdicts pin exact versions).
    function hashPolicy(Policy memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    // ---------------------------------------------------------------------
    // Verdicts — the sealed referee's output.
    // ---------------------------------------------------------------------
    /// @dev The TEE verdict, submitted (signed) to VerdictContract.
    struct Verdict {
        bytes32 policyHash; // exact policy version this verdict ran against
        address agent; // GuardAccount the claim concerns
        address claimant; // who receives a payout (the owner)
        bytes32 txHash; // the breached transaction (nullifier key)
        address destination; // where the funds went (blocklist strikes)
        uint96 lossAmount; // observed loss in USDC units
        uint96 payoutAmount; // proposed payout (≤ coverageCap, after deductible)
        uint8 alibi; // Alibi enum value
        uint8 outcome; // Outcome enum value
        Reason[] reasons; // every reason with provenance labels
        uint64 timestamp; // verdict mint time (freshness window)
    }
    enum Outcome {
        NONE, // 0
        COVERED, // 1: parametric trigger met → pool payout
        DENIED_OWNER_ORIGIN, // 2: alibi proves owner ordered it → claim scar
        ATTEMPTED_BREACH, // 3: blocked/held attack → pricing signal only
        DISMISSED // 4: overturned by re-run or arbitration (no fault)
    }

    /// @dev Alibi outcome: was the breaching instruction owner-signed?
    enum Alibi {
        UNKNOWN, // 0: no SDK chain / not applicable
        EXTERNAL, // 1: instruction came from outside the owner session → coverable
        OWNER_SIGNED // 2: instruction signed by owner session key → DENY
    }

    /// @dev Reason provenance — nothing is ever INFERRED.
    enum Provenance {
        VERIFIED, // read from signed, public data
        COMPUTED // this formula, published
    }

    /// @dev A single reason line inside a verdict.
    struct Reason {
        bytes4 tag; // short reason code, mirrored in the TS engine
        uint8 provenance; // Provenance.VERIFIED | Provenance.COMPUTED
        string detail; // human-readable narrative
    }


    function verdictDigest(Verdict memory v) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                v.policyHash,
                v.agent,
                v.claimant,
                v.txHash,
                v.destination,
                v.lossAmount,
                v.payoutAmount,
                v.alibi,
                v.outcome,
                v.reasons,
                v.timestamp
            )
        );
    }
}
