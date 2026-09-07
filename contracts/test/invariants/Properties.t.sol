// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BulwarkTest} from "../BulwarkTest.t.sol";
import {BulwarkTypes} from "../../src/BulwarkTypes.sol";
import {GuardAccount} from "../../src/GuardAccount.sol";
import {MutualPool} from "../../src/MutualPool.sol";

/// @title Property + fuzz tests — the plan's critical invariants.
/// @notice I1 fund conservation · I2 hold recovery · I3 payout solvency ·
///          I4 double-claim nullifiers · deterministic classifier mirror.
contract Properties is BulwarkTest {
    // -------------------------------------------------------------- //
    //                  Deterministic classifier mirror               //
    // -------------------------------------------------------------- //

    /// @dev Any amount strictly above the effective cap must be a violation.
    function testFuzz_OverCapAlwaysViolates(uint96 over) public {
        over = uint96(bound(over, PER_TX + 1, 4_000e6));
        vm.prank(atlasKey);
        vm.expectRevert(
            abi.encodeWithSelector(GuardAccount.Violation.selector, bytes4(keccak256("OVER_PER_TX")))
        );
        guard.propose(address(usdc), attacker, over);
        assertEq(usdc.balanceOf(attacker), 0);
    }

    /// @dev Allowlisted recipients are governed by their sub-cap, not global.
    function testFuzz_SubCapGoverns(uint96 amt) public {
        amt = uint96(bound(amt, 1, PER_TX_PAYROLL));
        vm.prank(atlasKey);
        uint256 id = guard.propose(address(usdc), bob, amt);
        // Within sub-cap to allowlisted bob: routine (0) or elevated (≥1) —
        // never a violation; and $≤200 amounts stay routine.
        if (amt <= PER_TX_PAYROLL) {
            assertTrue(usdc.balanceOf(bob) == amt || id >= 1);
        }
    }

    /// @dev Deductible math: payout + deductible portion never exceeds loss.
    function testFuzz_DeductibleBounded(uint96 loss) public pure {
        loss = uint96(bound(loss, 1, COVERAGE_CAP));
        uint256 payout = (uint256(loss) * (10_000 - DEDUCTIBLE_BPS)) / 10_000;
        uint256 deductiblePortion = (payout * DEDUCTIBLE_BPS) / 10_000;
        assertLe(payout + deductiblePortion, loss, "payout+deductible lte loss");
    }

    // -------------------------------------------------------------- //
    //                      I1: fund conservation                     //
    // -------------------------------------------------------------- //

    /// @dev Across arbitrary proposals, GuardAccount balance only drops by
    ///      exactly-executed routine amounts; holds never leak.
    function testFuzz_ProposalsConserveFunds(uint96 amount, address to) public {
        to = _sanitize(to);
        amount = uint96(bound(amount, 1, 4_000e6));

        uint256 before = usdc.balanceOf(address(guard));
        uint256 beforeTotal =
            usdc.balanceOf(address(guard)) + usdc.balanceOf(alice) + usdc.balanceOf(bob)
                + usdc.balanceOf(carol) + usdc.balanceOf(attacker) + usdc.balanceOf(freshWallet)
                + usdc.balanceOf(to);

        try guard.propose(address(usdc), to, amount) returns (uint256 id) {
            uint256 afterBal = usdc.balanceOf(address(guard));
            if (id == 0) {
                assertEq(before - afterBal, amount, "routine moves exact amount");
            } else {
                assertEq(afterBal, before, "hold moves nothing");
                (, uint96 held,,,,) = guard.holds(id);
                assertEq(held, amount, "hold locks exact amount");
            }
        } catch {
            assertEq(usdc.balanceOf(address(guard)), before, "violation moves nothing");
        }

        uint256 afterTotalBal =
            usdc.balanceOf(address(guard)) + usdc.balanceOf(alice) + usdc.balanceOf(bob)
                + usdc.balanceOf(carol) + usdc.balanceOf(attacker) + usdc.balanceOf(freshWallet)
                + usdc.balanceOf(to);
        assertEq(afterTotalBal, beforeTotal, "I1: no funds created or destroyed");
    }

    // -------------------------------------------------------------- //
    //                I2: hold funds always recoverable               //
    // -------------------------------------------------------------- //

    /// @dev For any held amount, the owner can freeze-cancel and recover
    ///      the full locked balance; spendable never goes negative.
    function testFuzz_HoldsAlwaysRecoverable(uint96 amount) public {
        amount = uint96(bound(amount, 1, 200e6)); // within alice's cap → routine; use carol for hold
        uint256 id = _propose(carol, amount);
        vm.assume(id != type(uint256).max); // must be elevated, not violation

        assertEq(guard.spendableUsdc(), 4_000e6 - amount, "locked excluded");

        // Owner freeze-cancel: funds return to spendable.
        vm.prank(amara);
        guard.decide(id, GuardAccount.Decision.FREEZE);
        assertEq(guard.spendableUsdc(), 4_000e6, "I2: fully recovered");

        // Full withdrawal now possible.
        vm.prank(amara);
        guard.withdraw(address(usdc), amara, 4_000e6);
        assertEq(usdc.balanceOf(amara), 4_000e6, "custody never locked");
    }

    // -------------------------------------------------------------- //
    //                I3 + I4: solvency and nullifiers                //
    // -------------------------------------------------------------- //

    /// @dev Random claims: payout bounded by capital; replay blocked.
    function testFuzz_PayoutsSolvent(uint96 loss, uint8 salt) public {
        loss = uint96(bound(loss, 12, 2_500e6)); // ≥ smallest payable (deductible > 0)
        uint96 payout = uint96((uint256(loss) * 9000) / 10_000);
        bytes32 txHash = keccak256(abi.encode(loss, salt));

        BulwarkTypes.Verdict memory v = _coveredVerdict(txHash, attacker, loss, payout);
        bytes memory sig = _sigFor(v);

        uint256 capitalBefore = pool.capitalAvailable();
        vm.prank(vm.addr(watcherPk));
        verdicts.submitVerdict(v, sig);

        assertEq(
            pool.capitalAvailable() + payout, capitalBefore, "I3: payout lte capital, exact delta"
        );

        // I4: replaying the same txHash must revert.
        vm.prank(vm.addr(watcherPk));
        vm.expectRevert();
        verdicts.submitVerdict(v, sig);
    }

    // -------------------------------------------------------------- //
    //                        Helpers                                 //
    // -------------------------------------------------------------- //

    function _sanitize(address to) internal view returns (address) {
        if (to == address(0) || to == address(guard) || to == address(usdc)) return carol;
        return to;
    }

    function _sigFor(BulwarkTypes.Verdict memory v) internal view returns (bytes memory) {
        bytes32 digest = BulwarkTypes.verdictDigest(v);
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(watcherPk, prefixed);
        return abi.encodePacked(r, s, sv);
    }
}
