// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BulwarkTypes} from "../BulwarkTypes.sol";

/// @dev PolicyRegistry as seen by GuardAccount / VerdictContract.
interface IPolicyRegistry {
    function getPolicy(address agent) external view returns (BulwarkTypes.Policy memory);

    function policyHashAt(address agent, uint32 version) external view returns (bytes32);

    function latestVersion(address agent) external view returns (uint32);
}
