// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StrategyVaultBase} from "../StrategyVaultBase.sol";
import {StrategyToken} from "../StrategyToken.sol";
import {
    IYieldToken,
    IYieldVenus,
    IYieldComptroller,
    IYieldAToken,
    IYieldAavePool,
    IYieldAaveProvider,
    IYieldAaveData
} from "./YieldInterfaces.sol";

/// @notice A single-USDT allocator, not an ERC-4626 share issuer or an arbitrary-call adapter.
/// @dev A production factory must additionally pin these validated identities to reviewed
/// canonical deployments. Protocol proxies remain an upstream governance/solvency risk.
/// Funding is a lifetime principal ceiling; recovery does not replenish it or turnover/loss.
contract YieldAllocationVault is StrategyVaultBase {
    error InvalidYieldPolicy();
    error InvalidVenue();
    error VenueUnavailable();
    error InvalidMove();
    error PrincipalExceeded();
    error TurnoverExceeded();
    error IdleReserveViolated();
    error ExposureExceeded();
    error ExecutionLossExceeded();
    error BalanceMismatch();
    error VenusFailure(uint256 code);

    uint256 private constant WAD = 1e18;
    uint256 private constant RAY = 1e27;
    uint256 private constant BPS = 10_000;
    uint8 public constant IDLE = 0;
    uint8 public constant VENUS = 1;
    uint8 public constant AAVE = 2;
    bytes32 public constant KIND = keccak256("aiki.yield-allocation.v1");

    struct Venues {
        address underlying;
        address venus;
        address comptroller;
        address aavePool;
        address aaveProvider;
        address aaveDataProvider;
        address aaveReceipt;
    }

    struct YieldPolicy {
        uint256 maxPrincipal;
        uint256 maxMove;
        uint256 maxTurnover;
        uint256 minIdle;
        uint256 maxVenusExposure;
        uint256 maxAaveExposure;
        uint256 maxLossPerMove;
        uint256 maxCumulativeLoss;
        uint16 maxLossBps;
    }

    struct Snapshot {
        uint256 idle;
        uint256 venusShares;
        uint256 aaveScaled;
        uint256 venusRate;
        uint256 aaveIndex;
    }

    address public immutable underlying;
    address public immutable venus;
    address public immutable comptroller;
    address public immutable aavePool;
    address public immutable aaveProvider;
    address public immutable aaveDataProvider;
    address public immutable aaveReceipt;
    YieldPolicy public limits;

    uint256 public fundedPrincipal;
    uint256 public turnover;
    uint256 public cumulativeLoss;
    uint256 public managedIdle;
    uint256 public managedVenusShares;
    uint256 public managedAaveScaled;

    event YieldFunded(address indexed owner, uint256 assets, uint256 fundedPrincipal);
    event YieldRecovered(address indexed owner, address indexed token, uint256 amount);
    event YieldMoved(
        uint256 indexed nonce,
        uint8 indexed source,
        uint8 indexed destination,
        uint256 requestedAssets,
        uint256 movedAssets,
        uint256 assetsBefore,
        uint256 assetsAfter,
        uint256 loss,
        uint256 idle,
        uint256 venusShares,
        uint256 aaveScaled
    );

    constructor(
        address controller_,
        CommonPolicy memory common,
        Venues memory venues,
        YieldPolicy memory policy
    )
        StrategyVaultBase(
            controller_,
            keccak256(abi.encode(KIND, block.chainid, controller_, common, venues, policy)),
            common
        )
    {
        if (
            block.chainid != 56 || policy.maxPrincipal == 0 || policy.maxMove == 0
                || policy.maxMove > policy.maxPrincipal || policy.maxTurnover < policy.maxMove
                || policy.minIdle > policy.maxPrincipal || policy.maxLossBps >= BPS
                || policy.maxLossPerMove > policy.maxMove || policy.maxCumulativeLoss < policy.maxLossPerMove
                || (policy.maxVenusExposure == 0 && policy.maxAaveExposure == 0)
        ) {
            revert InvalidYieldPolicy();
        }
        underlying = venues.underlying;
        venus = venues.venus;
        comptroller = venues.comptroller;
        aavePool = venues.aavePool;
        aaveProvider = venues.aaveProvider;
        aaveDataProvider = venues.aaveDataProvider;
        aaveReceipt = venues.aaveReceipt;
        limits = policy;
        _identities();
    }

    function strategyKind() external pure override returns (bytes32) {
        return KIND;
    }

    function operationSelector() external pure override returns (bytes4) {
        return this.reallocate.selector;
    }

    /// @notice Explicit owner funding only. Donations are recoverable, never new authority.
    function fund(uint256 assets) external onlyOwner nonReentrant {
        if (assets == 0 || fundedPrincipal + assets > limits.maxPrincipal) revert PrincipalExceeded();
        uint256 beforeBalance = StrategyToken.balance(underlying, address(this));
        StrategyToken.safeTransferFrom(underlying, msg.sender, address(this), assets);
        if (StrategyToken.balance(underlying, address(this)) != beforeBalance + assets) {
            revert BalanceMismatch();
        }
        fundedPrincipal += assets;
        managedIdle += assets;
        _invalidate();
        emit YieldFunded(msg.sender, assets, fundedPrincipal);
    }

    /// @notice Recover underlying or receipts without relying on protocol redemption/pricing.
    /// Pauses automation and invalidates outstanding plans. No arbitrary recipient is accepted.
    function recover(address token, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidMove();
        if (token != underlying && token != venus && token != aaveReceipt) revert InvalidVenue();
        uint256 beforeBalance = _balance(token);
        uint256 scaledBefore =
            token == aaveReceipt ? IYieldAToken(aaveReceipt).scaledBalanceOf(address(this)) : 0;
        StrategyToken.safeTransfer(token, msg.sender, amount);
        uint256 afterBalance = _balance(token);
        if (token == aaveReceipt) {
            // Indexed aToken transfers round through scaled units. Their displayed balance
            // delta can differ by one wei; recovery must not depend on exact ray rounding.
            if (afterBalance >= beforeBalance) revert BalanceMismatch();
            uint256 actual = beforeBalance - afterBalance;
            if (actual > amount + 1 || actual + 1 < amount) revert BalanceMismatch();
        } else if (afterBalance != beforeBalance - amount) {
            revert BalanceMismatch();
        }
        if (token == underlying) {
            managedIdle = _subtractFloor(managedIdle, amount);
        } else if (token == venus) {
            managedVenusShares = _subtractFloor(managedVenusShares, amount);
        } else {
            uint256 removed = scaledBefore - IYieldAToken(aaveReceipt).scaledBalanceOf(address(this));
            if (removed == 0) revert BalanceMismatch();
            managedAaveScaled = _subtractFloor(managedAaveScaled, removed);
        }
        paused = true;
        _invalidate();
        emit YieldRecovered(msg.sender, token, amount);
    }

    /// @notice Move a bounded amount of the same underlying. No recipient, asset or target input.
    /// `minReceived` can tighten, never replace, policy-enforced conservation.
    function reallocate(
        uint8 source,
        uint8 destination,
        uint256 assets,
        uint256 minReceived,
        uint256 expectedNonce,
        uint256 deadline
    ) external nonReentrant {
        _begin(expectedNonce, deadline);
        if (
            source > AAVE || destination > AAVE || source == destination || assets == 0
                || assets > limits.maxMove
        ) {
            revert InvalidMove();
        }
        _identities();
        Snapshot memory beforeState = _snapshot();
        uint256 assetsBefore = _value(beforeState);
        uint256 moved = _withdraw(source, assets, beforeState);
        if (moved == 0 || moved > assets || moved < minReceived) revert BalanceMismatch();
        if (destination != IDLE) {
            if (turnover + moved > limits.maxTurnover) revert TurnoverExceeded();
            _supply(destination, moved, beforeState.venusRate);
            turnover += moved;
        }
        Snapshot memory afterState = _snapshot();
        uint256 assetsAfter = _value(afterState);
        // A higher index/rate during an external call must not mask under-delivered
        // receipts. A lower rate must not escape a valuation frozen at the old rate.
        uint256 sameRateAssetsAfter = _value(
            Snapshot(
                afterState.idle,
                afterState.venusShares,
                afterState.aaveScaled,
                beforeState.venusRate,
                beforeState.aaveIndex
            )
        );
        uint256 protectedAssetsAfter = assetsAfter < sameRateAssetsAfter ? assetsAfter : sameRateAssetsAfter;
        uint256 loss = assetsBefore > protectedAssetsAfter ? assetsBefore - protectedAssetsAfter : 0;
        if (
            loss > limits.maxLossPerMove || loss > assets * limits.maxLossBps / BPS
                || cumulativeLoss + loss > limits.maxCumulativeLoss
        ) revert ExecutionLossExceeded();
        cumulativeLoss += loss;
        if (destination != IDLE && managedIdle < limits.minIdle) revert IdleReserveViolated();
        // A withdrawal remains possible when passive accrual has exceeded an exposure limit.
        // Every non-idle destination must satisfy both reviewed exposure bounds.
        if (
            destination != IDLE
                && (afterState.venusShares * afterState.venusRate / WAD > limits.maxVenusExposure
                    || afterState.aaveScaled * afterState.aaveIndex / RAY > limits.maxAaveExposure)
        ) revert ExposureExceeded();
        emit YieldMoved(
            operationNonce,
            source,
            destination,
            assets,
            moved,
            assetsBefore,
            assetsAfter,
            loss,
            managedIdle,
            managedVenusShares,
            managedAaveScaled
        );
        _finish(keccak256(msg.data));
    }

    function _withdraw(uint8 source, uint256 assets, Snapshot memory state)
        private
        returns (uint256 received)
    {
        if (source == IDLE) {
            if (assets > managedIdle) revert BalanceMismatch();
            return assets;
        }
        uint256 idleBefore = StrategyToken.balance(underlying, address(this));
        if (source == VENUS) {
            _venusReady(false, assets, state.venusRate);
            if (assets > managedVenusShares * state.venusRate / WAD) revert BalanceMismatch();
            uint256 sharesBefore = _balance(venus);
            uint256 code = IYieldVenus(venus).redeemUnderlying(assets);
            if (code != 0) revert VenusFailure(code);
            uint256 burned = sharesBefore - _balance(venus);
            if (burned == 0 || burned > managedVenusShares) revert BalanceMismatch();
            managedVenusShares -= burned;
        } else {
            _aaveReady(false, assets);
            if (assets > managedAaveScaled * state.aaveIndex / RAY) revert BalanceMismatch();
            uint256 scaledBefore = IYieldAToken(aaveReceipt).scaledBalanceOf(address(this));
            received = IYieldAavePool(aavePool).withdraw(underlying, assets, address(this));
            if (received != assets) revert BalanceMismatch();
            uint256 burned = scaledBefore - IYieldAToken(aaveReceipt).scaledBalanceOf(address(this));
            if (burned == 0 || burned > managedAaveScaled) revert BalanceMismatch();
            managedAaveScaled -= burned;
        }
        uint256 actual = StrategyToken.balance(underlying, address(this)) - idleBefore;
        if (source == AAVE && actual != received) revert BalanceMismatch();
        managedIdle += actual;
        return actual;
    }

    function _supply(uint8 destination, uint256 assets, uint256 venusRate) private {
        if (assets > managedIdle) revert BalanceMismatch();
        uint256 idleBefore = StrategyToken.balance(underlying, address(this));
        if (destination == VENUS) {
            _venusReady(true, assets, venusRate);
            uint256 sharesBefore = _balance(venus);
            StrategyToken.approveExact(underlying, venus, assets);
            uint256 code = IYieldVenus(venus).mint(assets);
            if (code != 0) revert VenusFailure(code);
            StrategyToken.approveExact(underlying, venus, 0);
            uint256 minted = _balance(venus) - sharesBefore;
            if (minted == 0) revert BalanceMismatch();
            managedVenusShares += minted;
        } else {
            _aaveReady(true, assets);
            uint256 scaledBefore = IYieldAToken(aaveReceipt).scaledBalanceOf(address(this));
            StrategyToken.approveExact(underlying, aavePool, assets);
            IYieldAavePool(aavePool).supply(underlying, assets, address(this), 0);
            StrategyToken.approveExact(underlying, aavePool, 0);
            uint256 minted = IYieldAToken(aaveReceipt).scaledBalanceOf(address(this)) - scaledBefore;
            if (minted == 0) revert BalanceMismatch();
            managedAaveScaled += minted;
        }
        if (StrategyToken.balance(underlying, address(this)) != idleBefore - assets) {
            revert BalanceMismatch();
        }
        managedIdle -= assets;
    }

    function _identities() private view {
        if (
            block.chainid != 56 || underlying == venus || underlying == aaveReceipt || venus == aaveReceipt
                || IYieldToken(underlying).decimals() != 18 || IYieldToken(venus).decimals() != 8
                || IYieldToken(aaveReceipt).decimals() != 18 || IYieldVenus(venus).underlying() != underlying
                || IYieldVenus(venus).comptroller() != comptroller
                || IYieldAToken(aaveReceipt).UNDERLYING_ASSET_ADDRESS() != underlying
                || IYieldAToken(aaveReceipt).POOL() != aavePool
                || IYieldAavePool(aavePool).ADDRESSES_PROVIDER() != aaveProvider
                || IYieldAaveProvider(aaveProvider).getPool() != aavePool
                || IYieldAaveData(aaveDataProvider).ADDRESSES_PROVIDER() != aaveProvider
        ) revert InvalidVenue();
        (address receipt,,) = IYieldAaveData(aaveDataProvider).getReserveTokensAddresses(underlying);
        if (receipt != aaveReceipt) revert InvalidVenue();
    }

    function _venusReady(bool supplying, uint256 assets, uint256 rate) private view {
        (bool listed,,,,,,) = IYieldComptroller(comptroller).markets(venus);
        if (
            !listed || IYieldComptroller(comptroller).protocolPaused()
                || IYieldComptroller(comptroller).actionPaused(venus, supplying ? 0 : 1)
        ) revert VenueUnavailable();
        if (supplying) {
            uint256 cap = IYieldComptroller(comptroller).supplyCaps(venus);
            if (IYieldToken(venus).totalSupply() * rate / WAD + assets > cap) revert VenueUnavailable();
        } else if (IYieldVenus(venus).getCash() < assets) {
            revert VenueUnavailable();
        }
    }

    function _aaveReady(bool supplying, uint256 assets) private view {
        (uint256 decimals,,,,,,,, bool active, bool frozen) =
            IYieldAaveData(aaveDataProvider).getReserveConfigurationData(underlying);
        if (decimals != 18 || !active || IYieldAaveData(aaveDataProvider).getPaused(underlying)) {
            revert VenueUnavailable();
        }
        if (supplying) {
            if (frozen) revert VenueUnavailable();
            (, uint256 cap) = IYieldAaveData(aaveDataProvider).getReserveCaps(underlying);
            // The Pool also checks accrued treasury at execution. Any tighter upstream cap
            // reverts the whole operation, including a preceding Venus redemption.
            if (cap != 0 && IYieldToken(aaveReceipt).totalSupply() + assets > cap * WAD) {
                revert VenueUnavailable();
            }
        } else if (
            StrategyToken.balance(underlying, aaveReceipt) < assets
                || IYieldAavePool(aavePool).getVirtualUnderlyingBalance(underlying) < assets
        ) {
            revert VenueUnavailable();
        }
    }

    function _snapshot() private returns (Snapshot memory) {
        uint256 venusRate = IYieldVenus(venus).exchangeRateCurrent();
        uint256 aaveIndex = IYieldAavePool(aavePool).getReserveNormalizedIncome(underlying);
        if (venusRate == 0 || aaveIndex < RAY) revert BalanceMismatch();
        return _holdings(venusRate, aaveIndex);
    }

    function _holdings(uint256 venusRate, uint256 aaveIndex) private view returns (Snapshot memory) {
        if (
            StrategyToken.balance(underlying, address(this)) < managedIdle
                || _balance(venus) < managedVenusShares
                || IYieldAToken(aaveReceipt).scaledBalanceOf(address(this)) < managedAaveScaled
        ) revert BalanceMismatch();
        return Snapshot(managedIdle, managedVenusShares, managedAaveScaled, venusRate, aaveIndex);
    }

    function _value(Snapshot memory state) private pure returns (uint256) {
        return
            state.idle + state.venusShares * state.venusRate / WAD + state.aaveScaled * state.aaveIndex / RAY;
    }

    function _balance(address token) private view returns (uint256) {
        // The canonical legacy vUSDT proxy returns a uint256 followed by trailing
        // ABI padding (96 bytes at mainnet block 121004566). A typed uint256 call
        // safely decodes that value and still rejects short/malformed results.
        // Keep StrategyToken's stricter exact-length contract for the other tokens.
        if (token == venus) return IYieldVenus(venus).balanceOf(address(this));
        return StrategyToken.balance(token, address(this));
    }

    function _subtractFloor(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}
