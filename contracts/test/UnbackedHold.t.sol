// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BulwarkTest} from "./BulwarkTest.t.sol";
import {BulwarkTypes} from "../src/BulwarkTypes.sol";
import {GuardAccount} from "../src/GuardAccount.sol";

/// @title Unbacked holds and withdrawal DoS (review C2).
/// @notice propose() never checks spendable balance before creating an
///         elevated-lane hold. An agent key can lock far more than the
///         wallet holds: spendableUsdc() underflows (reverts), withdraw()
///         reverts (custody bricked), and _lockedUsdc() scans every hold
///         ever created — gas griefing at scale.
contract UnbackedHoldTest is BulwarkTest {
    address internal atlasKey2 = makeAddr("atlasKey2");
    /// @dev THE BUG: the wallet holds $4,000. The agent creates 30 holds of
    ///      $150 each to fresh recipients — $4,500 locked, $500 unbacked.
    ///      Every hold is under the per-tx cap, and hold creation does not
    ///      consume daily counters (they tick on execution only), so all 30
    ///      succeed. Today NOTHING reverts.
    function test_UnbackedHoldRejected() public {
        uint256 created = 0;
        for (uint256 i = 0; i < 30; i++) {
            vm.prank(atlasKey);
            try guard.propose(address(usdc), makeAddr(string.concat("r", vm.toString(i))), 150e6) {
                created++;
            } catch {
                break;
            }
        }
        // With $4,000 on deposit, at most 26 holds of $150 are backed.
        // The 27th must be rejected — total locked may never exceed balance.
        assertLe(created, 26, "unbacked hold accepted");
    }

    /// @dev After a full day of holds, the owner can still withdraw
    ///      everything not locked — spendableUsdc() must not underflow and
    ///      withdraw() must not brick.
    function test_OwnerWithdrawSurvivesManyHolds() public {
        // Create a day's worth of pending holds (26 = $3,900 of $4,000).
        for (uint256 i = 0; i < 26; i++) {
            vm.prank(atlasKey);
            guard.propose(address(usdc), makeAddr(string.concat("w", vm.toString(i))), 150e6);
        }

        // Must NOT revert (today: underflow panic in spendableUsdc).
        uint256 spendable = guard.spendableUsdc();
        assertEq(spendable, 4_000e6 - 26 * 150e6, "spendable = balance - locked");

        // Owner withdraws the unlocked remainder — must succeed.
        vm.prank(amara);
        guard.withdraw(address(usdc), amara, uint96(spendable));
        assertEq(usdc.balanceOf(amara), spendable, "custody never locked");
    }

    /// @dev The owner can always freeze-cancel a hold; after cancelling
    ///      everything, the full balance is spendable again.
    function test_FreezeCancelAllRestoresSpendable() public {
        for (uint256 i = 0; i < 26; i++) {
            vm.prank(atlasKey);
            guard.propose(address(usdc), makeAddr(string.concat("c", vm.toString(i))), 150e6);
        }
        for (uint256 i = 1; i <= 26; i++) {
            vm.prank(amara);
            guard.decide(i, GuardAccount.Decision.FREEZE);
        }
        assertEq(guard.spendableUsdc(), 4_000e6, "all holds cancelled");
        vm.prank(amara);
        guard.withdraw(address(usdc), amara, 4_000e6);
        assertEq(usdc.balanceOf(amara), 4_000e6);
    }

    /// @dev Gas: locked-funds accounting must be O(1) — cost at 100 live
    ///      holds must not meaningfully exceed cost at 10 live holds. The
    ///      old O(n) scan grew ~4.4k gas per hold (probe measured 453k
    ///      gas at 100 holds vs 12.9k at zero — 10x holds, 35x cost).
    function test_SpendableGasBoundedWithManyHistoricalHolds() public {
        // 10 live holds ($1,000 of $4,000 — all backed).
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(atlasKey);
            guard.propose(address(usdc), makeAddr(string.concat("a", vm.toString(i))), 100e6);
        }
        uint256 gTen = gasleft();
        guard.spendableUsdc();
        uint256 costTen = gTen - gasleft();

        // 100 live holds ($10,000... capped by balance check: use $10 each
        // so 100 holds = $1,000 — same locked total, 10x the hold count).
        GuardAccount fresh = _freshAccount();
        for (uint256 i = 0; i < 100; i++) {
            vm.prank(atlasKey2);
            fresh.propose(address(usdc), makeAddr(string.concat("b", vm.toString(i))), 10e6);
        }
        uint256 gHundred = gasleft();
        fresh.spendableUsdc();
        uint256 costHundred = gHundred - gasleft();

        // O(1): 10x the holds must not 2x the cost (old scan: ~10x).
        assertLt(costHundred, costTen * 2, "spendableUsdc must stay O(1) in hold count");
    }

    /// @dev Locked accounting across the watcher-freeze path: freezeHold
    ///      decrements; the owner's subsequent decide(FREEZE) on the FROZEN
    ///      hold must NOT decrement again (the demo's exact flow — this
    ///      was a double-decrement underflow found by the demo run).
    function test_WatcherFreezeThenOwnerDecideAccounting() public {
        vm.prank(atlasKey);
        uint256 id = guard.propose(address(usdc), carol, 150e6);
        assertEq(guard.spendableUsdc(), 4_000e6 - 150e6, "pending locks");

        // Watcher freezes (PENDING -> FROZEN): one decrement.
        vm.prank(address(verdicts));
        guard.freezeHold(id);
        assertEq(guard.spendableUsdc(), 4_000e6, "frozen not counted as locked");

        // Owner freezes-cancels the FROZEN hold: no further decrement.
        vm.prank(amara);
        guard.decide(id, GuardAccount.Decision.FREEZE);
        assertEq(guard.spendableUsdc(), 4_000e6, "no double decrement");

        vm.prank(amara);
        guard.withdraw(address(usdc), amara, 4_000e6);
        assertEq(usdc.balanceOf(amara), 4_000e6, "custody intact end-to-end");
    }

    /// @dev Same invariant via the lapse path (PENDING -> auto-FROZEN ->
    ///      owner APPROVE): exactly one decrement, then full withdrawal.
    function test_LapseThenApproveAccounting() public {
        vm.prank(atlasKey);
        uint256 id = guard.propose(address(usdc), carol, 150e6);

        // Lapse: extend window, then auto-freeze.
        vm.warp(block.timestamp + 121);
        guard.lapseHold(id); // extends 60 min
        vm.warp(block.timestamp + 3601);
        guard.lapseHold(id); // auto-freezes (one decrement)
        assertEq(guard.spendableUsdc(), 4_000e6, "auto-frozen not locked");

        vm.prank(amara);
        guard.decide(id, GuardAccount.Decision.APPROVE); // pays out, no second decrement
        assertEq(usdc.balanceOf(carol), 150e6, "approved hold paid");
        assertEq(guard.spendableUsdc(), 3_850e6, "balance reflects the payout only");
    }

    /// @dev A second wired GuardAccount (same owner) for scaling tests.
    function _freshAccount() internal returns (GuardAccount) {
        vm.prank(amara);
        GuardAccount g = new GuardAccount(
            amara, atlasKey2, address(registry), address(blocklist), address(usdc)
        );
        usdc.mint(address(g), 4_000e6);
        // Same policy shape as the fixture (velocity must allow 100 holds).
        BulwarkTypes.Policy memory p = basePolicy(1);
        p.agent = address(g);
        p.velocityLimit = 200;
        p.dailyLimit = 2_000e6;
        vm.prank(amara);
        registry.attach(address(g), p);
        return g;
    }
}
