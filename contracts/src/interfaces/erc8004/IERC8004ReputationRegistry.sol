// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ERC-8004 Reputation Registry interface (v2.0.0).
/// @notice Minimal surface copied from the canonical reference
///         implementation (erc-8004/erc-8004-contracts,
///         ReputationRegistryUpgradeable.sol, MIT). Auth semantics: anyone
///         may `giveFeedback` EXCEPT the agentId owner / approved operators
///         (self-feedback guard reverts "Self-feedback not allowed");
///         `revokeFeedback` only the original client; writes are one-time
///         per index. `getSummary` AVERAGES (WAD-normalized, divided by
///         count, rescaled to the mode `valueDecimals` of matching
///         entries) — BULWARK's sum-based résumé score is derived off-chain
///         from `readAllFeedback` (design: docs/ERC8004_DESIGN.md §3).
interface IERC8004ReputationRegistry {
    struct Feedback {
        int128 value; // 16 bytes
        uint8 valueDecimals; // 1 byte (packed with value + isRevoked)
        bool isRevoked; // 1 byte (packed with value + valueDecimals)
        string tag1;
        string tag2;
    }

    /// @notice Give feedback on an agent. `value` int128 with
    ///         `valueDecimals` 0..18, |value| <= 1e38. Per (agentId, client)
    ///         feedback is 1-indexed and append-only (revoke, never edit).
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    /// @notice Revoke one of YOUR feedback entries by index (irreversible flag).
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;

    /// @notice Append a response URI/hash to an existing feedback entry.
    ///         Unused by BULWARK v1 (kept for interface fidelity).
    function appendResponse(
        uint256 agentId,
        uint64 feedbackIndex,
        address responder,
        string calldata responseURI,
        bytes32 responseHash
    ) external;

    /// @notice One feedback entry; reverts for index 0 / out of bounds.
    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (
            int128 value,
            uint8 valueDecimals,
            string memory tag1,
            string memory tag2,
            bool isRevoked
        );

    /// @notice AVERAGE of matching, non-revoked feedback — NOT a sum.
    ///         Empty-string tag filters match everything.
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    /// @notice All matching, non-revoked feedback entries. Empty
    ///         `clientAddresses` = every client that ever gave feedback to
    ///         this agent (on the reference; Arc v2.0.0 matches).
    function readAllFeedback(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2,
        bool includeRevoked
    )
        external
        view
        returns (
            address[] memory clients,
            uint64[] memory feedbackIndexes,
            int128[] memory values,
            uint8[] memory valueDecimals,
            string[] memory tag1s,
            string[] memory tag2s,
            bool[] memory revokedStatuses
        );

    /// @notice Latest feedback index used by a client (0 = none).
    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);

    /// @notice All client addresses that ever gave feedback to an agent.
    function getClients(uint256 agentId) external view returns (address[] memory);

    /// @notice Identity registry this reputation registry is cross-linked to.
    function getIdentityRegistry() external view returns (address);
    event ResponseAppended(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        address indexed responder,
        string responseURI,
        bytes32 responseHash
    );

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    event FeedbackRevoked(
        uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex
    );
}
