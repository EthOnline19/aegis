// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BulwarkTest} from "./BulwarkTest.t.sol";
import {BulwarkTypes} from "../src/BulwarkTypes.sol";
import {GuardAccount} from "../src/GuardAccount.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";

/// @title Front-run protection on first policy attach (review C1).
/// @notice On first attach, policy.owner is attacker-controlled calldata —
///         anyone could claim the victim GuardAccount's policy, brick the
///         agent, and become the payout claimant forever.
contract RegistryFrontrunTest is BulwarkTest {
    /// @dev Run the FULL protocol fixture (deployed registry, wired stack),
    ///      then reset `guard`'s policy so we test the no-policy attach path.
    ///      (The fixture's own GuardAccount gets a fresh one in each test.)
    function setUp() public virtual override {
        super.setUp();
        vm.prank(amara);
        registry.revoke(address(guard)); // wipes policy, resets versioning
    }

    function _deployFreshGuard() internal returns (GuardAccount) {
        vm.prank(amara);
        return new GuardAccount(
            amara,
            atlasKey,
            address(registry),
            address(blocklist),
            address(usdc)
        );
    }

    /// @dev THE BUG: a stranger attaches a policy naming THEMSELVES as owner
    ///      on the victim's fresh GuardAccount before the real owner does.
    ///      Today this succeeds and permanently hijacks the policy.
    function test_FrontrunFirstAttachRejected() public {
        GuardAccount victim = _deployFreshGuard();

        BulwarkTypes.Policy memory evil = basePolicy(1);
        evil.agent = address(victim);
        evil.owner = attacker; // the attacker names themselves

        vm.prank(attacker);
        vm.expectRevert(PolicyRegistry.NotPolicyOwner.selector);
        registry.attach(address(victim), evil);
    }

    /// @dev After the fix: the real owner (the GuardAccount's immutable
    ///      OWNER) may attach the first policy, naming themselves.
    function test_LegitimateFirstAttachSucceeds() public {
        GuardAccount victim = _deployFreshGuard();

        BulwarkTypes.Policy memory legit = basePolicy(1);
        legit.agent = address(victim);
        legit.owner = amara;

        vm.prank(amara);
        registry.attach(address(victim), legit);
        assertEq(registry.latestVersion(address(victim)), 1);
    }

    /// @dev The GuardAccount itself relaying its owner's attach (deploy-flow
    ///      pattern) must still work — the account's OWNER is the authority.
    function test_GuardAccountRelayAttachSucceeds() public {
        GuardAccount victim = _deployFreshGuard();

        BulwarkTypes.Policy memory legit = basePolicy(1);
        legit.agent = address(victim);
        legit.owner = amara;

        // The GuardAccount address calls attach (the "agent" path).
        vm.prank(address(victim));
        registry.attach(address(victim), legit);
        assertEq(registry.latestVersion(address(victim)), 1);
    }

    /// @dev Attacker also cannot attach AFTER the owner: version-2 path
    ///      already checks prev.owner — regression guard.
    function test_AttackerCannotAttachAfterOwner() public {
        GuardAccount victim = _deployFreshGuard();

        BulwarkTypes.Policy memory legit = basePolicy(1);
        legit.agent = address(victim);
        legit.owner = amara;
        vm.prank(amara);
        registry.attach(address(victim), legit);

        BulwarkTypes.Policy memory evil2 = basePolicy(2);
        evil2.agent = address(victim);
        evil2.owner = attacker;
        vm.prank(attacker);
        vm.expectRevert(PolicyRegistry.NotPolicyOwner.selector);
        registry.attach(address(victim), evil2);
    }
}
