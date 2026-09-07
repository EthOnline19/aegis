// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BulwarkTest} from "./BulwarkTest.t.sol";
import {BulwarkTypes} from "../src/BulwarkTypes.sol";
import {GuardAccount} from "../src/GuardAccount.sol";

/// @title GuardAccount lane classification + hold window tests.
/// @notice Covers the plan's Cases 1–4: routine day, cleared near-miss,
///         the catch (frozen attack), and the wall (hard violation).
contract GuardAccountTest is BulwarkTest {
    function test_RoutineExecutesInstantly() public {
        // Case 1: payroll to an allowlisted recipient, under caps.
        uint256 balBefore = usdc.balanceOf(alice);
        uint256 id = _propose(alice, 180e6);
        assertEq(id, 0, "routine lane must return holdId 0");
        assertEq(usdc.balanceOf(alice), balBefore + 180e6, "funds must move same tx");

        (, uint96 spent, uint256 count) = guard.dailyState();
        assertEq(spent, 180e6, "daily spent accrues");
        assertEq(count, 1, "velocity counter accrues");
    }

    function test_PayrollSubCapAllows400() public {
        // Case 1: bob has the payroll sub-cap of $400.
        _propose(bob, 310e6); // over global $200 but under bob's $400 sub-cap
        assertEq(usdc.balanceOf(bob), 310e6, "sub-cap governs allowlisted payroll");
    }

    function test_ViolationOverPerTxCap() public {
        // Case 4: $4,000 transfer → hard wall, reverts before broadcast.
        vm.expectRevert(abi.encodeWithSelector(GuardAccount.Violation.selector, bytes4(keccak256("OVER_PER_TX"))));
        vm.prank(atlasKey);
        guard.propose(address(usdc), attacker, 4_000e6);
        assertEq(usdc.balanceOf(attacker), 0, "no funds move on violation");
    }

    function test_ViolationOverDailyLimit() public {
        // 5 × $190 = $950 routine; the 6th tx would breach the $1,000 daily cap.
        // Velocity caps at 5, so the 6th also hits velocity — but daily fires
        // first only if spent+amount > daily. Use 4 × $190 = $760, then $250
        // capped at $200 → use $240: 760+240 = 1000 ≤ 1000 OK... so the daily
        // breach needs spent+amount > 1000: 4 × $190 then $250 → but $250 > $200
        // per-tx. Cleanest: sub-cap recipient bob ($400 cap): 2 × $400 = $800,
        // then $250 → 800+250 = 1050 > 1000 → OVER_DAILY.
        _propose(bob, 400e6);
        _propose(bob, 400e6);
        vm.expectRevert(abi.encodeWithSelector(GuardAccount.Violation.selector, bytes4(keccak256("OVER_DAILY"))));
        vm.prank(atlasKey);
        guard.propose(address(usdc), bob, 250e6);
    }

    function test_ViolationOverVelocity() public {
        // 5 txs allowed; the 6th reverts.
        for (uint256 i = 0; i < 5; i++) {
            _propose(alice, 100e6);
        }
        vm.expectRevert(abi.encodeWithSelector(GuardAccount.Violation.selector, bytes4(keccak256("OVER_VELOCITY"))));
        vm.prank(atlasKey);
        guard.propose(address(usdc), alice, 100e6);
    }

    function test_ViolationOnBlocklistedDestination() public {
        // Give attacker 3 strikes → hard flag.
        for (uint8 i = 0; i < 3; i++) {
            vm.prank(address(this));
            blocklist.report(attacker, bytes32(uint256(i)));
        }
        assertTrue(blocklist.isFlagged(attacker));

        vm.expectRevert(abi.encodeWithSelector(GuardAccount.Violation.selector, bytes4(keccak256("ON_BLOCKLIST"))));
        vm.prank(atlasKey);
        guard.propose(address(usdc), attacker, 50e6);
    }

    function test_ElevatedNewRecipientEntersHold() public {
        // Case 2: carol is a new recipient → elevated → hold window.
        uint256 balBefore = usdc.balanceOf(carol);
        uint256 id = _propose(carol, 150e6);
        assertGt(id, 0, "elevated lane must return a real holdId");
        assertEq(usdc.balanceOf(carol), balBefore, "no funds move during hold");

        (address to, uint96 amount, uint64 releaseAt,, uint64 extendedTo, uint8 status) =
            guard.holds(id);
        assertEq(to, carol);
        assertEq(amount, 150e6);
        assertEq(status, 0, "HOLD_PENDING");
        assertEq(releaseAt, block.timestamp + 120, "2-minute window");
        assertEq(extendedTo, 0);
    }

    function test_NearCapStaysRoutineOnChain() public {
        // Near-limit amounts are Watcher signals, NOT on-chain lanes (plan §6:
        // routine = "as fast as any wallet"; only the weird 1% gets held).
        // $150 to allowlisted alice is 75% of her cap → still ROUTINE on-chain.
        uint256 id = _propose(alice, 150e6);
        assertEq(id, 0, "on-chain classifier must not elevate near-limit amounts");
    }

    function test_HoldFundsLockedFromWithdrawal() public {
        uint256 id = _propose(carol, 150e6);
        uint256 locked = 150e6;
        assertEq(guard.spendableUsdc(), 4_000e6 - locked, "held funds not spendable");

        // Owner cannot withdraw locked funds.
        vm.prank(amara);
        vm.expectRevert(GuardAccount.NothingToWithdraw.selector);
        guard.withdraw(address(usdc), amara, 4_000e6);
    }

    function test_WatcherCleanVerdictReleases() public {
        // Case 2 (cleared): TEE verdict clean → funds move.
        uint256 id = _propose(carol, 150e6);
        _submitHoldVerdict(id, 0); // clean

        assertEq(usdc.balanceOf(carol), 150e6, "clean verdict must release funds");
        (,,,,, uint8 status) = guard.holds(id);
        assertEq(status, 1, "HOLD_RELEASED");
    }

    function test_WatcherSuspiciousVerdictFreezes() public {
        // Case 3 (the catch): suspicious → frozen, owner decides.
        uint256 id = _propose(carol, 150e6);
        _submitHoldVerdict(id, 1); // suspicious

        assertEq(usdc.balanceOf(carol), 0, "no funds move on freeze");
        (,,,,, uint8 status) = guard.holds(id);
        assertEq(status, 2, "HOLD_FROZEN");
    }

    function test_OwnerFreezeRotateKillsAgent() public {
        // Case 3: Amara taps "Freeze + rotate keys" at 4 AM.
        uint256 id = _propose(carol, 150e6);

        vm.prank(amara);
        guard.decide(id, GuardAccount.Decision.FREEZE_ROTATE);

        (,,,,, uint8 status) = guard.holds(id);
        assertEq(status, 4, "HOLD_CANCELLED");
        assertTrue(guard.authorityRevoked(), "agent authority must be revoked");

        // The agent can never move funds again.
        vm.prank(atlasKey);
        vm.expectRevert(GuardAccount.AuthorityRevokedErr.selector);
        guard.propose(address(usdc), carol, 10e6);

        // But the owner can still withdraw everything (custody never locked).
        vm.prank(amara);
        guard.withdraw(address(usdc), amara, 4_000e6);
        assertEq(usdc.balanceOf(amara), 4_000e6);
    }

    function test_Lapse_ExtendThenAutoFreeze() public {
        // Fail-safe: no verdict, no owner → extend 60min, then auto-freeze.
        uint256 id = _propose(carol, 150e6);

        // Before window ends: lapse reverts.
        vm.expectRevert(GuardAccount.HoldNotExpired.selector);
        guard.lapseHold(id);

        // T+2min: first lapse extends.
        vm.warp(block.timestamp + 121);
        guard.lapseHold(id);
        (,,,, uint64 extendedTo, uint8 status) = guard.holds(id);
        assertEq(extendedTo, block.timestamp + 3600, "60-min extension");
        assertEq(status, 0, "still pending after extend");

        // Watcher can still release within the extension.
        _submitHoldVerdict(id, 0);
        assertEq(usdc.balanceOf(carol), 150e6, "late clean verdict releases");
    }

    function test_Lapse_AutoFreezeAfterExtension() public {
        uint256 id = _propose(carol, 150e6);
        vm.warp(block.timestamp + 121);
        guard.lapseHold(id); // extend
        vm.warp(block.timestamp + 3601);
        guard.lapseHold(id); // auto-freeze

        (,,,,, uint8 status) = guard.holds(id);
        assertEq(status, 2, "HOLD_FROZEN after extension lapses");

        // Watcher can no longer release a frozen hold.
        bytes32 policyHash = _policyHash();
        bytes32 raw = keccak256(abi.encode(id, address(guard), policyHash, uint8(0)));
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", raw));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(watcherPk, prefixed);
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.prank(vm.addr(watcherPk));
        vm.expectRevert(GuardAccount.HoldNotPending.selector);
        verdicts.submitHoldVerdict(id, address(guard), policyHash, 0, sig);
    }

    function test_OwnerShortCircuitApprove() public {
        // Custody is never locked: owner approves a pending hold directly.
        uint256 id = _propose(carol, 150e6);
        vm.prank(amara);
        guard.decide(id, GuardAccount.Decision.APPROVE);
        assertEq(usdc.balanceOf(carol), 150e6);
    }

    function test_OnlyAgentProposes() public {
        vm.prank(attacker);
        vm.expectRevert(GuardAccount.NotAgent.selector);
        guard.propose(address(usdc), attacker, 50e6);
    }

    function test_KeyRotation() public {
        address newKey = makeAddr("newKey");
        vm.prank(amara);
        guard.rotateAgentKey(newKey);

        // Old key dead.
        vm.prank(atlasKey);
        vm.expectRevert(GuardAccount.NotAgent.selector);
        guard.propose(address(usdc), alice, 10e6);

        // New key works.
        vm.prank(newKey);
        guard.propose(address(usdc), alice, 10e6);
        assertEq(usdc.balanceOf(alice), 10e6);
    }

    function test_CurfewElevates() public {
        // Attach a policy with a 2am–5am curfew, test during it.
        BulwarkTypes.Policy memory p = basePolicy(2);
        p.curfewStart = 120; // 02:00
        p.curfewEnd = 300; // 05:00
        vm.prank(amara);
        registry.attach(address(guard), p);

        // Warp to 03:00 UTC.
        vm.warp(block.timestamp - (block.timestamp % 86_400) + 3 * 3600);
        uint256 id = _propose(alice, 50e6);
        assertGt(id, 0, "curfew hour must elevate");
    }

    function test_DailyCounterResetsNextDay() public {
        _propose(alice, 900e6);
        vm.warp(block.timestamp + 86_400);
        (, uint96 spent,) = guard.dailyState();
        assertEq(spent, 0, "new UTC day resets counters");
        _propose(alice, 900e6); // allowed again
    }
}
