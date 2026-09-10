// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {StrategyVaultBase} from "../StrategyVaultBase.sol";
import {StrategyToken} from "../StrategyToken.sol";
import {PancakeMath} from "../pancake/PancakeMath.sol";
import {PancakeOracle} from "../pancake/PancakeOracle.sol";
import {IGridPool, IGridFactory, IGridRouter, IGridTokenMetadata} from "./GridInterfaces.sol";

/// @notice Separately funded, fixed-pool spot grid. The controller can only observe or trade
/// one rung. Its human owner retains funding, pause and recovery authority through the base.
/// @dev Token0 is the base asset; ticks price token0 in token1 RAW units. No amount supplied
/// by the executor determines a lot, recipient, spender, price floor or price limit.
contract GridStrategyVault is StrategyVaultBase {
    struct Protocol {
        address router;
        address factory;
        address pool;
        address token0;
        address token1;
    }

    struct GridPolicy {
        int24 tickLower;
        int24 tickUpper;
        uint128 maxInput0;
        uint128 maxInput1;
        // Lifetime explicit owner funding, not a token balance that donations can enlarge.
        uint256 fundingCap0;
        uint256 fundingCap1;
        uint256 turnoverCap0;
        uint256 turnoverCap1;
        uint32 twapWindow;
        uint24 maxDeviationTicks;
        uint128 minLiquidity;
        uint16 maxSlippageBps;
        uint16 minFillBps;
        // Minimum theoretical round-trip edge after BOTH fees and BOTH slippage allowances.
        // This excludes gas and is not a guarantee of realized profit or future price recovery.
        uint16 minCycleGainBps;
        uint24 hysteresisTicks;
    }

    struct RungPolicy {
        int24 buyTick;
        int24 sellTick;
        uint128 lot0;
        uint128 lot1;
        bool initialSell;
    }

    struct RungState {
        uint256 inventory0;
        uint256 inventory1;
        uint64 cycle;
        bool nextSell;
        bool armed;
    }

    error InvalidConfiguration();
    error InvalidProtocol();
    error InvalidRung();
    error FundingLimit();
    error InventoryShortfall();
    error UnsupportedToken();
    error TurnoverLimit();
    error InvalidFill();

    address public immutable router;
    address public immutable factory;
    address public immutable pool;
    address public immutable token0;
    address public immutable token1;
    address public immutable poolDeployer;
    uint24 public immutable fee;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable routerCodeHash;
    bytes32 public immutable poolCodeHash;
    bytes32 public immutable factoryCodeHash;
    bytes32 public immutable token0CodeHash;
    bytes32 public immutable token1CodeHash;
    bytes32 public immutable deployerCodeHash;

    GridPolicy private _gridPolicy;
    RungPolicy[] private _rungPolicies;
    RungState[] private _rungs;
    uint256 public allocated0;
    uint256 public allocated1;
    uint256 public funded0;
    uint256 public funded1;
    uint256 public turnover0;
    uint256 public turnover1;
    bool public initialized;
    uint256 public observationNonce;
    int24 public lastObservedTick;

    event GridFunded(uint32 indexed rung, uint256 amount0, uint256 amount1);
    event GridWithdrawn(uint32 indexed rung, address indexed recipient, uint256 amount0, uint256 amount1);
    event GridObserved(uint256 indexed operationNonce, int24 spot, int24 twap, bool baseline);
    event GridFilled(
        uint256 indexed operationNonce,
        uint32 indexed rung,
        uint64 cycle,
        bool soldToken0,
        uint256 actualInput,
        uint256 actualOutput,
        uint256 inventory0,
        uint256 inventory1
    );

    constructor(
        address controller_,
        CommonPolicy memory common,
        Protocol memory protocol,
        GridPolicy memory policy,
        RungPolicy[] memory rungs_
    )
        StrategyVaultBase(
            controller_,
            keccak256(
                abi.encode(
                    "AIKI_PANCAKE_GRID_V1", block.chainid, controller_, common, protocol, policy, rungs_
                )
            ),
            common
        )
    {
        if (
            protocol.router.code.length == 0 || protocol.factory.code.length == 0
                || protocol.pool.code.length == 0 || protocol.token0.code.length == 0
                || protocol.token1.code.length == 0 || protocol.token0 >= protocol.token1
        ) revert InvalidProtocol();
        uint24 poolFee = IGridPool(protocol.pool).fee();
        address deployer = IGridRouter(protocol.router).deployer();
        if (
            poolFee == 0 || poolFee >= 1_000_000 || deployer.code.length == 0
                || IGridRouter(protocol.router).factory() != protocol.factory
                || IGridFactory(protocol.factory).poolDeployer() != deployer
                || IGridPool(protocol.pool).factory() != protocol.factory
                || IGridPool(protocol.pool).token0() != protocol.token0
                || IGridPool(protocol.pool).token1() != protocol.token1
                || IGridFactory(protocol.factory).getPool(protocol.token0, protocol.token1, poolFee)
                    != protocol.pool || IGridTokenMetadata(protocol.token0).decimals() > 36
                || IGridTokenMetadata(protocol.token1).decimals() > 36
        ) revert InvalidProtocol();
        if (
            common.minInterval == 0 || common.maxDeadlineDelay > 5 minutes
                || policy.tickLower <= PancakeMath.MIN_TICK || policy.tickUpper >= PancakeMath.MAX_TICK
                || policy.tickLower >= policy.tickUpper || policy.maxInput0 == 0 || policy.maxInput1 == 0
                || (policy.fundingCap0 == 0 && policy.fundingCap1 == 0)
                || policy.turnoverCap0 < policy.maxInput0 || policy.turnoverCap1 < policy.maxInput1
                || policy.twapWindow < 60 || policy.twapWindow > 1 days || policy.minLiquidity == 0
                || policy.maxDeviationTicks > 10_000 || policy.maxSlippageBps > 500 || policy.minFillBps < 100
                || policy.minFillBps > 10_000 || policy.minCycleGainBps == 0
                || policy.minCycleGainBps > 10_000 || policy.hysteresisTicks == 0 || rungs_.length == 0
                || rungs_.length > 32
        ) revert InvalidConfiguration();
        router = protocol.router;
        factory = protocol.factory;
        pool = protocol.pool;
        token0 = protocol.token0;
        token1 = protocol.token1;
        poolDeployer = deployer;
        fee = poolFee;
        deploymentChainId = block.chainid;
        routerCodeHash = protocol.router.codehash;
        factoryCodeHash = protocol.factory.codehash;
        poolCodeHash = protocol.pool.codehash;
        token0CodeHash = protocol.token0.codehash;
        token1CodeHash = protocol.token1.codehash;
        deployerCodeHash = deployer.codehash;
        _gridPolicy = policy;
        for (uint256 i; i < rungs_.length; ++i) {
            RungPolicy memory r = rungs_[i];
            int256 width = int256(r.sellTick) - r.buyTick;
            if (
                r.buyTick <= policy.tickLower || r.sellTick >= policy.tickUpper
                    || width <= int256(uint256(policy.hysteresisTicks)) * 2 || width > PancakeMath.MAX_TICK
                    || r.lot0 == 0 || r.lot1 == 0 || r.lot0 > policy.maxInput0 || r.lot1 > policy.maxInput1
                    || (i > 0 && (r.buyTick <= rungs_[i - 1].buyTick || r.sellTick <= rungs_[i - 1].sellTick))
            ) revert InvalidConfiguration();
            uint256 roundTrip = PancakeMath.quoteAtTick(int24(width), 1e18, address(1), address(2));
            roundTrip = _discount(
                _discount(roundTrip, poolFee, policy.maxSlippageBps), poolFee, policy.maxSlippageBps
            );
            if (roundTrip < PancakeMath.mulDivRoundingUp(1e18, 10_000 + policy.minCycleGainBps, 10_000)) {
                revert InvalidConfiguration();
            }
            _rungPolicies.push(r);
            _rungs.push(RungState(0, 0, 0, r.initialSell, false));
        }
    }

    function strategyKind() external pure override returns (bytes32) {
        return keccak256("AIKI_PANCAKE_GRID_V1");
    }

    function operationSelector() external pure override returns (bytes4) {
        return this.execute.selector;
    }

    function gridPolicy() external view returns (GridPolicy memory) {
        return _gridPolicy;
    }

    function rungCount() external view returns (uint256) {
        return _rungs.length;
    }

    function rungPolicy(uint32 index) external view returns (RungPolicy memory) {
        return _rungPolicies[index];
    }

    function rungState(uint32 index) external view returns (RungState memory) {
        return _rungs[index];
    }

    /// @notice Explicit funding only; neither donations nor previous trading proceeds increase these caps.
    function fund(uint32 index, uint256 amount0, uint256 amount1) external onlyOwner nonReentrant {
        if (index >= _rungs.length || (amount0 == 0 && amount1 == 0)) revert InvalidRung();
        if (funded0 + amount0 > _gridPolicy.fundingCap0 || funded1 + amount1 > _gridPolicy.fundingCap1) {
            revert FundingLimit();
        }
        _receiveExact(token0, amount0);
        _receiveExact(token1, amount1);
        funded0 += amount0;
        funded1 += amount1;
        allocated0 += amount0;
        allocated1 += amount1;
        _rungs[index].inventory0 += amount0;
        _rungs[index].inventory1 += amount1;
        _invalidate();
        emit GridFunded(index, amount0, amount1);
    }

    /// @notice Recovery remains available after expiry, while paused, and if the pool/oracle is unusable.
    function withdraw(uint32 index, uint256 amount0, uint256 amount1, address recipient)
        external
        onlyOwner
        nonReentrant
    {
        if (index >= _rungs.length || recipient == address(0) || recipient == address(this)) {
            revert InvalidRung();
        }
        RungState storage r = _rungs[index];
        if (amount0 > r.inventory0 || amount1 > r.inventory1) revert InventoryShortfall();
        r.inventory0 -= amount0;
        r.inventory1 -= amount1;
        allocated0 -= amount0;
        allocated1 -= amount1;
        _invalidate();
        _sendExact(token0, recipient, amount0);
        _sendExact(token1, recipient, amount1);
        emit GridWithdrawn(index, recipient, amount0, amount1);
    }

    /// @notice Donations/foreign tokens can be recovered, never allocated by the executor.
    function recoverSurplus(address token, uint256 amount, address recipient)
        external
        onlyOwner
        nonReentrant
    {
        if (recipient == address(0) || recipient == address(this)) revert InvalidConfiguration();
        uint256 accounted = token == token0 ? allocated0 : token == token1 ? allocated1 : 0;
        uint256 held = StrategyToken.balance(token, address(this));
        if (held < accounted || amount > held - accounted) revert InventoryShortfall();
        _invalidate();
        _sendExact(token, recipient, amount);
    }

    /// @notice At most one selected rung trades. Every successful observation persists arming
    /// for all rungs. First observation after any owner nonce invalidation NEVER trades.
    function execute(uint256 expectedNonce, uint256 deadline, uint32 index)
        external
        nonReentrant
        returns (bool filled)
    {
        if (index >= _rungs.length) revert InvalidRung();
        bool baseline = !initialized || observationNonce != expectedNonce;
        bytes32 priorRung = keccak256(abi.encode(_rungs[index]));
        _begin(expectedNonce, deadline);
        _checkIdentity();
        _checkInventory();
        (int24 spot, int24 twap, uint160 sqrtPrice) = PancakeOracle.checkedState(
            pool, _gridPolicy.twapWindow, _gridPolicy.maxDeviationTicks, _gridPolicy.minLiquidity
        );
        for (uint256 i; i < _rungs.length; ++i) {
            RungState storage s = _rungs[i];
            RungPolicy storage p = _rungPolicies[i];
            if (baseline) s.armed = false;
            if (s.nextSell
                    ? int256(spot) <= int256(p.sellTick) - int256(uint256(_gridPolicy.hysteresisTicks))
                    : int256(spot) >= int256(p.buyTick) + int256(uint256(_gridPolicy.hysteresisTicks))) {
                s.armed = true;
            }
        }
        if (!baseline && spot >= _gridPolicy.tickLower && spot < _gridPolicy.tickUpper) {
            filled = _trade(index, spot, twap, sqrtPrice, deadline);
        }
        initialized = true;
        observationNonce = operationNonce;
        lastObservedTick = spot;
        emit GridObserved(operationNonce, spot, twap, baseline);
        _finish(
            keccak256(abi.encode(policyHash, expectedNonce, deadline, index, priorRung, baseline, spot, twap))
        );
    }

    function minimumOutput(uint32 index, bool sell, uint128 amountIn, int24 twap)
        public
        view
        returns (uint256)
    {
        RungPolicy storage r = _rungPolicies[index];
        address input = sell ? token0 : token1;
        address output = sell ? token1 : token0;
        uint256 atRung = PancakeMath.quoteAtTick(sell ? r.sellTick : r.buyTick, amountIn, input, output);
        uint256 atOracle = PancakeMath.quoteAtTick(twap, amountIn, input, output);
        uint256 bound = atRung > atOracle ? atRung : atOracle;
        return _discount(bound, fee, _gridPolicy.maxSlippageBps);
    }

    function _trade(uint32 index, int24 spot, int24 twap, uint160 sqrtPrice, uint256 deadline)
        private
        returns (bool)
    {
        RungState storage s = _rungs[index];
        RungPolicy storage p = _rungPolicies[index];
        bool sell = s.nextSell;
        if (!s.armed || (sell ? spot < p.sellTick : spot > p.buyTick)) return false;
        uint160 limit = PancakeMath.sqrtRatioAtTick(sell ? p.sellTick : p.buyTick);
        // Pool limits must be STRICTLY on the other side of its current sqrt price.
        if (sell ? sqrtPrice <= limit : sqrtPrice >= limit) return false;
        uint256 available = sell ? s.inventory0 : s.inventory1;
        uint128 lot = sell ? p.lot0 : p.lot1;
        uint128 input = available < lot ? uint128(available) : lot;
        if (input == 0) return false;
        if (sell
                ? turnover0 + input > _gridPolicy.turnoverCap0
                : turnover1 + input > _gridPolicy.turnoverCap1) {
            revert TurnoverLimit();
        }
        uint128 minInput = uint128(PancakeMath.mulDivRoundingUp(input, _gridPolicy.minFillBps, 10_000));
        uint256 floor = minimumOutput(index, sell, minInput, twap);
        if (floor == 0) revert InvalidFill();
        address inputToken = sell ? token0 : token1;
        address outputToken = sell ? token1 : token0;
        uint256 inputBefore = StrategyToken.balance(inputToken, address(this));
        uint256 outputBefore = StrategyToken.balance(outputToken, address(this));
        StrategyToken.approveExact(inputToken, router, input);
        uint256 reported = IGridRouter(router)
            .exactInputSingle(
                IGridRouter.ExactInputSingleParams({
                tokenIn: inputToken,
                tokenOut: outputToken,
                fee: fee,
                recipient: address(this),
                deadline: deadline,
                amountIn: input,
                amountOutMinimum: floor,
                sqrtPriceLimitX96: limit
            })
            );
        StrategyToken.approveExact(inputToken, router, 0);
        uint256 inputAfter = StrategyToken.balance(inputToken, address(this));
        uint256 outputAfter = StrategyToken.balance(outputToken, address(this));
        if (inputAfter > inputBefore || outputAfter < outputBefore) revert InvalidFill();
        uint256 spent = inputBefore - inputAfter;
        uint256 received = outputAfter - outputBefore;
        if (
            spent < minInput || spent > input || received == 0 || received != reported
                || received < minimumOutput(index, sell, uint128(spent), twap)
        ) revert InvalidFill();
        (int24 postSpot,, uint160 postPrice) = PancakeOracle.checkedState(
            pool, _gridPolicy.twapWindow, _gridPolicy.maxDeviationTicks, _gridPolicy.minLiquidity
        );
        if (sell ? postPrice < limit : postPrice > limit) revert InvalidFill();
        if (sell) {
            s.inventory0 -= spent;
            s.inventory1 += received;
            allocated0 -= spent;
            allocated1 += received;
            turnover0 += spent;
        } else {
            s.inventory1 -= spent;
            s.inventory0 += received;
            allocated1 -= spent;
            allocated0 += received;
            turnover1 += spent;
        }
        s.nextSell = !sell;
        // The bounded fill itself observes the opposite side of the NEXT trigger.
        // Persist this fact now: a direct jump to that trigger after a restart must
        // not require a fictitious intermediate observation or repeat this fill.
        s.armed = sell
            ? int256(postSpot) >= int256(p.buyTick) + int256(uint256(_gridPolicy.hysteresisTicks))
            : int256(postSpot) <= int256(p.sellTick) - int256(uint256(_gridPolicy.hysteresisTicks));
        // A cycle is a completed BUY+SELL or SELL+BUY pair, never a retry counter.
        uint64 cycle = s.cycle;
        if (s.nextSell == p.initialSell) s.cycle++;
        _checkInventory();
        emit GridFilled(operationNonce, index, cycle, sell, spent, received, s.inventory0, s.inventory1);
        return true;
    }

    function _discount(uint256 quote, uint24 poolFee, uint16 slippage) private pure returns (uint256) {
        return PancakeMath.mulDiv(
            PancakeMath.mulDiv(quote, 1_000_000 - poolFee, 1_000_000), 10_000 - slippage, 10_000
        );
    }

    function _checkIdentity() private view {
        if (
            block.chainid != deploymentChainId || router.codehash != routerCodeHash
                || pool.codehash != poolCodeHash || factory.codehash != factoryCodeHash
                || token0.codehash != token0CodeHash || token1.codehash != token1CodeHash
                || poolDeployer.codehash != deployerCodeHash
        ) revert InvalidProtocol();
    }

    function _checkInventory() private view {
        if (
            StrategyToken.balance(token0, address(this)) < allocated0
                || StrategyToken.balance(token1, address(this)) < allocated1
        ) revert InventoryShortfall();
    }

    function _receiveExact(address token, uint256 amount) private {
        if (amount == 0) return;
        uint256 beforeVault = StrategyToken.balance(token, address(this));
        uint256 beforeOwner = StrategyToken.balance(token, msg.sender);
        StrategyToken.safeTransferFrom(token, msg.sender, address(this), amount);
        if (
            StrategyToken.balance(token, address(this)) != beforeVault + amount
                || StrategyToken.balance(token, msg.sender) + amount != beforeOwner
        ) revert UnsupportedToken();
    }

    function _sendExact(address token, address recipient, uint256 amount) private {
        if (amount == 0) return;
        uint256 beforeVault = StrategyToken.balance(token, address(this));
        uint256 beforeRecipient = StrategyToken.balance(token, recipient);
        StrategyToken.safeTransfer(token, recipient, amount);
        if (
            StrategyToken.balance(token, address(this)) + amount != beforeVault
                || StrategyToken.balance(token, recipient) != beforeRecipient + amount
        ) revert UnsupportedToken();
    }
}
