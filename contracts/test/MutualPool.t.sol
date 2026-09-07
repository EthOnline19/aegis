// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BulwarkTest} from "./BulwarkTest.t.sol";
import {BulwarkTypes} from "../src/BulwarkTypes.sol";
import {MutualPool} from "../src/MutualPool.sol";

/// @title MutualPool tranche + waterfall tests.
/// @notice Plan §11: junior absorbs first, senior protected, payouts bounded.
contract MutualPoolTest is BulwarkTest {
    function test_DepositMintsShares1To1() public {
        assertEq(pool.sharesOf(ravi, 1), 20_000e6, "junior shares 1:1 on first deposit");
        assertEq(pool.sharesOf(senior, 0), 25_000e6, "senior shares 1:1");
        assertEq(pool.juniorCapital(), 20_000e6);
        assertEq(pool.seniorCapital(), 25_000e6);
        assertEq(pool.capitalAvailable(), 45_000e6);
    }

    function test_WaterfallJuniorAbsorbsFirst() public {
        uint256 juniorBefore = pool.juniorCapital();
        uint256 seniorBefore = pool.seniorCapital();

        BulwarkTypes.Verdict memory v = _coveredVerdict(bytes32(uint256(0x77)), attacker, 500e6, 450e6);
        _submitVerdict(v);

        assertEq(pool.juniorCapital(), juniorBefore - 450e6, "junior pays the claim");
        assertEq(pool.seniorCapital(), seniorBefore, "senior untouched while junior solvent");
    }

    function test_WaterfallJuniorExhaustedSeniorPays() public {
        // Claim larger than all junior capital ($20k) → junior wiped, senior pays rest.
        // Coverage cap is $2,500 though — need a bigger policy. Attach v2 with cap $50k.
        BulwarkTypes.Policy memory p = basePolicy(2);
        p.coverageCap = 50_000e6;
        p.dailyLimit = 60_000e6;
        p.perTxLimit = 50_000e6;
        vm.prank(amara);
        registry.attach(address(guard), p);

        uint256 juniorBefore = pool.juniorCapital();
        uint256 seniorBefore = pool.seniorCapital();

        // Loss $30k, payout $27k (10% deductible). Junior $20k wiped, senior pays $7k.
        BulwarkTypes.Verdict memory v = _coveredVerdict(bytes32(uint256(0x78)), attacker, 30_000e6, 27_000e6);
        _submitVerdict(v);

        assertEq(pool.juniorCapital(), 0, "junior wiped out");
        assertEq(pool.seniorCapital(), seniorBefore - 7_000e6, "senior absorbs overflow");
        assertEq(usdc.balanceOf(amara), 27_000e6, "claimant paid in full");
        assertLt(juniorBefore, 21_000e6); // sanity: setup unchanged
    }

    function test_ClaimAboveAllCapitalReverts() public {
        BulwarkTypes.Policy memory p = basePolicy(2);
        p.coverageCap = 100_000e6;
        p.dailyLimit = 120_000e6;
        p.perTxLimit = 100_000e6;
        vm.prank(amara);
        registry.attach(address(guard), p);

        // $90k payout > $45k capital (and no reinsurance in v1) → revert.
        BulwarkTypes.Verdict memory v = _coveredVerdict(bytes32(uint256(0x79)), attacker, 100_000e6, 90_000e6);
        bytes memory sig = _sigFor(v); // sign before prank (staticcall consumes it)
        vm.prank(vm.addr(watcherPk));
        vm.expectRevert(MutualPool.InsufficientCapital.selector);
        verdicts.submitVerdict(v, sig);
    }

    function test_OnlyVerdictContractPays() public {
        vm.prank(attacker);
        vm.expectRevert(MutualPool.NotVerdictContract.selector);
        pool.payout(attacker, 100e6, bytes32(0));
    }

    function test_RedeemBurnsShares() public {
        vm.startPrank(ravi);
        uint256 assets = pool.redeem(1, 10_000e6);
        assertEq(assets, 10_000e6, "proportional redemption");
        assertEq(pool.sharesOf(ravi, 1), 10_000e6);
        assertEq(usdc.balanceOf(ravi), 10_000e6);
        vm.stopPrank();
    }

    function test_RedeemMoreThanSharesReverts() public {
        vm.prank(ravi);
        vm.expectRevert(MutualPool.InsufficientShares.selector);
        pool.redeem(1, 20_001e6);
    }

    function test_PremiumRecording() public {
        usdc.mint(address(this), 500e6);
        usdc.approve(address(pool), type(uint256).max);
        uint256 before = pool.premiumPool();
        pool.recordPremium(address(guard), 500e6);
        assertEq(pool.premiumPool(), before + 500e6);
    }

    function _sigFor(BulwarkTypes.Verdict memory v) internal view returns (bytes memory) {
        bytes32 digest = verdicts.verdictDigest712(v);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(watcherPk, digest);
        return abi.encodePacked(r, s, sv);
    }
}
