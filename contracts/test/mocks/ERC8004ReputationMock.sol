// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    IERC8004ReputationRegistry
} from "../../src/interfaces/erc8004/IERC8004ReputationRegistry.sol";
import {
    IERC8004IdentityRegistry
} from "../../src/interfaces/erc8004/IERC8004IdentityRegistry.sol";

/// @title ERC-8004 Reputation Registry mock (reference replica).
/// @notice Replicates the canonical v2.0.0 semantics BULWARK's orchestrator
///         and consumers depend on:
///         - self-feedback guard: giveFeedback reverts when the caller is
///           the agentId owner or an approved operator ("Self-feedback not
///           allowed"); nonexistent agent reverts "nonexistent token".
///         - value bounds: valueDecimals <= 18, |value| <= 1e38.
///         - 1-indexed, append-only per (agentId, client); revoke-only.
///         - getSummary AVERAGES (WAD-normalize, divide by count, rescale
///           to the mode valueDecimals) — pinned by tests so the design's
///           "count is the repetition signal" claim stays true.
contract ERC8004ReputationMock is IERC8004ReputationRegistry {
    IERC8004IdentityRegistry public immutable identityRegistry;

    /// @dev Interface completeness: cross-link back to the identity registry.
    function getIdentityRegistry() external view returns (address) {
        return address(identityRegistry);
    }

    int128 private constant MAX_ABS_VALUE = 1e38;

    // agentId => clientAddress => feedbackIndex => Feedback (1-indexed)
    mapping(
        uint256 => mapping(address => mapping(uint64 => IERC8004ReputationRegistry.Feedback))
    ) internal _feedback;
    mapping(uint256 => mapping(address => uint64)) internal _lastIndex;
    mapping(uint256 => address[]) internal _clients;
    mapping(uint256 => mapping(address => bool)) internal _clientExists;

    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    constructor(IERC8004IdentityRegistry identity_) {
        identityRegistry = identity_;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        require(valueDecimals <= 18, "too many decimals");
        require(value >= -MAX_ABS_VALUE && value <= MAX_ABS_VALUE, "value too large");
        identityRegistry.ownerOf(agentId); // reverts "nonexistent token" like the reference
        // SECURITY: prevent self-feedback from owner and operators
        require(
            !identityRegistry.isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not allowed"
        );
        uint64 currentIndex = ++_lastIndex[agentId][msg.sender];
        _feedback[agentId][msg.sender][currentIndex] = IERC8004ReputationRegistry.Feedback({
            value: value, valueDecimals: valueDecimals, tag1: tag1, tag2: tag2, isRevoked: false
        });

        if (!_clientExists[agentId][msg.sender]) {
            _clients[agentId].push(msg.sender);
            _clientExists[agentId][msg.sender] = true;
        }

        _emitNewFeedback(
            agentId,
            currentIndex,
            value,
            valueDecimals,
            tag1,
            tag2,
            endpoint,
            feedbackURI,
            feedbackHash
        );
    }

    /// @dev Separate frame: keeps giveFeedback under the stack limit while
    ///      emitting the exact canonical event shape.
    function _emitNewFeedback(
        uint256 agentId,
        uint64 currentIndex,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) internal {
        emit NewFeedback(
            agentId,
            msg.sender,
            currentIndex,
            value,
            valueDecimals,
            tag1,
            tag1,
            tag2,
            endpoint,
            feedbackURI,
            feedbackHash
        );
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        require(feedbackIndex > 0, "index must be > 0");
        require(feedbackIndex <= _lastIndex[agentId][msg.sender], "index out of bounds");
        IERC8004ReputationRegistry.Feedback storage fb =
            _feedback[agentId][msg.sender][feedbackIndex];
        require(!fb.isRevoked, "already revoked");
        fb.isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function appendResponse(
        uint256 agentId,
        uint64 feedbackIndex,
        address responder,
        string calldata responseURI,
        bytes32 responseHash
    ) external {
        require(feedbackIndex > 0, "index must be > 0");
        require(feedbackIndex <= _lastIndex[agentId][msg.sender], "index out of bounds");
        emit ResponseAppended(
            agentId, msg.sender, feedbackIndex, responder, responseURI, responseHash
        );
    }

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (
            int128 value,
            uint8 valueDecimals,
            string memory tag1,
            string memory tag2,
            bool isRevoked
        )
    {
        require(feedbackIndex > 0, "index must be > 0");
        require(feedbackIndex <= _lastIndex[agentId][clientAddress], "index out of bounds");
        Feedback storage f = _feedback[agentId][clientAddress][feedbackIndex];
        return (f.value, f.valueDecimals, f.tag1, f.tag2, f.isRevoked);
    }

    /// @dev Faithful average: sum(value * 10^(18 - decimals)) in WAD, then
    ///      summaryValue = (sum / count) / 10^(18 - modeDecimals), returned
    ///      at the mode decimals. Integer truncation matches the reference.
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) {
        require(clientAddresses.length > 0, "clientAddresses required");
        (count, summaryValue, summaryValueDecimals) =
            _accumulate(agentId, clientAddresses, tag1, tag2);
    }

    /// @dev Argument bundle for the accumulation pass: one memory struct
    ///      instead of three live locals keeps every frame shallow (no-ir).
    struct Acc {
        int256 sum; // WAD-normalized
        uint64 count;
        uint64[19] decimalCounts;
    }

    /// @dev WAD-normalized accumulation + mode-decimals rescale, split out
    ///      to keep the outer frame under the stack limit (0.8.30 no-ir).
    function _accumulate(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) internal view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) {
        Acc memory acc;

        for (uint256 i; i < clientAddresses.length; i++) {
            _accumulateClient(agentId, clientAddresses[i], tag1, tag2, acc);
        }

        if (acc.count == 0) return (0, 0, 0);

        (summaryValue, summaryValueDecimals) = _finalize(acc.sum, acc.count, acc.decimalCounts);
        count = acc.count;
    }

    /// @dev Accumulate one client's non-revoked, tag-matching entries INTO
    ///      the shared accumulator (memory structs are passed by reference).
    function _accumulateClient(
        uint256 agentId,
        address client,
        string calldata tag1,
        string calldata tag2,
        Acc memory acc
    ) internal view {
        uint64 lastIdx = _lastIndex[agentId][client];
        for (uint64 j = 1; j <= lastIdx; j++) {
            Feedback storage fb = _feedback[agentId][client][j];
            if (fb.isRevoked) continue;
            if (!_matchesTags(tag1, tag2, fb.tag1, fb.tag2)) continue;

            acc.sum += fb.value * int256(10 ** (18 - fb.valueDecimals));
            acc.count++;
            acc.decimalCounts[fb.valueDecimals]++;
        }
    }

    function _finalize(int256 sum, uint64 count, uint64[19] memory decimalCounts)
        internal
        pure
        returns (int128 summaryValue, uint8 summaryValueDecimals)
    {
        uint8 modeDecimals;
        uint64 maxCount;
        for (uint8 d; d <= 18; d++) {
            if (decimalCounts[d] > maxCount) {
                maxCount = decimalCounts[d];
                modeDecimals = d;
            }
        }

        int256 avgWad = sum / int256(uint256(count));
        summaryValue = int128(avgWad / int256(10 ** (18 - modeDecimals)));
        summaryValueDecimals = modeDecimals;
    }

    /// @dev Canonical tag-match rule: an empty-string filter matches
    ///      everything (only a non-empty filter is compared).
    function _matchesTags(
        string memory tag1Filter,
        string memory tag2Filter,
        string storage fbTag1,
        string storage fbTag2
    ) internal pure returns (bool) {
        if (
            bytes(tag1Filter).length > 0 && keccak256(bytes(tag1Filter)) != keccak256(bytes(fbTag1))
        ) return false;
        if (
            bytes(tag2Filter).length > 0 && keccak256(bytes(tag2Filter)) != keccak256(bytes(fbTag2))
        ) return false;
        return true;
    }

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
        )
    {
        (
            clients, feedbackIndexes, values, valueDecimals, tag1s, tag2s, revokedStatuses
        ) = _readAllFeedbackEntry(agentId, clientAddresses, tag1, tag2, includeRevoked);
    }

    /// @dev Entry frame: builds the query, then hands off to the filler.
    function _readAllFeedbackEntry(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2,
        bool includeRevoked
    )
        internal
        view
        returns (
            address[] memory,
            uint64[] memory,
            int128[] memory,
            uint8[] memory,
            string[] memory,
            string[] memory,
            bool[] memory
        )
    {
        Query memory q;
        q.agentId = agentId;
        q.tag1 = tag1;
        q.tag2 = tag2;
        q.includeRevoked = includeRevoked;
        if (clientAddresses.length > 0) {
            q.clients = clientAddresses;
        } else {
            q.clients = _clients[q.agentId];
        }
        return _fillPacked(q);
    }

    /// @dev Argument bundle: packing the query args into one struct keeps
    ///      every downstream frame's stack shallow under no-ir.
    struct Query {
        uint256 agentId;
        address[] clients;
        string tag1;
        string tag2;
        bool includeRevoked;
    }

    /// @dev Single packed frame: count then fill (see Query, _fill).
    function _fillPacked(Query memory q)
        internal
        view
        returns (
            address[] memory,
            uint64[] memory,
            int128[] memory,
            uint8[] memory,
            string[] memory,
            string[] memory,
            bool[] memory
        )
    {
        return _fill(q);
    }

    /// @dev Count pass over the packed query.
    function _countMatchesPacked(Query memory q) internal view returns (uint256 totalCount) {
        for (uint256 i; i < q.clients.length; i++) {
            uint64 lastIdx = _lastIndex[q.agentId][q.clients[i]];
            for (uint64 j = 1; j <= lastIdx; j++) {
                IERC8004ReputationRegistry.Feedback storage fb =
                    _feedback[q.agentId][q.clients[i]][j];
                if (!q.includeRevoked && fb.isRevoked) continue;
                if (!_matchesTags(q.tag1, q.tag2, fb.tag1, fb.tag2)) continue;
                totalCount++;
            }
        }
    }

    /// @dev Second pass: fill the seven result arrays over the packed query.
    function _fill(Query memory q)
        internal
        view
        returns (
            address[] memory clients,
            uint64[] memory feedbackIndexes,
            int128[] memory values,
            uint8[] memory valueDecimals,
            string[] memory tag1s,
            string[] memory tag2s,
            bool[] memory revokedStatuses
        )
    {
        uint256 totalCount = _countMatchesPacked(q);
        clients = new address[](totalCount);
        feedbackIndexes = new uint64[](totalCount);
        values = new int128[](totalCount);
        valueDecimals = new uint8[](totalCount);
        tag1s = new string[](totalCount);
        tag2s = new string[](totalCount);
        revokedStatuses = new bool[](totalCount);

        uint256 k;
        for (uint256 i; i < q.clients.length; i++) {
            uint64 lastIdx = _lastIndex[q.agentId][q.clients[i]];
            for (uint64 j = 1; j <= lastIdx; j++) {
                IERC8004ReputationRegistry.Feedback storage fb =
                    _feedback[q.agentId][q.clients[i]][j];
                if (!q.includeRevoked && fb.isRevoked) continue;
                if (!_matchesTags(q.tag1, q.tag2, fb.tag1, fb.tag2)) continue;
                clients[k] = q.clients[i];
                feedbackIndexes[k] = j;
                values[k] = fb.value;
                valueDecimals[k] = fb.valueDecimals;
                tag1s[k] = fb.tag1;
                tag2s[k] = fb.tag2;
                revokedStatuses[k] = fb.isRevoked;
                k++;
            }
        }
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return _lastIndex[agentId][clientAddress];
    }
}
