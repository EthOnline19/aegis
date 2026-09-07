// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev GuardAccount as seen by VerdictContract (hold-release authority).
interface IGuardAccount {
    function releaseHold(uint256 holdId) external;

    function freezeHold(uint256 holdId) external;
}

/// @dev GuardAccount as seen by PolicyRegistry (ownership authority).
///      Used for first-attach authorization: the registry consults the
///      account's immutable OWNER rather than trusting calldata.
interface IGuardAccountOwner {
    function OWNER() external view returns (address);
}
