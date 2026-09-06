// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BulwarkTypes} from "./BulwarkTypes.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";

/// @title BULWARK PolicyRegistry — the constitution store.
/// @notice Stores the versioned, hash-committed policy for each agent.
///          Read by GuardAccount (enforcement) and the Watcher (verdicts).
///          "The policy is simultaneously the seatbelt and the insurance contract."
contract PolicyRegistry is IPolicyRegistry {
    using BulwarkTypes for BulwarkTypes.Policy;

    // ----------------------------------------------------------------- //
    //                              Events                               //
    // ----------------------------------------------------------------- //

    /// @dev Emitted on every attach; subgraph indexes policy lineage.
    event PolicyUpdated(address indexed agent, uint32 indexed version, bytes32 policyHash);
    event PolicyRevoked(address indexed agent, uint32 indexed version);

    // ----------------------------------------------------------------- //
    //                              Errors                               //
    // ----------------------------------------------------------------- //

    error PolicyNotFound();
    error NotPolicyOwner();
    error InvalidPolicy();
    error BadVersion();
    error AgentMismatch();

    // ----------------------------------------------------------------- //
    //                            Storage                                //
    // ----------------------------------------------------------------- //

    /// @dev agent => latest policy. Agent here is the GuardAccount address.
    mapping(address agent => BulwarkTypes.Policy policy) private _policies;

    /// @dev agent => version history of hashes (append-only).
    mapping(address agent => mapping(uint32 version => bytes32 hash)) public policyHashAt;

    /// @dev agent => latest version number.
    mapping(address agent => uint32 version) public latestVersion;

    // ----------------------------------------------------------------- //
    //                           Enforcement                             //
    // ----------------------------------------------------------------- //

    /// @notice Attach (create or update) a policy for an agent.
    /// @dev  Version must increment by exactly 1. If the agent's GuardAccount
    ///       already exists, only its owner may attach. Hash is committed so
    ///       verdicts can pin an exact policy version.
    function attach(address agent, BulwarkTypes.Policy calldata policy) external {
        _validate(agent, policy);

        uint32 next = latestVersion[agent] + 1;
        if (policy.version != next) revert BadVersion();

        // First attach: the caller declares ownership and must be the owner field.
        // Later attaches: only the recorded owner (or GuardAccount owner path).
        if (next > 1) {
            BulwarkTypes.Policy storage prev = _policies[agent];
            if (prev.owner != msg.sender && msg.sender != address(this)) revert NotPolicyOwner();
        } else {
            // The GuardAccount's deploy flow calls attach via its own address;
            // standalone first-attach requires owner == msg.sender.
            if (msg.sender != policy.owner && msg.sender != agent) revert NotPolicyOwner();
        }

        _policies[agent] = policy;
        policyHashAt[agent][next] = policy.hashPolicy();
        latestVersion[agent] = next;

        emit PolicyUpdated(agent, next, policyHashAt[agent][next]);
    }

    /// @notice Read the live policy for an agent (enforcement path).
    function getPolicy(address agent) external view returns (BulwarkTypes.Policy memory) {
        if (latestVersion[agent] == 0) revert PolicyNotFound();
        return _policies[agent];
    }

    /// @notice Distilled view: flat arrays, cheap for on-chain enforcement.
    function getPolicyView(address agent) external view returns (BulwarkTypes.PolicyView memory) {
        if (latestVersion[agent] == 0) revert PolicyNotFound();
        BulwarkTypes.Policy storage p = _policies[agent];
        return BulwarkTypes.PolicyView({
            version: p.version,
            agent: p.agent,
            owner: p.owner,
            coverageCap: p.coverageCap,
            deductibleBps: p.deductibleBps,
            perTxLimit: p.perTxLimit,
            dailyLimit: p.dailyLimit,
            velocityLimit: p.velocityLimit,
            recipients: _recipients(p),
            caps: _caps(p),
            curfewStart: p.curfewStart,
            curfewEnd: p.curfewEnd,
            holdWindowSec: p.holdWindowSec,
            sdkInstalled: p.sdkInstalled
        });
    }

    /// @notice Verify that `p` is the exact live policy for `agent` (verdicts pin this).
    function verifyHash(address agent, bytes32 hash) external view returns (bool) {
        return policyHashAt[agent][latestVersion[agent]] == hash;
    }

    /// @notice Revoke coverage for an agent (owner or kill-switch path).
    function revoke(address agent) external {
        if (latestVersion[agent] == 0) revert PolicyNotFound();
        address owner = _policies[agent].owner;
        if (msg.sender != owner && msg.sender != agent) revert NotPolicyOwner();
        uint32 v = latestVersion[agent];
        delete _policies[agent];
        latestVersion[agent] = 0; // policy gone; next attach must be v1
        emit PolicyRevoked(agent, v);
    }

    // ----------------------------------------------------------------- //
    //                            Internals                              //
    // ----------------------------------------------------------------- //

    function _caps(BulwarkTypes.Policy storage p) internal view returns (uint96[] memory out) {
        out = new uint96[](p.allowlist.length);
        for (uint256 i = 0; i < p.allowlist.length; i++) {
            out[i] = p.allowlist[i].cap;
        }
    }

    function _recipients(BulwarkTypes.Policy storage p) internal view returns (address[] memory out) {
        out = new address[](p.allowlist.length);
        for (uint256 i = 0; i < p.allowlist.length; i++) {
            out[i] = p.allowlist[i].recipient;
        }
    }

    function _validate(address agent, BulwarkTypes.Policy calldata policy) internal pure {
        if (agent == address(0)) revert InvalidPolicy();
        if (policy.agent != agent) revert AgentMismatch();
        if (policy.owner == address(0)) revert InvalidPolicy();
        if (policy.version == 0) revert InvalidPolicy();
        if (policy.perTxLimit == 0) revert InvalidPolicy();
        if (policy.dailyLimit == 0 || policy.dailyLimit < policy.perTxLimit) revert InvalidPolicy();
        if (policy.velocityLimit == 0) revert InvalidPolicy();
        if (policy.holdWindowSec == 0) revert InvalidPolicy();
        if (policy.coverageCap == 0) revert InvalidPolicy();
        if (policy.deductibleBps > 5000) revert InvalidPolicy(); // max 50%
        // Coverage must be able to absorb at least one max-strength claim.
        if (policy.perTxLimit > policy.coverageCap + (policy.coverageCap * policy.deductibleBps) / 10_000) {
            revert InvalidPolicy();
        }
    }
}
