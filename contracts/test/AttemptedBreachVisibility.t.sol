// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BulwarkTest} from "./BulwarkTest.t.sol";
import {BulwarkTypes} from "../src/BulwarkTypes.sol";
import {GuardAccount} from "../src/GuardAccount.sol";
import {VerdictContract} from "../src/VerdictContract.sol";

/// @title Attempted-breach visibility + tag parity (review H4).
/// @notice (a) The VIOLATION lane emits Classified/ViolationBlocked/
///         AttemptedBreach and then reverts — the events never persist, so
///         the subgraph and pricing flywheel have NO on-chain data for
///         blocked attacks. (b) The contract's drainer tag constant
///         ("DRANER_SIGNATURE") never matches the engine's
///         "DRAINER_SIGNATURE" — drainer verdicts record no blocklist
contract AttemptedBreachVisibilityTest is BulwarkTest {
    /// @dev (a) A blocked VIOLATION attempt must persist on-chain. propose()
    ///      reverts (state writes in a reverting tx never persist), so the
    ///      durable record is the non-reverting reportAttempt() relay: the
    ///      counter + events survive for the subgraph and pricing engine.
    function test_BlockedAttemptPersistedOnChain() public {
        uint256 before = guard.attemptedBreaches();

        // The agent attempts a $900 transfer — over the $200 cap → revert.
        vm.prank(atlasKey);
        vm.expectRevert();
        guard.propose(address(usdc), attacker, 900e6);

        // The reverted tx's events died; the relay persists the fact.
        vm.prank(attacker); // anyone may relay the public fact
        guard.reportAttempt(attacker, 900e6, bytes4(keccak256("OVER_PER_TX")));

        assertGt(
            guard.attemptedBreaches(),
            before,
            "blocked attempt must persist on-chain despite the revert"
        );
    }

    /// @dev The revert itself is unchanged: the violation lane still blocks.
    function test_ViolationStillReverts() public {
        vm.prank(atlasKey);
        vm.expectRevert(
            abi.encodeWithSelector(GuardAccount.Violation.selector, bytes4(keccak256("OVER_PER_TX")))
        );
        guard.propose(address(usdc), attacker, 900e6);
    }



    /// @dev (b) A drainer-signature ATTEMPTED_BREACH verdict must record a
    ///      blocklist strike — today the tag typo means it never does.
    function test_DrainerVerdictRecordsStrike() public {
        BulwarkTypes.Verdict memory v =
            _coveredVerdict(bytes32(uint256(0xD12)), freshWallet, 900e6, 0);
        v.outcome = uint8(BulwarkTypes.Outcome.ATTEMPTED_BREACH);
        v.payoutAmount = 0;
        v.alibi = uint8(BulwarkTypes.Alibi.EXTERNAL);
        BulwarkTypes.Reason[] memory reasons = new BulwarkTypes.Reason[](1);
        reasons[0] = BulwarkTypes.Reason({
            tag: bytes4(keccak256("DRAINER_SIGNATURE")),
            provenance: uint8(BulwarkTypes.Provenance.VERIFIED),
            detail: "calldata matches known drainer pattern"
        });
        v.reasons = reasons;

        _submitVerdict(v);
        assertEq(blocklist.strikes(freshWallet), 1, "drainer verdict must strike the destination");
    }

    /// @dev (c) A drainer reason at position 1 (not 0) must still strike.
    function test_DrainerReasonAnyPositionStrikes() public {
        BulwarkTypes.Verdict memory v =
            _coveredVerdict(bytes32(uint256(0xD13)), freshWallet, 900e6, 0);
        v.outcome = uint8(BulwarkTypes.Outcome.ATTEMPTED_BREACH);
        v.payoutAmount = 0;
        v.alibi = uint8(BulwarkTypes.Alibi.EXTERNAL);
        BulwarkTypes.Reason[] memory reasons = new BulwarkTypes.Reason[](2);
        reasons[0] = BulwarkTypes.Reason({
            tag: bytes4(keccak256("NEW_RECIPIENT")),
            provenance: uint8(BulwarkTypes.Provenance.VERIFIED),
            detail: "first transfer to this wallet"
        });
        reasons[1] = BulwarkTypes.Reason({
            tag: bytes4(keccak256("DRAINER_SIGNATURE")),
            provenance: uint8(BulwarkTypes.Provenance.VERIFIED),
            detail: "calldata matches known drainer pattern"
        });
        v.reasons = reasons;

        _submitVerdict(v);
        assertGt(
            blocklist.strikes(freshWallet),
            0,
            "drainer reason at any position must strike, not only reasons[0]"
        );
    }
}
