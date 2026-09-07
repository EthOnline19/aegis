// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BulwarkTest} from "./BulwarkTest.t.sol";
import {BulwarkTypes} from "../src/BulwarkTypes.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {Blocklist} from "../src/Blocklist.sol";

/// @title PolicyRegistry + Blocklist unit tests.
contract RegistryBlocklistTest is BulwarkTest {
    // ------------------------- PolicyRegistry ------------------------- //

    function test_PolicyVersioningAndHash() public {
        uint32 v = registry.latestVersion(address(guard));
        assertEq(v, 1);

        BulwarkTypes.Policy memory p = basePolicy(2);
        vm.prank(amara);
        registry.attach(address(guard), p);
        assertEq(registry.latestVersion(address(guard)), 2, "version bumps");

        bytes32 h1 = registry.policyHashAt(address(guard), 1);
        bytes32 h2 = registry.policyHashAt(address(guard), 2);
        assertTrue(h1 != h2, "versions hash differently");
        assertTrue(registry.verifyHash(address(guard), h2), "live hash verifies");
        assertFalse(registry.verifyHash(address(guard), h1), "old hash fails");
    }

    function test_VersionSkipRejected() public {
        BulwarkTypes.Policy memory p = basePolicy(3); // skipping v2
        vm.prank(amara);
        vm.expectRevert(PolicyRegistry.BadVersion.selector);
        registry.attach(address(guard), p);
    }

    function test_OnlyOwnerUpdates() public {
        BulwarkTypes.Policy memory p = basePolicy(2);
        vm.prank(attacker);
        vm.expectRevert(PolicyRegistry.NotPolicyOwner.selector);
        registry.attach(address(guard), p);
    }

    function test_InvalidPolicyRejected() public {
        BulwarkTypes.Policy memory p = basePolicy(2);
        p.perTxLimit = 0;
        vm.prank(amara);
        vm.expectRevert(PolicyRegistry.InvalidPolicy.selector);
        registry.attach(address(guard), p);

        p = basePolicy(2);
        p.dailyLimit = 100e6; // < perTxLimit
        vm.prank(amara);
        vm.expectRevert(PolicyRegistry.InvalidPolicy.selector);
        registry.attach(address(guard), p);

        p = basePolicy(2);
        p.deductibleBps = 9000; // > 50%
        vm.prank(amara);
        vm.expectRevert(PolicyRegistry.InvalidPolicy.selector);
        registry.attach(address(guard), p);
    }

    function test_RevokeResetsVersioning() public {
        vm.prank(amara);
        registry.revoke(address(guard));
        assertEq(registry.latestVersion(address(guard)), 0);

        vm.prank(attacker);
        vm.expectRevert(PolicyRegistry.PolicyNotFound.selector);
        registry.getPolicy(address(guard));

        // Re-attach starts at v1 again.
        _attachPolicy(1);
        assertEq(registry.latestVersion(address(guard)), 1);
    }

    // ---------------------------- Blocklist --------------------------- //

    function test_StrikeCompounding() public {
        vm.startPrank(address(this)); // admin
        blocklist.report(attacker, bytes32(uint256(1)));
        assertFalse(blocklist.isFlagged(attacker), "1 strike = not yet flagged");
        blocklist.report(attacker, bytes32(uint256(2)));
        assertFalse(blocklist.isFlagged(attacker), "2 strikes = not yet flagged");
        blocklist.report(attacker, bytes32(uint256(3)));
        assertTrue(blocklist.isFlagged(attacker), "3 strikes = hard flag");
        vm.stopPrank();
    }

    function test_ReporterGating() public {
        vm.prank(attacker);
        vm.expectRevert(Blocklist.NotReporter.selector);
        blocklist.report(carol, bytes32(0));

        // VerdictContract is a registered reporter.
        vm.prank(address(verdicts));
        blocklist.report(carol, bytes32(uint256(7)));
        assertEq(blocklist.strikes(carol), 1);
    }

    function test_ClearFalsePositive() public {
        vm.startPrank(address(this));
        for (uint8 i = 0; i < 3; i++) {
            blocklist.report(carol, bytes32(uint256(i)));
        }
        assertTrue(blocklist.isFlagged(carol));

        blocklist.clear(carol); // Case 7: arbitration clears the record
        assertEq(blocklist.strikes(carol), 0);
        assertFalse(blocklist.isFlagged(carol));
        vm.stopPrank();
    }
}
