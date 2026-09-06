// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev MutualPool as seen by VerdictContract (payout authority).
interface IMutualPool {
    function payout(address claimant, uint96 amount, bytes32 digest) external;

    function juniorCapital() external view returns (uint256);

    function seniorCapital() external view returns (uint256);
}
