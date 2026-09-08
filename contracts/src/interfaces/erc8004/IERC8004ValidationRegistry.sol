// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ERC-8004 Validation Registry interface (v2.0.0).
/// @notice Minimal surface copied from the canonical reference
///         implementation (erc-8004/erc-8004-contracts,
///         ValidationRegistryUpgradeable.sol, MIT). Auth semantics that
///         drive the design: `validationRequest` requires the caller to be
///         owner/approved-operator of the agentId NFT; `validationResponse`
///         requires `msg.sender == validatorAddress` (named in the request);
///         writes are one-time ("exists" / first-answer-final).
interface IERC8004ValidationRegistry {
    /// @param validatorAddress Address that will be allowed to respond.
    /// @param agentId Agent identity NFT being validated.
    /// @param requestURI Off-chain description of what is being validated.
    /// @param requestHash Caller-chosen commitment; globally unique —
    ///        reverts "exists" on reuse.
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external;

    /// @notice First answer is final (no update path in the reference).
    /// @param response 0..100 — reverts "resp>100" above 100.
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;

    struct ValidationStatus {
        address validatorAddress;
        uint256 agentId;
        uint8 response; // 0..100
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
        bool hasResponse;
    }

    /// @notice Reverts "unknown" for a requestHash never registered.
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        );

    /// @notice Average response over answered validations. Empty
    ///         `validatorAddresses` = all validators; empty `tag` = no
    ///         filter. Returns (count, avg) — count of hasResponse entries.
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse);

    /// @notice All requestHashes ever submitted for an agent (answered or not).
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory);

    /// @notice All requestHashes addressed to a validator.
    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory);

    /// @notice Identity registry this validation registry is cross-linked to.
    function getIdentityRegistry() external view returns (address);

    event ValidationRequest(
        address indexed validatorAddress,
        uint256 indexed agentId,
        string requestURI,
        bytes32 indexed requestHash
    );

    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );
}
