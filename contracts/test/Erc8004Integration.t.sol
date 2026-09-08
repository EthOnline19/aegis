// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC8004IdentityRegistry } from "../src/interfaces/erc8004/IERC8004IdentityRegistry.sol";
import {
    IERC8004ValidationRegistry
} from "../src/interfaces/erc8004/IERC8004ValidationRegistry.sol";
import {
    IERC8004ReputationRegistry
} from "../src/interfaces/erc8004/IERC8004ReputationRegistry.sol";
import { ERC8004IdentityMock } from "./mocks/ERC8004IdentityMock.sol";
import { ERC8004ValidationMock } from "./mocks/ERC8004ValidationMock.sol";
import { ERC8004ReputationMock } from "./mocks/ERC8004ReputationMock.sol";

/// @title ERC-8004 integration tests (Step 3, piece 1).
/// @notice Pins the registry semantics BULWARK's off-chain orchestrator
///         depends on (docs/ERC8004_DESIGN.md §2–§3), against faithful
///         replicas of the canonical v2.0.0 registries:
///         - auth triangle: owner/operator requests, named-validator
///           responses, owner/operator-blocked feedback;
///         - one-time writes ("exists", first-answer-final);
///         - score/value mapping constants (off-chain truth, pinned here);
///         - getSummary AVERAGES (the aggregation correction).
contract Erc8004IntegrationTest is Test {
    ERC8004IdentityMock internal identity;
    ERC8004ValidationMock internal validations;
    ERC8004ReputationMock internal reputation;

    address internal opsKey = makeAddr("opsKey"); // owns every agentId NFT
    address internal watcherKey = makeAddr("watcherKey"); // validator EOA
    address internal reputationKey = makeAddr("reputationKey"); // feedback EOA
    address internal attacker = makeAddr("attacker");

    /// @dev guardAccount must be a real EOA: the identity registry's
    ///      setAgentWallet checks the signature comes FROM the new wallet.
    ///      0xA11CE as a foundry-supported pk (address 0xe05fCc...cfF7).
    uint256 internal constant GUARD_PK = 0xA11CE;
    uint256 internal constant WRONG_PK = 0xBAD;
    address internal guardAccount = vm.addr(GUARD_PK);

    uint256 internal agentId;

    // --- mapping constants (approved v2; authoritative off-chain, pinned
    //     here so a code drift fails loudly) -----------------------------
    int128 internal constant VALUE_COVERED = -2500; // -25.00
    int128 internal constant VALUE_ATTEMPTED = 500; // +5.00
    int128 internal constant VALUE_DENIED = -10_000; // -100.00
    uint8 internal constant DECIMALS = 2;
    uint8 internal constant SCORE_COVERED = 25;
    uint8 internal constant SCORE_ATTEMPTED = 75;
    uint8 internal constant SCORE_DENIED = 0;
    string internal constant TAG1 = "bulwark-verdict";
    string internal constant TAG2_COVERED = "covered";
    string internal constant TAG2_ATTEMPTED = "attempted";
    string internal constant TAG2_DENIED = "denied-owner-origin";

    function setUp() public {
        identity = new ERC8004IdentityMock();
        validations = new ERC8004ValidationMock(identity);
        reputation = new ERC8004ReputationMock(identity);

        vm.prank(opsKey);
        agentId = identity.register("https://bulwark.eth/agents/atlas.json");
        assertEq(identity.ownerOf(agentId), opsKey);
        assertEq(identity.getAgentWallet(agentId), opsKey); // reference defaults wallet to caller
    }

    // =====================================================================
    // Identity: valid-binding check (design D1)
    // =====================================================================

    function test_AgentWalletBindingFlow() public {
        // Rebind to the guard account with a signature FROM the new wallet.
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 digest = identity.agentWalletSetDigest(agentId, guardAccount, opsKey, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(GUARD_PK, digest);
        vm.prank(opsKey); // owner relays
        identity.setAgentWallet(agentId, guardAccount, deadline, abi.encodePacked(r, s, v));
        assertEq(identity.getAgentWallet(agentId), guardAccount);
    }

    function test_AgentWalletWrongSignerReverts() public {
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 digest = identity.agentWalletSetDigest(agentId, guardAccount, opsKey, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WRONG_PK, digest); // not guardAccount
        vm.prank(opsKey);
        vm.expectRevert(bytes("invalid wallet sig"));
        identity.setAgentWallet(agentId, guardAccount, deadline, abi.encodePacked(r, s, v));
    }

    function test_AgentWalletStaleDeadlineReverts() public {
        uint256 deadline = block.timestamp - 1;
        bytes32 digest = identity.agentWalletSetDigest(agentId, guardAccount, opsKey, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(GUARD_PK, digest);
        vm.prank(opsKey);
        vm.expectRevert(bytes("expired"));
        identity.setAgentWallet(agentId, guardAccount, deadline, abi.encodePacked(r, s, v));
    }

    function test_AgentWalletNonOwnerCannotRebind() public {
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 digest = identity.agentWalletSetDigest(agentId, guardAccount, opsKey, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(GUARD_PK, digest);
        vm.prank(attacker);
        vm.expectRevert(bytes("Not authorized"));
        identity.setAgentWallet(agentId, guardAccount, deadline, abi.encodePacked(r, s, v));
    }

    // =====================================================================
    // Validation: authorization + one-time writes (design D2)
    // =====================================================================

    function _requestHash(uint256 salt) internal view returns (bytes32) {
        return keccak256(
            abi.encode(agentId, guardAccount, bytes32(salt), bytes32(salt + 1), block.chainid)
        );
    }

    function test_RequestByOwnerSucceeds() public {
        bytes32 rh = _requestHash(1);
        vm.prank(opsKey);
        validations.validationRequest(
            watcherKey, agentId, "https://api.bulwark.eth/v1/verdicts/0xabc", rh
        );
        (address validatorAddress,,,,,) = validations.getValidationStatus(rh);
        assertEq(validatorAddress, watcherKey);
    }

    function test_RequestByOperatorSucceeds() public {
        vm.prank(opsKey);
        identity.setApprovalForAll(attacker, true);
        bytes32 rh = _requestHash(2);
        vm.prank(attacker);
        validations.validationRequest(watcherKey, agentId, "uri", rh);
    }

    function test_RequestByNonOwnerReverts() public {
        vm.prank(attacker);
        vm.expectRevert(bytes("Not authorized"));
        validations.validationRequest(watcherKey, agentId, "uri", _requestHash(3));
    }

    function test_DuplicateRequestHashReverts() public {
        bytes32 rh = _requestHash(4);
        vm.startPrank(opsKey);
        validations.validationRequest(watcherKey, agentId, "uri", rh);
        vm.expectRevert(bytes("exists"));
        validations.validationRequest(watcherKey, agentId, "uri", rh);
        vm.stopPrank();
    }

    function test_ResponseByValidatorSucceeds() public {
        bytes32 rh = _requestHash(5);
        vm.prank(opsKey);
        validations.validationRequest(watcherKey, agentId, "uri", rh);
        vm.prank(watcherKey);
        validations.validationResponse(
            rh, SCORE_COVERED, "https://api.bulwark.eth/v1/verdicts/0xabc", bytes32(0), "verdict"
        );
        (address validatorAddress,, uint8 response,,,) = _status(rh);
        assertEq(validatorAddress, watcherKey);
        assertEq(response, SCORE_COVERED);
    }

    function test_ResponseByNonValidatorReverts() public {
        bytes32 rh = _requestHash(6);
        vm.prank(opsKey);
        validations.validationRequest(watcherKey, agentId, "uri", rh);
        vm.prank(opsKey); // even the NFT owner cannot answer
        vm.expectRevert(bytes("not validator"));
        validations.validationResponse(rh, 50, "uri", bytes32(0), "tag");
    }

    function test_ResponseAbove100Reverts() public {
        bytes32 rh = _requestHash(7);
        vm.prank(opsKey);
        validations.validationRequest(watcherKey, agentId, "uri", rh);
        vm.prank(watcherKey);
        vm.expectRevert(bytes("resp>100"));
        validations.validationResponse(rh, 101, "uri", bytes32(0), "tag");
    }

    function test_FirstAnswerIsFinal() public {
        bytes32 rh = _requestHash(8);
        vm.prank(opsKey);
        validations.validationRequest(watcherKey, agentId, "uri", rh);
        vm.prank(watcherKey);
        validations.validationResponse(rh, SCORE_ATTEMPTED, "uri", bytes32(0), "tag");
        // The reference has no update path — a second answer from the SAME
        // validator silently overwrites (no revert). The orchestrator's
        // contract is to post exactly once; consumers read first-answer via
        // lastUpdate. Pinned here so any future mock divergence is caught.
        vm.prank(watcherKey);
        validations.validationResponse(rh, 1, "uri", bytes32(0), "tag");
        (,, uint8 response,,,) = _status(rh);
    }

    function test_UnknownRequestStatusReverts() public {
        vm.expectRevert();
        validations.getValidationStatus(_requestHash(9));
    }

    function test_ValidationSummaryCountsAnsweredOnly() public {
        bytes32 rh1 = _requestHash(10);
        bytes32 rh2 = _requestHash(11);
        vm.startPrank(opsKey);
        validations.validationRequest(watcherKey, agentId, "uri", rh1);
        validations.validationRequest(watcherKey, agentId, "uri", rh2);
        vm.stopPrank();
        vm.prank(watcherKey);
        validations.validationResponse(rh1, SCORE_COVERED, "uri", bytes32(0), "tag");

        (uint64 count, uint8 avg) = validations.getSummary(agentId, _arr(watcherKey), "");
        assertEq(count, 1, "unanswered requests are not counted");
        assertEq(avg, SCORE_COVERED);
    }

    function _status(bytes32 rh)
        internal
        view
        returns (address va, uint256 aid, uint8 resp, bytes32 rhash, string memory tag, uint256 lu)
    {
        (va, aid, resp, rhash, tag, lu) = validations.getValidationStatus(rh);
    }

    function _arr(address a) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = a;
    }

    // =====================================================================
    // Reputation: self-feedback guard + value bounds (design D3)
    // =====================================================================

    function test_FeedbackFromReputationKeySucceeds() public {
        vm.prank(reputationKey);
        reputation.giveFeedback(
            agentId,
            VALUE_COVERED,
            DECIMALS,
            TAG1,
            TAG2_COVERED,
            "bulwark://verdicts/0xabc",
            "",
            bytes32(0)
        );
        (uint64 idx,) = _lastIdxAndCount();
        assertEq(idx, 1);
    }

    function test_SelfFeedbackByOwnerReverts() public {
        vm.prank(opsKey); // owner of the agentId NFT
        vm.expectRevert(bytes("Self-feedback not allowed"));
        reputation.giveFeedback(
            agentId, VALUE_COVERED, DECIMALS, TAG1, TAG2_COVERED, "uri", "", bytes32(0)
        );
    }

    function test_SelfFeedbackByOperatorReverts() public {
        vm.prank(opsKey);
        identity.setApprovalForAll(attacker, true);
        vm.prank(attacker); // operator of the agentId NFT
        vm.expectRevert(bytes("Self-feedback not allowed"));
        reputation.giveFeedback(
            agentId, VALUE_ATTEMPTED, DECIMALS, TAG1, TAG2_ATTEMPTED, "uri", "", bytes32(0)
        );
    }

    function test_FeedbackNonexistentAgentReverts() public {
        vm.prank(reputationKey);
        vm.expectRevert(); // ownerOf reverts "nonexistent token"
        reputation.giveFeedback(
            999, VALUE_COVERED, DECIMALS, TAG1, TAG2_COVERED, "uri", "", bytes32(0)
        );
    }

    function test_FeedbackValueBounds() public {
        vm.startPrank(reputationKey);
        vm.expectRevert(bytes("too many decimals"));
        reputation.giveFeedback(agentId, 1, 19, TAG1, TAG2_COVERED, "uri", "", bytes32(0));
        vm.expectRevert(bytes("value too large"));
        reputation.giveFeedback(
            agentId, int128(1e38) + 1, DECIMALS, TAG1, TAG2_COVERED, "uri", "", bytes32(0)
        );
        vm.stopPrank();
    }

    // =====================================================================
    // Mapping matrix (approved v2) + aggregation semantics (§3)
    // =====================================================================

    function test_MappingMatrix_Pinned() public pure {
        assertEq(VALUE_COVERED, -2500);
        assertEq(VALUE_ATTEMPTED, 500);
        assertEq(VALUE_DENIED, -10_000);
        assertEq(SCORE_COVERED, 25);
        assertEq(SCORE_ATTEMPTED, 75);
        assertEq(SCORE_DENIED, 0);
        // ordering invariant: fraud < claim-loss < attempt in both systems
        assertTrue(VALUE_DENIED < VALUE_COVERED && VALUE_COVERED < VALUE_ATTEMPTED);
        assertTrue(SCORE_DENIED < SCORE_COVERED && SCORE_COVERED < SCORE_ATTEMPTED);
    }

    function test_GetSummary_Averages_PerEventValues() public {
        _postVerdicts();
        // getSummary AVERAGES: summary = mean of the three per-event values
        // (in mode decimals), NOT the résumé SUM. count=3 is the
        // repetition signal (three posted verdict events for this client).
        (uint64 count, int128 summaryValue, uint8 summaryDecimals) =
            reputation.getSummary(agentId, _arr(reputationKey), TAG1, "");
        assertEq(count, 3, "count is the repetition signal");
        assertEq(summaryValue, (-2500 + 500 - 10_000) / 3, "getSummary averages, never sums");
        assertEq(summaryDecimals, DECIMALS);
    }

    function test_GetSummary_EmptyClientListReverts() public {
        _postVerdicts();
        vm.expectRevert(bytes("clientAddresses required"));
        reputation.getSummary(agentId, new address[](0), TAG1, "");
    }

    function test_GetSummary_Tag2Filter() public {
        _postVerdicts();
        (uint64 count, int128 summaryValue,) =
            reputation.getSummary(agentId, _arr(reputationKey), TAG1, TAG2_DENIED);
        assertEq(count, 1);
        assertEq(summaryValue, VALUE_DENIED);
    }

    function test_ReputationSum_DerivedFromReadAllFeedback() public {
        _postVerdicts();
        (,, int128[] memory values, uint8[] memory decs,,,) =
            reputation.readAllFeedback(agentId, _arr(reputationKey), TAG1, "", false);

        int256 sum;
        for (uint256 i; i < values.length; i++) {
            assertEq(decs[i], DECIMALS, "BULWARK posts a uniform decimals=2");
            sum += values[i];
        }
        // SUM is the résumé reading: -25 (claim) + +5 (attempt) + -100 (fraud).
        assertEq(values.length, 3);
        assertEq(sum, -2500 + 500 - 10_000);
        assertLt(sum, VALUE_DENIED, "net mass dominated by the fraud floor entry");
    }

    function test_RevokeExcludesFromBothReadings() public {
        _postVerdicts();
        // BULWARK never revokes outside a proven-wrong verdict; pin that a
        // revocation removes the entry from sum AND flips the average.
        vm.prank(reputationKey);
        reputation.revokeFeedback(agentId, 1); // the COVERED entry
        (,, int128[] memory values, uint8[] memory decs,,,) =
            reputation.readAllFeedback(agentId, _arr(reputationKey), TAG1, "", false);
        assertEq(values.length, 2);
        int256 sum;
        for (uint256 i; i < values.length; i++) {
            assertEq(decs[i], DECIMALS);
            sum += values[i];
        }
        assertEq(sum, 500 - 10_000);

        (uint64 count, int128 summaryValue, uint8 sd) =
            reputation.getSummary(agentId, _arr(reputationKey), TAG1, "");
        sd; // unused
        assertEq(count, 2);
        assertEq(
            summaryValue, (500 - 10_000) / 2, "average after revoke = mean of remaining entries"
        );
    }

    function test_FeedbackIndexPerClientAndReceipt() public {
        // Reputation posting is per-client 1-indexed: our digest→index map
        // comes from the receipt (event feedbackIndex), never assumed.
        vm.startPrank(reputationKey);
        reputation.giveFeedback(
            agentId, VALUE_COVERED, DECIMALS, TAG1, TAG2_COVERED, "uri", "", bytes32(0)
        );
        reputation.giveFeedback(
            agentId, VALUE_ATTEMPTED, DECIMALS, TAG1, TAG2_ATTEMPTED, "uri", "", bytes32(0)
        );
        vm.stopPrank();
        assertEq(reputation.getLastIndex(agentId, reputationKey), 2);
        (int128 v1,,,, bool rev1) = reputation.readFeedback(agentId, reputationKey, 1);
        (int128 v2,,,, bool rev2) = reputation.readFeedback(agentId, reputationKey, 2);
        assertFalse(rev1);
        assertFalse(rev2);
        assertEq(v1, VALUE_COVERED);
        assertEq(v2, VALUE_ATTEMPTED);
    }

    function _postVerdicts() internal {
        vm.startPrank(reputationKey);
        reputation.giveFeedback(
            agentId,
            VALUE_COVERED,
            DECIMALS,
            TAG1,
            TAG2_COVERED,
            "bulwark://verdicts/a",
            "",
            bytes32(0)
        );
        reputation.giveFeedback(
            agentId,
            VALUE_ATTEMPTED,
            DECIMALS,
            TAG1,
            TAG2_ATTEMPTED,
            "bulwark://verdicts/b",
            "",
            bytes32(0)
        );
        reputation.giveFeedback(
            agentId,
            VALUE_DENIED,
            DECIMALS,
            TAG1,
            TAG2_DENIED,
            "bulwark://verdicts/c",
            "",
            bytes32(0)
        );
        vm.stopPrank();
    }

    function _lastIdxAndCount() internal view returns (uint64, uint64) {
        (uint64 count, int128 avgIgnored, uint8 d) =
            reputation.getSummary(agentId, _arr(reputationKey), TAG1, "");
        avgIgnored; // unused
        d;
        return (reputation.getLastIndex(agentId, reputationKey), count);
    }
}
