// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    IERC8004IdentityRegistry
} from "../../src/interfaces/erc8004/IERC8004IdentityRegistry.sol";

/// @title ERC-8004 Identity Registry mock (reference replica).
/// @notice Faithful to the canonical v2.0.0 semantics BULWARK depends on:
///         caller becomes owner + initial agentWallet; `agentWallet` is a
///         reserved metadata key managed only via setAgentWallet; the
///         EIP-712/1271 wallet-signature check is replicated (BULWARK's
///         valid-binding check reads getAgentWallet, so the mock verifies
///         signatures like production rather than rubber-stamping).
contract ERC8004IdentityMock is IERC8004IdentityRegistry {
    uint256 internal _lastId;

    // agentId => key => value
    mapping(uint256 => mapping(string => bytes)) internal _metadata;
    mapping(uint256 => address) internal _owners;
    // ERC-721 approvals (isAuthorizedOrOwner semantics)
    mapping(uint256 => address) internal _approved;
    mapping(address => mapping(address => bool)) internal _approvedForAll;

    bytes32 public constant AGENT_WALLET_SET_TYPEHASH = keccak256(
        "AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"
    );
    uint256 public constant MAX_DEADLINE_DELAY = 5 minutes;

    string public domainName = "ERC8004IdentityRegistry";
    string public domainVersion = "1";

    function _isAuthorized(address owner, address spender, uint256 agentId)
        internal
        view
        returns (bool)
    {
        return spender != address(0) && spender == owner || spender == _approved[agentId]
            || _approvedForAll[owner][spender];
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        address owner = _owners[agentId];
        return spender == owner || _isAuthorized(owner, spender, agentId);
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = ++_lastId;
        _owners[agentId] = msg.sender;
        _metadata[agentId]["agentWallet"] = abi.encodePacked(msg.sender);
        _metadata[agentId]["agentURI"] = bytes(agentURI);
    }

    function ownerOf(uint256 agentId) public view returns (address) {
        address owner = _owners[agentId];
        require(owner != address(0), "nonexistent token");
        return owner;
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        address owner = ownerOf(agentId);
        require(_isAuthorized(owner, msg.sender, agentId), "Not authorized");
        _metadata[agentId]["agentURI"] = bytes(newURI);
    }

    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue)
        external
    {
        address owner = ownerOf(agentId);
        require(_isAuthorized(owner, msg.sender, agentId), "Not authorized");
        require(keccak256(bytes(metadataKey)) != keccak256(bytes("agentWallet")), "reserved key");
        _metadata[agentId][metadataKey] = metadataValue;
    }

    function getMetadata(uint256 agentId, string calldata metadataKey)
        external
        view
        returns (bytes memory)
    {
        return _metadata[agentId][metadataKey];
    }

    /// @dev Digest over `AgentWalletSet(agentId, newWallet, owner, deadline)`
    ///      with domain {name, version, chainId, verifyingContract} = this
    ///      mock — mirrors the reference `_hashTypedDataV4`.
    function agentWalletSetDigest(
        uint256 agentId,
        address newWallet,
        address owner,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, owner, deadline)
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(domainName)),
                keccak256(bytes(domainVersion)),
                block.chainid,
                address(this)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function setAgentWallet(
        uint256 agentId,
        address newWallet,
        uint256 deadline,
        bytes calldata signature
    ) external {
        address owner = ownerOf(agentId);
        require(_isAuthorized(owner, msg.sender, agentId), "Not authorized");
        require(newWallet != address(0), "bad wallet");
        require(block.timestamp <= deadline, "expired");
        require(deadline <= block.timestamp + MAX_DEADLINE_DELAY, "deadline too far");

        bytes32 digest = agentWalletSetDigest(agentId, newWallet, owner, deadline);
        // ECDSA recovery like the reference (ERC-1271 omitted: BULWARK's
        // guard accounts are EOAs in every supported path; the valid-binding
        // check consumes getAgentWallet, not the signature path).
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        address recovered = ecrecover(digest, uint8(signature[64]), r, s);
        require(recovered == newWallet, "invalid wallet sig");

        _metadata[agentId]["agentWallet"] = abi.encodePacked(newWallet);
    }

    function unsetAgentWallet(uint256 agentId) external {
        address owner = ownerOf(agentId);
        require(_isAuthorized(owner, msg.sender, agentId), "Not authorized");
        delete _metadata[agentId]["agentWallet"];
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        bytes memory walletData = _metadata[agentId]["agentWallet"];
        if (walletData.length < 20) return address(0);
        return address(bytes20(walletData));
    }

    // --- approval plumbing (needed by the validation/reputation mocks' auth
    //     triangle via isAuthorizedOrOwner; mirrors ERC-721 approve/setApprovalForAll)

    function approve(uint256 agentId, address to) external {
        address owner = ownerOf(agentId);
        require(msg.sender == owner || _approvedForAll[owner][msg.sender], "not authorized");
        _approved[agentId] = to;
    }

    function setApprovalForAll(address operator, bool approved_) external {
        _approvedForAll[msg.sender][operator] = approved_;
    }

    function getApproved(uint256 agentId) external view returns (address) {
        return _approved[agentId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _approvedForAll[owner][operator];
    }
}
