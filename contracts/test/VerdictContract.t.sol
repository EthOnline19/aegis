// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BulwarkTest} from "./BulwarkTest.t.sol";
import {BulwarkTypes} from "../src/BulwarkTypes.sol";
import {VerdictContract} from "../src/VerdictContract.sol";

/// @title VerdictContract adjudication tests.
/// @notice Plan Cases 5–7: the same-block payout, the fraud denial (alibi),
///         and the wrongful-verdict appeal.
contract VerdictContractTest is BulwarkTest {
    function test_CoveredVerdictPaysSameTx() public {
        // Case 5: look-alike attack slipped through; $150 lost, $135 payout.
        uint256 amaraBefore = usdc.balanceOf(amara);
        uint256 juniorBefore = pool.juniorCapital();

        BulwarkTypes.Verdict memory v = _coveredVerdict(
            bytes32(uint256(0xA11CE)), attacker, 150e6, 135e6
        );
        _submitVerdict(v);

        assertEq(usdc.balanceOf(amara), amaraBefore + 135e6, "payout lands same tx");
        assertEq(pool.juniorCapital(), juniorBefore - 135e6, "junior absorbs first");
    }

    function test_DoubleClaimBlocked() public {
        BulwarkTypes.Verdict memory v = _coveredVerdict(bytes32(uint256(0xA11CE)), attacker, 150e6, 135e6);
        _submitVerdict(v);

        // Same txHash again → rejected (nullifier consumed). Sign BEFORE the
        // prank: _sigFor's digest staticcall would consume it.
        bytes memory sig = _sigFor(v);
        vm.prank(vm.addr(watcherPk));
        vm.expectRevert(VerdictContract.DuplicateClaim.selector);
        verdicts.submitVerdict(v, sig);
    }

    function test_PayoutCannotExceedCap() public {
        BulwarkTypes.Verdict memory v =
            _coveredVerdict(bytes32(uint256(0xBEEF)), attacker, 2500e6, 2501e6);
        bytes memory sig = _sigFor(v);
        vm.prank(vm.addr(watcherPk));
        vm.expectRevert(VerdictContract.PayoutExceedsCap.selector);
        verdicts.submitVerdict(v, sig);
    }

    function test_DeductibleMathEnforced() public {
        // $150 loss, 10% deductible → payout must be ≤ $135. A greedy payout
        // of $149 fails: 149 + 14.9 = 163.9 > 150.
        BulwarkTypes.Verdict memory v =
            _coveredVerdict(bytes32(uint256(0xCAFE)), attacker, 150e6, 149e6);
        bytes memory sig = _sigFor(v);
        vm.prank(vm.addr(watcherPk));
        vm.expectRevert(VerdictContract.PayoutExceedsLoss.selector);
        verdicts.submitVerdict(v, sig);
    }

    function test_FraudulentOwnerDenied() public {
        // Case 6: Nuno's own instruction, owner-signed → DENIED, no payout.
        uint256 amaraBefore = usdc.balanceOf(amara);

        BulwarkTypes.Verdict memory v = _coveredVerdict(bytes32(uint256(0xF2A0D)), bob, 1800e6, 1620e6);
        v.alibi = uint8(BulwarkTypes.Alibi.OWNER_SIGNED);
        v.outcome = uint8(BulwarkTypes.Outcome.DENIED_OWNER_ORIGIN);
        v.payoutAmount = 0;
        _submitVerdict(v);

        assertEq(usdc.balanceOf(amara), amaraBefore, "owner-origin claims pay nothing");
    }

    function test_CoveredRequiresExternalAlibi() public {
        // COVERED outcome with owner-signed alibi → contradictory → reject.
        BulwarkTypes.Verdict memory v = _coveredVerdict(bytes32(uint256(0xBAD1)), attacker, 100e6, 90e6);
        v.alibi = uint8(BulwarkTypes.Alibi.OWNER_SIGNED);
        bytes memory sig = _sigFor(v);
        vm.prank(vm.addr(watcherPk));
        vm.expectRevert(VerdictContract.OutcomeMismatch.selector);
        verdicts.submitVerdict(v, sig);
    }

    function test_StaleVerdictRejected() public {
        BulwarkTypes.Verdict memory v = _coveredVerdict(bytes32(uint256(0x01D)), attacker, 100e6, 90e6);
        bytes memory sig = _sigFor(v);
        vm.warp(block.timestamp + 601); // beyond 600s freshness
        vm.prank(vm.addr(watcherPk));
        vm.expectRevert(VerdictContract.StaleVerdict.selector);
        verdicts.submitVerdict(v, sig);
    }

    function test_ForgedSignatureRejected() public {
        BulwarkTypes.Verdict memory v = _coveredVerdict(bytes32(uint256(0xFA7E)), attacker, 100e6, 90e6);
        // Sign with a different key over the SAME EIP-712 digest.
        uint256 forgerPk = 0xBAD;
        bytes32 digest = verdicts.verdictDigest712(v);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(forgerPk, digest);
        bytes memory sig = abi.encodePacked(r, s, sv);

        vm.prank(vm.addr(watcherPk));
        vm.expectRevert(VerdictContract.BadSignature.selector);
        verdicts.submitVerdict(v, sig);
    }

    function test_NonWatcherCannotSubmit() public {
        BulwarkTypes.Verdict memory v = _coveredVerdict(bytes32(uint256(0xE7E)), attacker, 100e6, 90e6);
        bytes memory sig = _sigFor(v);
        vm.prank(attacker);
        vm.expectRevert(VerdictContract.NotWatcher.selector);
        verdicts.submitVerdict(v, sig);
    }

    function test_ClaimantMustBePolicyOwner() public {
        BulwarkTypes.Verdict memory v = _coveredVerdict(bytes32(uint256(0x741EF)), attacker, 100e6, 90e6);
        v.claimant = attacker; // not the owner
        bytes memory sig = _sigFor(v);
        vm.prank(vm.addr(watcherPk));
        vm.expectRevert(VerdictContract.AgentMismatch.selector);
        verdicts.submitVerdict(v, sig);
    }

    function test_AttemptedBreachSignalsPricing() public {
        // Case 3/4 aftermath: blocked attack → ATTEMPTED_BREACH + blocklist strike.
        BulwarkTypes.Verdict memory v = _coveredVerdict(bytes32(uint256(0xA77)), freshWallet, 900e6, 0);
        v.outcome = uint8(BulwarkTypes.Outcome.ATTEMPTED_BREACH);
        v.payoutAmount = 0;
        v.alibi = uint8(BulwarkTypes.Alibi.EXTERNAL);
        BulwarkTypes.Reason[] memory reasons = new BulwarkTypes.Reason[](1);
        reasons[0] = BulwarkTypes.Reason({
            tag: bytes4(keccak256("ON_BLOCKLIST")),
            provenance: uint8(BulwarkTypes.Provenance.VERIFIED),
            detail: "destination on shared blocklist"
        });
        v.reasons = reasons;
        _submitVerdict(v);

        assertEq(blocklist.strikes(freshWallet), 1, "strike recorded fleet-wide");
    }

    function test_DisputeRerunAndArbitration() public {
        // Case 7 (v1 scope): wrongful verdict → dispute → re-run window.
        // Staked arbitration is v2 — escalate()/concludeArbitration() must
        // fail loudly (NotImplementedInV1) and accept no ETH.
        BulwarkTypes.Verdict memory v = _coveredVerdict(bytes32(uint256(0x2A046)), carol, 120e6, 108e6);
        _submitVerdict(v);

        bytes32 digest = verdicts.verdictDigest712(v);
        verdicts.dispute(digest);

        (, address opener,) = _disputeOf(digest);
        assertEq(opener, address(this));

        verdicts.requestRerun(digest);

        // Escalation: cleanly rejected, no ETH accepted.
        uint256 balBefore = address(verdicts).balance;
        vm.expectRevert(VerdictContract.NotImplementedInV1.selector);
        verdicts.escalate{value: 1 ether}(digest);
        assertEq(address(verdicts).balance, balBefore, "no ETH accepted");

        vm.expectRevert(VerdictContract.NotImplementedInV1.selector);
        verdicts.concludeArbitration(digest, true);
    }

    function _sigFor(BulwarkTypes.Verdict memory v) internal view returns (bytes memory) {
        bytes32 digest = verdicts.verdictDigest712(v);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(watcherPk, digest);
        return abi.encodePacked(r, s, sv);
    }

    function _disputeOf(bytes32 digest)
        internal
        view
        returns (VerdictContract.DisputeState state, address opener, uint256 openedAt)
    {
        (state, opener, openedAt) = verdicts.disputes(digest);
    }
    receive() external payable {}
}
