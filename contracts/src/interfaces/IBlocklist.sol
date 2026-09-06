// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Blocklist as seen by GuardAccount and the Watcher.
interface IBlocklist {
    function isFlagged(address destination) external view returns (bool);

    function hasAnyStrike(address destination) external view returns (bool);

    function strikes(address destination) external view returns (uint8);

    function report(address destination, bytes32 evidence) external;
}
