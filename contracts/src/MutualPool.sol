// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {IMutualPool} from "./interfaces/IMutualPool.sol";

/// @title BULWARK MutualPool — the capital (two tranches).
/// @notice ERC-4626-style pooled USDC standing behind every policy.
///          Junior shares absorb claims first (first loss, higher yield);
///          senior shares are protected (paid first from premiums, lose last).
///          Payouts are callable ONLY by the VerdictContract, capped by
///          available tranche capital — bounded, priced exposure.
///          "This is deposit insurance, not a hedge fund."
contract MutualPool is IMutualPool {
    // ----------------------------------------------------------------- //
    //                              Events                               //
    // ----------------------------------------------------------------- //

    event Deposited(address indexed depositor, uint8 indexed tranche, uint256 assets, uint256 shares);
    event Redeemed(address indexed depositor, uint8 indexed tranche, uint256 shares, uint256 assets);
    event Payout(address indexed claimant, uint96 amount, bytes32 indexed digest);
    event PremiumRecorded(address indexed agent, uint96 amount);
    event LossApplied(uint96 amount, uint96 juniorLoss, uint96 seniorLoss, uint96 reinsuranceLoss);
    event ReinsuranceHooked(address indexed hook, uint256 attachment);
    event VerdictContractSet(address indexed previous, address indexed next);

    // ----------------------------------------------------------------- //
    //                              Errors                               //
    // ----------------------------------------------------------------- //

    error NotVerdictContract();
    error NotAdmin();
    error ZeroAddress();
    error ZeroAmount();
    error BadTranche();
    error InsufficientShares();
    error InsufficientCapital();
    error ZeroShares();
    error TransferFailed();

    // ----------------------------------------------------------------- //
    //                            Storage                                //
    // ----------------------------------------------------------------- //

    uint8 public constant TRANCHE_SENIOR = 0;
    uint8 public constant TRANCHE_JUNIOR = 1;

    /// @dev USDC — the pool's unit of account.
    IERC20 public immutable USDC;

    /// @dev The only contract that may move funds out on claims.
    address public verdictContract;

    /// @dev Admin wiring.
    address public admin;

    /// @dev Tranche accounting (ERC-4626-style share math).
    struct Tranche {
        uint256 totalAssets; // USDC held attributable to this tranche
        uint256 totalShares; // shares outstanding
        mapping(address => uint256) sharesOf; // depositor => shares
    }

    Tranche private _senior;
    Tranche private _junior;

    /// @dev Premium inflows accrue to the waterfall: fees → junior carry → senior.
    uint256 public premiumPool;

    /// @dev Reinsurance hook (cat-bond layer): pays overflow above attachment.
    address public reinsuranceHook;
    uint256 public reinsuranceAttachment; // over this loss level, hook pays

    // ----------------------------------------------------------------- //
    //                         Constructor                               //
    // ----------------------------------------------------------------- //

    constructor(address usdc_, address admin_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        if (admin_ == address(0)) revert ZeroAddress();
        USDC = IERC20(usdc_);
        admin = admin_;
    }

    // ----------------------------------------------------------------- //
    //                          Admin wiring                             //
    // ----------------------------------------------------------------- //

    function setVerdictContract(address vc) external {
        if (msg.sender != admin) revert NotAdmin();
        if (vc == address(0)) revert ZeroAddress();
        address previous = verdictContract;
        verdictContract = vc;
        emit VerdictContractSet(previous, vc);
    }

    /// @notice Wire the cat-bond reinsurance layer (NextBlock-style hook).
    function setReinsurance(address hook, uint256 attachment) external {
        if (msg.sender != admin) revert NotAdmin();
        if (hook == address(0)) revert ZeroAddress();
        reinsuranceHook = hook;
        reinsuranceAttachment = attachment;
        emit ReinsuranceHooked(hook, attachment);
    }

    // ----------------------------------------------------------------- //
    //                          Deposits                                 //
    // ----------------------------------------------------------------- //

    /// @notice Deposit USDC into a tranche (senior = protected, junior = first loss).
    function deposit(uint8 tranche, uint256 assets) external returns (uint256 shares) {
        Tranche storage t = _tranche(tranche);
        if (assets == 0) revert ZeroAmount();

        shares = _toShare(t, assets);
        if (shares == 0) revert ZeroShares();
        t.totalShares += shares;
        t.sharesOf[msg.sender] += shares;
        t.totalAssets += assets;
        emit Deposited(msg.sender, tranche, assets, shares);

        if (!USDC.transferFrom(msg.sender, address(this), assets)) revert TransferFailed();
    }

    // ----------------------------------------------------------------- //
    //                          Redemption                               //
    // ----------------------------------------------------------------- //

    /// @notice Redeem tranche shares for USDC (claim-free balance only).
    function redeem(uint8 tranche, uint256 shares) external returns (uint256 assets) {
        Tranche storage t = _tranche(tranche);
        if (shares == 0) revert ZeroAmount();
        if (t.sharesOf[msg.sender] < shares) revert InsufficientShares();

        assets = _toAsset(t, shares);
        if (assets == 0) revert ZeroAmount();
        if (t.totalAssets < assets) revert InsufficientCapital();

        t.sharesOf[msg.sender] -= shares;
        t.totalShares -= shares;
        t.totalAssets -= assets;
        emit Redeemed(msg.sender, tranche, shares, assets);

        if (!USDC.transfer(msg.sender, assets)) revert TransferFailed();
    }

    // ----------------------------------------------------------------- //
    //                            Payout                                 //
    // ----------------------------------------------------------------- //

    /// @notice Pay a verified claim. Junior absorbs first, then senior, then
    ///         reinsurance. Callable ONLY by the VerdictContract.
    /// @param digest the verdict digest (audit trail; idempotence is VC-side)
    function payout(address claimant, uint96 amount, bytes32 digest) external {
        if (msg.sender != verdictContract) revert NotVerdictContract();
        if (claimant == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // Waterfall: junior → senior → reinsurance. "Never socialize insolvency."
        uint96 remaining = amount;
        uint96 juniorLoss = 0;
        uint96 seniorLoss = 0;
        uint96 reinsuranceLoss = 0;

        uint256 juniorAssets = _junior.totalAssets;
        if (remaining > 0 && juniorAssets > 0) {
            uint96 fromJunior = remaining < juniorAssets ? remaining : uint96(juniorAssets);
            _junior.totalAssets = juniorAssets - fromJunior;
            juniorLoss = fromJunior;
            remaining -= fromJunior;
        }

        if (remaining > 0) {
            uint256 seniorAssets = _senior.totalAssets;
            if (remaining > seniorAssets + _reinsuranceAvailable()) revert InsufficientCapital();
            uint96 fromSenior = remaining < seniorAssets ? remaining : uint96(seniorAssets);
            _senior.totalAssets = seniorAssets - fromSenior;
            seniorLoss = fromSenior;
            remaining -= fromSenior;
        }

        // Anything left is covered by the reinsurance layer (hook pays out).
        reinsuranceLoss = remaining;

        // (Reinsurance hook integration is deliberately v2 — cite NextBlock.
        //  v1: claims above capital revert with InsufficientCapital, which the
        //  VerdictContract pre-checks via capitalAvailable().)
        emit LossApplied(amount, juniorLoss, seniorLoss, reinsuranceLoss);
        emit Payout(claimant, amount, digest);

        if (juniorLoss + seniorLoss > 0) {
            if (!USDC.transfer(claimant, juniorLoss + seniorLoss)) revert TransferFailed();
        }
    }

    // ----------------------------------------------------------------- //
    //                         Premiums                                  //
    // ----------------------------------------------------------------- //

    /// @notice Record a premium payment to the waterfall pool.
    /// @dev v1: premiums accumulate; waterfall distribution is off-chain
    ///      accounting settled by the pricing engine (subgraph-indexed).
    function recordPremium(address /*agent*/, uint96 amount) external {
        if (amount == 0) revert ZeroAmount();
        premiumPool += amount;
        emit PremiumRecorded(address(0), amount);
        if (!USDC.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
    }

    // ----------------------------------------------------------------- //
    //                            Views                                  //
    // ----------------------------------------------------------------- //

    function seniorCapital() external view returns (uint256) {
        return _senior.totalAssets;
    }

    function juniorCapital() external view returns (uint256) {
        return _junior.totalAssets;
    }

    /// @dev Total claimable capital today (junior + senior; reinsurance v2).
    function capitalAvailable() external view returns (uint256) {
        return _junior.totalAssets + _senior.totalAssets;
    }

    function sharesOf(address depositor, uint8 tranche) external view returns (uint256) {
        if (tranche == TRANCHE_SENIOR) return _senior.sharesOf[depositor];
        if (tranche == TRANCHE_JUNIOR) return _junior.sharesOf[depositor];
        revert BadTranche();
    }

    function totalShares(uint8 tranche) external view returns (uint256) {
        return _tranche(tranche).totalShares;
    }

    function totalAssetsOf(uint8 tranche) external view returns (uint256) {
        return _tranche(tranche).totalAssets;
    }

    /// @dev Convert assets → shares (first deposit sets 1:1).
    function _toShare(Tranche storage t, uint256 assets) internal view returns (uint256) {
        if (t.totalShares == 0 || t.totalAssets == 0) return assets;

        return (assets * t.totalShares) / t.totalAssets;
    }

    function _toAsset(Tranche storage t, uint256 shares) internal view returns (uint256) {
        if (t.totalShares == 0) return 0;
        return (shares * t.totalAssets) / t.totalShares;
    }

    function _tranche(uint8 tranche) internal view returns (Tranche storage) {
        if (tranche == TRANCHE_SENIOR) return _senior;
        if (tranche == TRANCHE_JUNIOR) return _junior;
        revert BadTranche();
    }

    /// @dev View-only alias so external reads share the same selector logic.
    function _trancheView(uint8 tranche) internal view returns (Tranche storage) {
        return _tranche(tranche);
    }

    function _reinsuranceAvailable() internal view returns (uint256) {
        // v1: no live cat-bond; attachment exists for accounting only.
        return reinsuranceHook == address(0) ? 0 : 0;
    }
}
