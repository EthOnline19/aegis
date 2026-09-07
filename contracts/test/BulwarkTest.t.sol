// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BulwarkTypes} from "../src/BulwarkTypes.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {GuardAccount} from "../src/GuardAccount.sol";
import {VerdictContract} from "../src/VerdictContract.sol";
import {MutualPool} from "../src/MutualPool.sol";
import {Blocklist} from "../src/Blocklist.sol";
import {USDCMock} from "./mocks/USDCMock.sol";

/// @title BULWARK test fixture: wires the full protocol once per test.
/// @notice Atlas's world from the plan: $200/tx cap, $1,000/day, allowlist of 5,
///         $2,500 coverage cap, 10% deductible, 2-minute hold window.
abstract contract BulwarkTest is Test {
    // ------------------------------------------------------------- //
    //                            Actors                             //
    // ------------------------------------------------------------- //

    address internal amara = makeAddr("amara"); // owner
    address internal atlasKey = makeAddr("atlasKey"); // the agent key
    address internal ravi = makeAddr("ravi"); // junior LP
    address internal senior = makeAddr("senior"); // senior LP
    address internal watcher = makeAddr("watcher"); // TEE signer
    address internal attacker = makeAddr("attacker"); // 0xAttacker
    address internal alice = makeAddr("alice"); // ContractorAlice (allowlisted)
    address internal bob = makeAddr("bob"); // ContractorBob (allowlisted)
    address internal carol = makeAddr("carol"); // new contractor (Case 2)
    address internal freshWallet = makeAddr("freshWallet"); // 3-day-old wallet (Case 3)

    // ------------------------------------------------------------- //
    //                        Protocol stack                         //
    // ------------------------------------------------------------- //

    USDCMock internal usdc;
    PolicyRegistry internal registry;
    Blocklist internal blocklist;
    VerdictContract internal verdicts;
    MutualPool internal pool;
    GuardAccount internal guard;

    uint256 internal watcherPk = 0xBEEF;

    // ------------------------------------------------------------- //
    //                      Atlas's test policy                      //
    // ------------------------------------------------------------- //

    uint96 internal constant PER_TX = 200e6; // $200
    uint96 internal constant PER_TX_PAYROLL = 400e6; // $400 sub-cap (Case 1)
    uint96 internal constant DAILY = 1000e6; // $1,000
    uint32 internal constant VELOCITY = 5;
    uint96 internal constant COVERAGE_CAP = 2500e6; // $2,500
    uint16 internal constant DEDUCTIBLE_BPS = 1000; // 10%
    uint32 internal constant HOLD_WINDOW = 120; // 2 minutes

    function setUp() public virtual {
        usdc = new USDCMock();
        registry = new PolicyRegistry();
        blocklist = new Blocklist();
        verdicts = new VerdictContract(address(registry), address(blocklist));
        pool = new MutualPool(address(usdc), address(this));

        // Wire: pool ← verdicts, verdicts ← watcher key + pool, blocklist ← verdicts.
        pool.setVerdictContract(address(verdicts));
        verdicts.setWatcher(vm.addr(watcherPk));
        verdicts.setPool(address(pool));
        blocklist.setReporter(address(verdicts), true);

        // Deploy Atlas's GuardAccount as the owner (deterministic addr).
        vm.prank(amara);
        guard = new GuardAccount(
            amara,
            atlasKey,
            address(registry),
            address(blocklist),
            address(usdc)
        );
        vm.prank(amara);
        guard.setVerdictContract(address(verdicts));

        // Fund: GuardAccount $4,000; pool $45,000 ($20k junior, $25k senior).
        usdc.mint(address(guard), 4_000e6);
        usdc.mint(ravi, 20_000e6);
        usdc.mint(senior, 25_000e6);
        vm.startPrank(ravi);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(1, 20_000e6); // junior
        vm.stopPrank();
        vm.startPrank(senior);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(0, 25_000e6); // senior
        vm.stopPrank();

        // Attach policy v1 (allowlist: alice, bob + payroll sub-cap pattern).
        _attachPolicy(1);
    }

    // ------------------------------------------------------------- //
    //                         Helpers                               //
    // ------------------------------------------------------------- //

    function _attachPolicy(uint32 version) internal {
        BulwarkTypes.Policy memory p = basePolicy(version);
        vm.prank(amara);
        registry.attach(address(guard), p);
    }

    function basePolicy(uint32 version) public view returns (BulwarkTypes.Policy memory p) {
        p.version = version;
        p.agent = address(guard);
        p.owner = amara;
        p.coverageCap = COVERAGE_CAP;
        p.deductibleBps = DEDUCTIBLE_BPS;
        p.perTxLimit = PER_TX;
        p.dailyLimit = DAILY;
        p.velocityLimit = VELOCITY;
        p.holdWindowSec = HOLD_WINDOW;
        p.sdkInstalled = true;
        BulwarkTypes.RecipientCap[] memory list = new BulwarkTypes.RecipientCap[](2);
        list[0] = BulwarkTypes.RecipientCap({recipient: alice, cap: PER_TX});
        list[1] = BulwarkTypes.RecipientCap({recipient: bob, cap: PER_TX_PAYROLL});
        p.allowlist = list;
        p.curfewStart = 1440; // NO_CURFEW
        p.curfewEnd = 1440; // NO_CURFEW
    }

    /// @dev Agent proposes a transfer.
    function _propose(address to, uint96 amount) internal returns (uint256 holdId) {
        vm.prank(atlasKey);
        try guard.propose(address(usdc), to, amount) returns (uint256 id) {
            return id;
        } catch {
            return type(uint256).max; // violation lane marker
        }
    }

    /// @dev Build + sign a verdict with the watcher key (EIP-191 prefixed).
    function _signVerdict(BulwarkTypes.Verdict memory v) internal view returns (bytes memory) {
        v.policyHash = _policyHash();
        v.timestamp = uint64(block.timestamp);
        bytes32 digest = BulwarkTypes.verdictDigest(v);
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 sV, bytes32 r, bytes32 s) = vm.sign(watcherPk, prefixed);
        return abi.encodePacked(r, s, sV);
    }

    function _submitVerdict(BulwarkTypes.Verdict memory v) internal {
        bytes memory sig = _signVerdict(v);
        vm.prank(vm.addr(watcherPk));
        verdicts.submitVerdict(v, sig);
    }

    /// @dev Submit a signed hold verdict as the watcher (clean=0 / suspicious=1).
    function _submitHoldVerdict(uint256 holdId, uint8 tier) internal {
        bytes32 policyHash = _policyHash();
        bytes32 raw = keccak256(abi.encode(holdId, address(guard), policyHash, tier));
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", raw));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(watcherPk, prefixed);
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.prank(vm.addr(watcherPk));
        verdicts.submitHoldVerdict(holdId, address(guard), policyHash, tier, sig);
    }

    function _policyHash() internal view returns (bytes32) {
        return registry.policyHashAt(address(guard), registry.latestVersion(address(guard)));
    }

    function _watcherAddr() internal view returns (address) {
        return vm.addr(watcherPk);
    }

    /// @dev Convenience: fresh covered verdict for a full-payout claim.
    function _coveredVerdict(
        bytes32 txHash,
        address destination,
        uint96 loss,
        uint96 payout
    ) internal view returns (BulwarkTypes.Verdict memory v) {
        v.policyHash = registry.policyHashAt(address(guard), registry.latestVersion(address(guard)));
        v.agent = address(guard);
        v.claimant = amara;
        v.txHash = txHash;
        v.destination = destination;
        v.lossAmount = loss;
        v.payoutAmount = payout;
        v.alibi = uint8(BulwarkTypes.Alibi.EXTERNAL);
        v.outcome = uint8(BulwarkTypes.Outcome.COVERED);
        v.timestamp = uint64(block.timestamp);
    }
}
