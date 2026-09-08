// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ERC-8004 Identity Registry interface (v2.0.0).
/// @notice Minimal surface copied from the canonical reference
///         implementation (erc-8004/erc-8004-contracts,
///         IdentityRegistryUpgradeable.sol, MIT). Only what BULWARK's
///         off-chain orchestrator and consumers call; BULWARK contracts
///         never reference ERC-8004 (design: docs/ERC8004_DESIGN.md §1).
interface IERC8004IdentityRegistry {
    /// @notice Mint a new agent identity NFT; caller becomes owner.
    ///         The reference also records the caller as the initial
    ///         agentWallet.
    function register(string calldata agentURI) external returns (uint256 agentId);

    /// @notice Update the agent's metadata URI. Owner/operator only.
    function setAgentURI(uint256 agentId, string calldata newURI) external;

    /// @notice Arbitrary metadata key/value. Owner/operator only;
    ///         the "agentWallet" key is reserved (registry-managed).
    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue)
        external;

    /// @notice Read arbitrary metadata. Returns "" for unknown keys.
    function getMetadata(uint256 agentId, string calldata metadataKey)
        external
        view
        returns (bytes memory);

    /// @notice Bind (or rebind) the on-chain agent wallet. Requires a
    ///         signature from `newWallet` (ECDSA or ERC-1271) over
    ///         `AgentWalletSet(agentId, newWallet, owner, deadline)` with
    ///         the registry's EIP-712 domain, and
    ///         `deadline <= now + 5 minutes` on-chain.
    function setAgentWallet(
        uint256 agentId,
        address newWallet,
        uint256 deadline,
        bytes calldata signature
    ) external;

    /// @notice Clear the agent wallet binding. Owner/operator only.
    function unsetAgentWallet(uint256 agentId) external;

    /// @notice Current agent wallet (address(0) when unset/transferred).
    function getAgentWallet(uint256 agentId) external view returns (address);

    /// @notice ERC-721 single-token approval (part of the auth triangle:
    ///         validationRequest callers, isAuthorizedOrOwner semantics).
    function getApproved(uint256 agentId) external view returns (address);

    /// @notice ERC-721 operator approval (part of the auth triangle).
    function isApprovedForAll(address owner, address operator) external view returns (bool);

    /// @notice ERC-721 owner of the agent identity NFT.
    function ownerOf(uint256 agentId) external view returns (address);

    /// @notice True if `spender` is the owner, approved for the token, or
    ///         approved for all. Drives the reputation self-feedback guard.
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);
}
