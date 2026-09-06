// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev GuardAccount as seen by VerdictContract (hold-release authority).
interface IGuardAccount {
    function releaseHold(uint256 holdId) external;

    function freezeHold(uint256 holdId) external;
}
