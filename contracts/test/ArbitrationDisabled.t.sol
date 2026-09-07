// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BulwarkTest} from "./BulwarkTest.t.sol";
import {BulwarkTypes} from "../src/BulwarkTypes.sol";
import {VerdictContract} from "../src/VerdictContract.sol";

/// @title Arbitration is v2 — v1 must fail loudly, not half-work (review C3).
/// @notice The old escalate/concludeArbitration path was exploitable
///         (single-arbiter conclusion, no quorum, anyone could add stake to
///         anyone's dispute, ETH stranded on uphold) and is NOT on the demo
///         path. v1 replaces it with clean reverts: nothing can be escrowed,
///         so nothing can be stranded or stolen.
contract ArbitrationDisabledTest is BulwarkTest {
    function test_EscalateRevertsCleanly() public {
        BulwarkTypes.Verdict memory v =
            _coveredVerdict(bytes32(uint256(0x2A046)), carol, 120e6, 108e6);
        _submitVerdict(v);
        bytes32 digest = verdicts.verdictDigest712(v);

        vm.expectRevert(VerdictContract.NotImplementedInV1.selector);
        verdicts.escalate{value: 1 ether}(digest);
    }

    function test_EscalateRevertsEvenWithNoValue() public {
        BulwarkTypes.Verdict memory v =
            _coveredVerdict(bytes32(uint256(0x2A047)), carol, 120e6, 108e6);
        _submitVerdict(v);
        bytes32 digest = verdicts.verdictDigest712(v);

        vm.expectRevert(VerdictContract.NotImplementedInV1.selector);
        verdicts.escalate(digest);
    }

    function test_ConcludeArbitrationRevertsCleanly() public {
        vm.expectRevert(VerdictContract.NotImplementedInV1.selector);
        verdicts.concludeArbitration(bytes32(uint256(0xDEAD)), true);
    }

    /// @dev No ETH can enter the contract through the arbitration path.
    function test_NoEthStrandedViaEscalation() public {
        BulwarkTypes.Verdict memory v =
            _coveredVerdict(bytes32(uint256(0x2A048)), carol, 120e6, 108e6);
        _submitVerdict(v);
        bytes32 digest = verdicts.verdictDigest712(v);

        uint256 balBefore = address(verdicts).balance;
        vm.expectRevert(VerdictContract.NotImplementedInV1.selector);
        verdicts.escalate{value: 1 ether}(digest);
        assertEq(address(verdicts).balance, balBefore, "no ETH accepted");
    }
}
