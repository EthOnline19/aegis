// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {USDCMock} from "../test/mocks/USDCMock.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {Blocklist} from "../src/Blocklist.sol";
import {VerdictContract} from "../src/VerdictContract.sol";
import {MutualPool} from "../src/MutualPool.sol";
import {GuardAccount} from "../src/GuardAccount.sol";
import {BulwarkTypes} from "../src/BulwarkTypes.sol";

/// @notice One-shot demo-ready deployment: full contract stack + seeded pool
///         + Atlas policy, mirroring packages/demo/src/protocol.ts exactly.
/// @dev    ERC-8004: the contract stack has NO on-chain registry wiring surface
///         (registries are consumed off-chain via the SDK). This script records
///         the canonical registry addresses alongside the deployed addresses so
///         they are pinned "from day one" in deployments/<chainId>.json.
contract Deploy is Script {
    // Canonical ERC-8004 CREATE2 registries (packages/sdk/src/erc8004/addresses.ts).
    address constant ERC8004_IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant ERC8004_REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    address constant ERC8004_VALIDATION = 0x8004Cb1BF31DAf7788923b405b754f57acEB4272;

    struct Addrs {
        address usdc;
        address registry;
        address blocklist;
        address verdicts;
        address pool;
        address guard;
        bool mockUsdc;
    }

    // Demo actor default keys (packages/demo/src/protocol.ts). These are PUBLIC
    // test vectors; production overrides come from .env (never printed).
    string constant AMARA_PK_DEFAULT = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    string constant RAVI_PK_DEFAULT = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
    string constant SENIOR_PK_DEFAULT = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
    string constant AGENT_KEY_PK_DEFAULT = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e";
    string constant WATCHER_PK_DEFAULT = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
    // Demo pool seed + policy values (protocol.ts).
    uint256 constant JUNIOR_DEPOSIT = 20_000e6;
    uint256 constant SENIOR_DEPOSIT = 25_000e6;
    uint256 constant GUARD_BACKING = 4_000e6;
    uint256 constant COVERAGE_CAP = 2_500e6;
    uint256 constant PER_TX_LIMIT = 200e6;
    uint256 constant DAILY_LIMIT = 1000e6;
    uint256 constant ALICE_CAP = 200e6;
    uint256 constant BOB_CAP = 400e6;
    address constant ALICE = 0x328809Bc894f92807417D2dAD6b7C998c1aFdac6;
    address constant BOB = 0x1D96F2f6BeF1202E4Ce1Ff6Dad0c2CB002861d3e;
    uint16 constant DEDUCTIBLE_BPS = 1000;
    uint32 constant VELOCITY_LIMIT = 5;
    uint32 constant NO_CURFEW = 1440;
    uint32 constant HOLD_WINDOW_SEC = 120;
    struct Actors {
        address deployer;
        address amara;
        address ravi;
        address senior;
        address agentKey;
        address watcher;
    }

    function run() external {
        // Demo deployer IS amara (protocol.ts: `deployer = c.amara`): pool
        // admin, minter, wiring, and first-attach caller are all amara.
        uint256 deployerPk = vm.envOr("AMARA_PRIVATE_KEY", vm.parseUint(AMARA_PK_DEFAULT));
        uint256 amaraPk = vm.envOr("AMARA_PRIVATE_KEY", vm.parseUint(AMARA_PK_DEFAULT));
        uint256 raviPk = vm.envOr("RAVI_PRIVATE_KEY", vm.parseUint(RAVI_PK_DEFAULT));
        uint256 sensPk = vm.envOr("SENIOR_PRIVATE_KEY", vm.parseUint(SENIOR_PK_DEFAULT));
        uint256 agentPk = vm.envOr("AGENT_KEY_PRIVATE_KEY", vm.parseUint(AGENT_KEY_PK_DEFAULT));
        uint256 watcherPk = vm.envOr("WATCHER_PRIVATE_KEY", vm.parseUint(WATCHER_PK_DEFAULT));

        Actors memory m;
        m.deployer = vm.addr(deployerPk);
        m.amara = vm.addr(amaraPk);
        m.ravi = vm.addr(raviPk);
        m.senior = vm.addr(sensPk);
        m.agentKey = vm.addr(agentPk);
        m.watcher = vm.addr(watcherPk);

        // --- USDC: mock (mintable, anvil default) or real (env USDC_ADDRESS). ---
        Addrs memory a;
        a.mockUsdc = vm.envOr("USE_MOCK_USDC", true);
        if (a.mockUsdc) {
            vm.startBroadcast(deployerPk);
            a.usdc = address(new USDCMock());
            vm.stopBroadcast();
        } else {
            a.usdc = vm.envAddress("USDC_ADDRESS");
            console2.log("real USDC:", a.usdc);
            _logBalances(a.usdc, m.ravi, m.senior, m.deployer);
        }

        // --- Deploy stack + wire (same order as protocol.ts). ---
        vm.startBroadcast(deployerPk);
        a.registry = address(new PolicyRegistry());
        a.blocklist = address(new Blocklist());
        a.verdicts = address(new VerdictContract(a.registry, a.blocklist));
        a.pool = address(new MutualPool(a.usdc, m.amara));
        a.guard = address(new GuardAccount(m.amara, m.agentKey, a.registry, a.blocklist, a.usdc));
        VerdictContract(a.verdicts).setWatcher(m.watcher);
        VerdictContract(a.verdicts).setPool(a.pool);
        MutualPool(a.pool).setVerdictContract(a.verdicts);
        Blocklist(a.blocklist).setReporter(a.verdicts, true);
        (bool okGuard,) = a.guard.call(abi.encodeWithSignature("setVerdictContract(address)", a.verdicts));
        require(okGuard, "guard setVerdictContract failed");
        vm.stopBroadcast();

        // --- Fund + seed pool exactly like the demo. ---
        _seed(a, m, raviPk, sensPk, deployerPk);

        // --- Attach Atlas policy v1 (deploy-flow: amara calls directly; the
        //     policy MUST name GuardAccount.OWNER() = amara, the payout
        //     claimant — PolicyRegistry first-attach gating, review C1). ---
        BulwarkTypes.RecipientCap[] memory allowlist = new BulwarkTypes.RecipientCap[](2);
        allowlist[0] = BulwarkTypes.RecipientCap(ALICE, uint96(ALICE_CAP));
        allowlist[1] = BulwarkTypes.RecipientCap(BOB, uint96(BOB_CAP));
        BulwarkTypes.Policy memory policy = BulwarkTypes.Policy({
            version: 1,
            agent: a.guard,
            owner: m.amara,
            coverageCap: uint96(COVERAGE_CAP),
            deductibleBps: DEDUCTIBLE_BPS,
            perTxLimit: uint96(PER_TX_LIMIT),
            dailyLimit: uint96(DAILY_LIMIT),
            velocityLimit: VELOCITY_LIMIT,
            allowlist: allowlist,
            curfewStart: NO_CURFEW,
            curfewEnd: NO_CURFEW,
            holdWindowSec: HOLD_WINDOW_SEC,
            sdkInstalled: true
        });

        vm.startBroadcast(amaraPk);
        PolicyRegistry(a.registry).attach(a.guard, policy);
        vm.stopBroadcast();

        _writeDeploymentJson(a, m);

        console2.log("=== deployed ===");
        console2.log("usdc:          ", a.usdc);
        console2.log("policyRegistry:", a.registry);
        console2.log("blocklist:     ", a.blocklist);
        console2.log("verdicts:      ", a.verdicts);
        console2.log("mutualPool:    ", a.pool);
        console2.log("guardAccount:  ", a.guard);
        console2.log("pool: junior %s senior %s", vm.toString(JUNIOR_DEPOSIT), vm.toString(SENIOR_DEPOSIT));
        console2.log("policy v1 attached for guard %s (owner %s)", a.guard, m.amara);
    }

    /// @dev Fund + seed the pool exactly like the demo: guard backing, junior
    ///      (ravi, tranche 1) and senior (tranche 0) deposits.
    function _seed(Addrs memory a, Actors memory m, uint256 raviPk, uint256 sensPk, uint256 deployerPk) internal {
        if (a.mockUsdc) {
            vm.startBroadcast(deployerPk);
            USDCMock(a.usdc).mint(a.guard, GUARD_BACKING);
            USDCMock(a.usdc).mint(m.ravi, JUNIOR_DEPOSIT);
            USDCMock(a.usdc).mint(m.senior, SENIOR_DEPOSIT);
            vm.stopBroadcast();
        } else {
            // Real USDC: top up guard backing from deployer if short; the LPs
            // must have been faucet-funded beforehand.
            vm.startBroadcast(deployerPk);
            uint256 have = _balanceOf(a.usdc, a.guard);
            if (have < GUARD_BACKING) {
                uint256 shortfall = GUARD_BACKING - have;
                require(_balanceOf(a.usdc, m.deployer) >= shortfall, "deployer lacks USDC for guard backing");
                _transfer(a.usdc, a.guard, shortfall);
            }
            vm.stopBroadcast();
            require(_balanceOf(a.usdc, m.ravi) >= JUNIOR_DEPOSIT, "ravi lacks USDC (faucet)");
            require(_balanceOf(a.usdc, m.senior) >= SENIOR_DEPOSIT, "senior lacks USDC (faucet)");
        }

        vm.startBroadcast(raviPk);
        _approve(a.usdc, a.pool);
        MutualPool(a.pool).deposit(1, JUNIOR_DEPOSIT); // tranche 1 = junior
        vm.stopBroadcast();

        vm.startBroadcast(sensPk);
        _approve(a.usdc, a.pool);
        MutualPool(a.pool).deposit(0, SENIOR_DEPOSIT); // tranche 0 = senior
        vm.stopBroadcast();
    }

    function _writeDeploymentJson(Addrs memory a, Actors memory m) internal {
        string memory root = "deployment";
        string memory contractsKey = "contracts";
        string memory actorsKey = "actors";
        string memory e8Key = "erc8004";
        string memory seedKey = "seed";

        string memory contractsJson = vm.serializeAddress(contractsKey, "usdc", a.usdc);
        contractsJson = vm.serializeAddress(contractsKey, "policyRegistry", a.registry);
        contractsJson = vm.serializeAddress(contractsKey, "blocklist", a.blocklist);
        contractsJson = vm.serializeAddress(contractsKey, "verdicts", a.verdicts);
        contractsJson = vm.serializeAddress(contractsKey, "mutualPool", a.pool);
        contractsJson = vm.serializeAddress(contractsKey, "guardAccount", a.guard);

        string memory actorsJson = vm.serializeAddress(actorsKey, "deployer", m.deployer);
        actorsJson = vm.serializeAddress(actorsKey, "amaraPolicyOwner", m.amara);
        actorsJson = vm.serializeAddress(actorsKey, "raviJunior", m.ravi);
        actorsJson = vm.serializeAddress(actorsKey, "seniorLP", m.senior);
        actorsJson = vm.serializeAddress(actorsKey, "agentSessionKey", m.agentKey);
        actorsJson = vm.serializeAddress(actorsKey, "watcher", m.watcher);

        string memory e8Json = vm.serializeAddress(e8Key, "identity", ERC8004_IDENTITY);
        e8Json = vm.serializeAddress(e8Key, "reputation", ERC8004_REPUTATION);
        e8Json = vm.serializeAddress(e8Key, "validation", ERC8004_VALIDATION);
        e8Json = vm.serializeString(
            e8Key,
            "note",
            "canonical CREATE2 registries; contracts have no on-chain 8004 wiring - consumed off-chain via SDK erc8004ForChain"
        );

        string memory seedJson = vm.serializeBool(seedKey, "mockUsdc", a.mockUsdc);
        seedJson = vm.serializeUint(seedKey, "juniorDeposit", JUNIOR_DEPOSIT);
        seedJson = vm.serializeUint(seedKey, "seniorDeposit", SENIOR_DEPOSIT);
        seedJson = vm.serializeUint(seedKey, "guardBacking", GUARD_BACKING);

        vm.serializeAddress(root, "chainIdAnchor", address(uint160(block.chainid)));
        vm.serializeString(root, "contracts", contractsJson);
        vm.serializeString(root, "actors", actorsJson);
        vm.serializeString(root, "erc8004", e8Json);
        vm.serializeString(root, "seed", seedJson);
        string memory json = vm.serializeUint(root, "chainId", block.chainid);

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeFile(path, json);
        console2.log("deployments json:", path);
    }

    function _balanceOf(address usdc, address who) internal view returns (uint256) {
        (, bytes memory data) = usdc.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        return abi.decode(data, (uint256));
    }

    function _approve(address usdc, address spender) internal {
        (bool ok,) = usdc.call(abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max));
        require(ok, "approve failed");
    }

    function _transfer(address usdc, address to, uint256 amount) internal {
        (bool ok,) = usdc.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        require(ok, "transfer failed");
    }

    function _logBalances(address usdc, address ravi, address senior, address deployer) internal view {
        console2.log("ravi USDC:    ", _balanceOf(usdc, ravi));
        console2.log("senior USDC:  ", _balanceOf(usdc, senior));
        console2.log("deployer USDC:", _balanceOf(usdc, deployer));
    }
}
