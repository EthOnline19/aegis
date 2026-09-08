// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    IERC8004ValidationRegistry
} from "../../src/interfaces/erc8004/IERC8004ValidationRegistry.sol";
import {
    IERC8004IdentityRegistry
} from "../../src/interfaces/erc8004/IERC8004IdentityRegistry.sol";

/// @title ERC-8004 Validation Registry mock (reference replica).
/// @notice Replicates the canonical v2.0.0 auth triangle and one-time write
///         semantics BULWARK's orchestrator depends on:
///         - validationRequest: caller must be owner / approved-operator of
///           the agentId NFT; requestHash globally unique ("exists").
///         - validationResponse: msg.sender must equal the request's
///           validatorAddress ("not validator"); response <= 100 ("resp>100");
///           first answer is final — no update path.
contract ERC8004ValidationMock is IERC8004ValidationRegistry {
    IERC8004IdentityRegistry public immutable identityRegistry;

    /// @dev Interface completeness: cross-link back to the identity registry.
    function getIdentityRegistry() external view returns (address) {
        return address(identityRegistry);
    }

    mapping(bytes32 => ValidationStatus) internal _validations;
    mapping(uint256 => bytes32[]) internal _agentValidations;
    mapping(address => bytes32[]) internal _validatorRequests;

    error UnknownRequest();

    constructor(IERC8004IdentityRegistry identity_) {
        identityRegistry = identity_;
    }

    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        require(validatorAddress != address(0), "bad validator");
        require(_validations[requestHash].validatorAddress == address(0), "exists");

        address owner = identityRegistry.ownerOf(agentId);
        require(
            msg.sender == owner || identityRegistry.isApprovedForAll(owner, msg.sender)
                || identityRegistry.getApproved(agentId) == msg.sender,
            "Not authorized"
        );

        _validations[requestHash] = ValidationStatus({
            validatorAddress: validatorAddress,
            agentId: agentId,
            response: 0,
            responseHash: bytes32(0),
            tag: "",
            lastUpdate: block.timestamp,
            hasResponse: false
        });

        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);

        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        ValidationStatus storage s = _validations[requestHash];
        require(s.validatorAddress != address(0), "unknown");
        require(msg.sender == s.validatorAddress, "not validator");
        require(response <= 100, "resp>100");
        s.response = response;
        s.responseHash = responseHash;
        s.tag = tag;
        s.lastUpdate = block.timestamp;
        s.hasResponse = true;
        emit ValidationResponse(
            s.validatorAddress, s.agentId, requestHash, response, responseURI, responseHash, tag
        );
    }

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
        )
    {
        ValidationStatus storage s = _validations[requestHash];
        if (s.validatorAddress == address(0)) revert UnknownRequest();
        return (s.validatorAddress, s.agentId, s.response, s.responseHash, s.tag, s.lastUpdate);
    }

    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse)
    {
        bytes32[] storage requestHashes = _agentValidations[agentId];
        uint256 totalResponse;

        for (uint256 i; i < requestHashes.length; i++) {
            ValidationStatus storage s = _validations[requestHashes[i]];

            bool matchValidator = (validatorAddresses.length == 0);
            if (!matchValidator) {
                for (uint256 j; j < validatorAddresses.length; j++) {
                    if (s.validatorAddress == validatorAddresses[j]) {
                        matchValidator = true;
                        break;
                    }
                }
            }

            bool matchTag =
                (bytes(tag).length == 0) || (keccak256(bytes(s.tag)) == keccak256(bytes(tag)));

            if (matchValidator && matchTag && s.hasResponse) {
                totalResponse += s.response;
                count++;
            }
        }

        avgResponse = count > 0 ? uint8(totalResponse / count) : 0;
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    function getValidatorRequests(address validatorAddress)
        external
        view
        returns (bytes32[] memory)
    {
        return _validatorRequests[validatorAddress];
    }
}
