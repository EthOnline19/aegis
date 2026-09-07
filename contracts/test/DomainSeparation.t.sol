// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BulwarkTest} from "./BulwarkTest.t.sol";
import {BulwarkTypes} from "../src/BulwarkTypes.sol";
import {VerdictContract} from "../src/VerdictContract.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {Blocklist} from "../src/Blocklist.sol";

/// @title Cross-deployment verdict replay (review H2).
/// @notice submitVerdict/submitHoldVerdict verify signatures with no chain
///         id, contract address, or EIP-712 domain. A watcher-signed verdict
///         valid on one deployment is valid on ANY other deployment with
///         the same watcher key — and claimNullifiers are per-contract
///         storage, so the same txHash pays once per deployment.
contract DomainSeparationTest is BulwarkTest {
    /// @dev THE BUG: sign a verdict for deployment A, submit it to a second
    ///      fresh deployment B (same watcher, same registry/pool wiring).
    ///      Today B accepts it — the signature carries no domain binding.
    function test_CrossDeploymentVerdictRejected() public {
        // Build + sign a valid covered verdict against deployment A.
        BulwarkTypes.Verdict memory v =
            _coveredVerdict(keccak256("breach-tx"), attacker, 150e6, 135e6);
        bytes memory sig = _signVerdict(v);

        // A second, independently deployed VerdictContract — same watcher
        // key, its own storage (empty nullifiers). It shares the SAME
        // registry (so the policy pin passes) and the SAME pool: the only
        // difference from A is the contract address. If the digest were
        // domain-bound, the signature must fail here.
        VerdictContract verdictsB = new VerdictContract(address(registry), address(blocklist));
        verdictsB.setWatcher(_watcherAddr());
        verdictsB.setPool(address(pool));
        pool.setVerdictContract(address(verdictsB)); // B can actually pay

        // The replay: submit A's signature to B. MUST revert. Today it is
        // accepted (domain-free digest), minting a fresh payout against B's
        // nullifier set for the same breach.
        vm.prank(_watcherAddr());
        vm.expectRevert();
        verdictsB.submitVerdict(v, sig);
    }

    /// @dev Same replay for hold verdicts: a hold-verdict signature signed
    ///      for one deployment must not steer holds on another. Deployment
    ///      B is fully wired as a fresh guard's verdict authority (so the
    ///      only failing check can be the domain binding).
    function test_CrossDeploymentHoldVerdictRejected() public {
        // Sign a hold verdict for deployment A (the fixture's wiring).
        bytes32 policyHash = _policyHash();
        bytes32 raw = keccak256(abi.encode(uint256(1), address(guard), policyHash, uint8(1)));
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", raw));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(watcherPk, prefixed);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Create a pending hold on the fixture guard (id 1).
        vm.prank(atlasKey);
        guard.propose(address(usdc), carol, 150e6);

        // Deployment B: same registry (policy pin is a signed field here,
        // not a live lookup), wired as a SECOND guard's verdict authority.
        // We re-point the FIXTURE guard at B for this call: if B accepts
        // A's signature, the domain is not bound to the verifying contract.
        VerdictContract verdictsB = new VerdictContract(address(registry), address(blocklist));
        verdictsB.setWatcher(_watcherAddr());
        vm.prank(amara);
        guard.setVerdictContract(address(verdictsB));

        // Replay A's hold-verdict signature against B. MUST revert on the
        // signature check (domain-bound digest) — today it verifies and
        // the hold freezes.
        vm.prank(_watcherAddr());
        vm.expectRevert();
        verdictsB.submitHoldVerdict(1, address(guard), policyHash, 1, sig);
    }

    /// @dev Regression: legitimate same-deployment submission still works.
    function test_SameDeploymentVerdictStillAccepted() public {
        BulwarkTypes.Verdict memory v =
            _coveredVerdict(keccak256("legit-tx"), attacker, 150e6, 135e6);
        bytes memory sig = _signVerdict(v); // sign BEFORE prank: cheatcode
        // calls (vm.sign) consume the prank — prank must wrap only the
        // external submitVerdict call.
        vm.prank(_watcherAddr());
        verdicts.submitVerdict(v, sig);
        assertEq(usdc.balanceOf(amara), 135e6, "same-deployment payout works");
    }
}
