// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {StrategyVaultBase} from "../StrategyVaultBase.sol";
import {StrategyToken} from "../StrategyToken.sol";
import {PancakeMath} from "../pancake/PancakeMath.sol";
import {PancakeOracle} from "../pancake/PancakeOracle.sol";
import {ILPPositionManager, ILPRouter, ILPPool, ILPFactory} from "./IPancakeLP.sol";

/// @notice One immutable-policy, unstaked Pancake V3 position. No arbitrary calls or recipients.
/// @dev Owner enrollment is the only allocation. Fees may compound, but untracked ERC20
/// donations and unsolicited NFT liquidity increases never enlarge automated authority.
/// Quote units are the configured quote token's raw units, not dollars or mixed token units.
contract PancakeLPVault is StrategyVaultBase {
    bytes32 public constant KIND = keccak256("AIKI_PANCAKE_LP_V1");
    uint256 private constant BPS = 10_000;

    struct Protocol {
        address positionManager;
        address router;
        address pool;
        address quoteToken;
    }

    struct LPPolicy {
        uint32 twapWindow;
        uint24 maxDeviationTicks;
        uint128 minPoolLiquidity;
        int24 rangeWidth;
        uint24 maxCenterOffsetTicks;
        uint16 maxSwapSlippageBps;
        uint16 maxLiquiditySlippageBps;
        uint16 minSwapFillBps;
        uint16 minDeployedBps;
        uint16 maxLossBps;
        uint128 maxSwap0;
        uint128 maxSwap1;
        uint256 maxPositionValueQuote;
        uint256 maxLossQuote;
        uint256 maxCumulativeLossQuote;
    }

    struct RebalancePlan {
        uint256 expectedNonce;
        uint256 expectedTokenId;
        int24 tickLower;
        int24 tickUpper;
        bool zeroForOne;
        uint128 swapAmount;
        uint256 minSwapOut;
        uint160 sqrtPriceLimitX96;
        uint256 minBurn0;
        uint256 minBurn1;
        uint256 minMint0;
        uint256 minMint1;
        uint128 minLiquidity;
        uint256 deadline;
    }

    struct Inventory {
        uint256 amount0;
        uint256 amount1;
    }

    struct SwapFill {
        uint256 amountIn;
        uint256 amountOut;
    }

    struct MintResult {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0;
        uint256 amount1;
    }

    error InvalidConfiguration();
    error InvalidPosition();
    error InvalidPlan();
    error InventoryMismatch();
    error EconomicLimit();
    error NotEnrolling();

    event PositionEnrolled(uint256 indexed tokenId, uint128 liquidity, uint256 valueQuote);
    event Rebalanced(
        bytes32 indexed policyHash,
        uint256 indexed nonce,
        uint256 indexed oldTokenId,
        uint256 newTokenId,
        uint128 liquidity,
        uint256 amountIn,
        uint256 amountOut,
        uint256 lossQuote,
        uint256 idle0,
        uint256 idle1
    );
    event PositionWithdrawn(uint256 indexed tokenId, address indexed owner);
    event SurplusRecovered(address indexed token, uint256 amount);

    ILPPositionManager public immutable positionManager;
    ILPRouter public immutable router;
    address public immutable pool;
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    address public immutable quoteToken;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    LPPolicy public lpPolicy; // Written ONLY in the constructor; no policy setters.
    uint256 public currentTokenId;
    uint128 public positionLiquidity;
    uint256 public idle0;
    uint256 public idle1;
    uint256 public cumulativeLossQuote;
    bool public enrolled;
    uint256 private receivingTokenId;

    constructor(
        address controller_,
        CommonPolicy memory common,
        Protocol memory protocol,
        LPPolicy memory policy
    )
        StrategyVaultBase(
            controller_,
            keccak256(abi.encode(KIND, block.chainid, controller_, common, protocol, policy)),
            common
        )
    {
        if (
            protocol.positionManager.code.length == 0 || protocol.router.code.length == 0
                || protocol.pool.code.length == 0
        ) {
            revert InvalidConfiguration();
        }
        positionManager = ILPPositionManager(protocol.positionManager);
        router = ILPRouter(protocol.router);
        pool = protocol.pool;
        factory = ILPPool(pool).factory();
        token0 = ILPPool(pool).token0();
        token1 = ILPPool(pool).token1();
        fee = ILPPool(pool).fee();
        tickSpacing = ILPPool(pool).tickSpacing();
        quoteToken = protocol.quoteToken;
        if (
            factory.code.length == 0 || token0.code.length == 0 || token1.code.length == 0 || token0 >= token1
                || (quoteToken != token0 && quoteToken != token1) || fee >= 1_000_000 || tickSpacing <= 0
                || positionManager.factory() != factory || router.factory() != factory
                || positionManager.deployer() == address(0) || positionManager.deployer() != router.deployer()
                || ILPFactory(factory).poolDeployer() != router.deployer()
                || ILPFactory(factory).getPool(token0, token1, fee) != pool
        ) revert InvalidConfiguration();
        if (
            policy.twapWindow == 0 || policy.maxDeviationTicks == 0
                || policy.maxDeviationTicks > uint24(PancakeMath.MAX_TICK) || policy.minPoolLiquidity == 0
                || policy.rangeWidth <= 0 || policy.rangeWidth % tickSpacing != 0
                || policy.maxCenterOffsetTicks > policy.maxDeviationTicks || policy.maxSwapSlippageBps >= BPS
                || policy.maxLiquiditySlippageBps >= BPS || policy.minSwapFillBps == 0
                || policy.minSwapFillBps > BPS || policy.minDeployedBps == 0 || policy.minDeployedBps > BPS
                || policy.maxLossBps >= BPS || policy.maxPositionValueQuote == 0
                || policy.maxLossQuote > policy.maxCumulativeLossQuote
        ) {
            revert InvalidConfiguration();
        }
        lpPolicy = policy;
    }

    function strategyKind() external pure override returns (bytes32) {
        return KIND;
    }

    function operationSelector() external pure override returns (bytes4) {
        return this.rebalance.selector;
    }

    /// @notice Human grants approval for this NFT only, then enrolls it. No reinvestment/reset
    /// through a second enrollment; a withdrawn vault remains closed.
    function enroll(uint256 tokenId) external onlyOwner nonReentrant {
        if (
            enrolled || tokenId == 0 || block.timestamp >= expiresAt
                || positionManager.ownerOf(tokenId) != msg.sender
                || positionManager.getApproved(tokenId) != address(this)
        ) {
            revert InvalidPosition();
        }
        ILPPositionManager.Position memory p = _position(tokenId);
        if (p.liquidity == 0) revert InvalidPosition();
        (, int24 twap, uint160 sqrtPrice) = _oracle();
        (uint256 amount0, uint256 amount1) = PancakeMath.amountsForLiquidity(
            sqrtPrice,
            PancakeMath.sqrtRatioAtTick(p.tickLower),
            PancakeMath.sqrtRatioAtTick(p.tickUpper),
            p.liquidity
        );
        uint256 value = _value(twap, amount0 + p.tokensOwed0, amount1 + p.tokensOwed1);
        if (value == 0 || value > lpPolicy.maxPositionValueQuote) revert EconomicLimit();
        _invalidate();
        enrolled = true;
        currentTokenId = tokenId;
        positionLiquidity = p.liquidity;
        receivingTokenId = tokenId;
        positionManager.safeTransferFrom(msg.sender, address(this), tokenId);
        receivingTokenId = 0;
        if (positionManager.ownerOf(tokenId) != address(this)) revert InvalidPosition();
        emit PositionEnrolled(tokenId, p.liquidity, value);
    }

    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (
            msg.sender != address(positionManager) || receivingTokenId == 0 || tokenId != receivingTokenId
                || operator != address(this) || from == address(0)
        ) revert NotEnrolling();
        return this.onERC721Received.selector;
    }

    function rebalance(RebalancePlan calldata plan) external nonReentrant {
        _begin(plan.expectedNonce, plan.deadline);
        uint256 oldId = currentTokenId;
        if (
            oldId == 0 || oldId != plan.expectedTokenId || plan.minLiquidity == 0
                || positionManager.ownerOf(oldId) != address(this)
        ) revert InvalidPosition();
        ILPPositionManager.Position memory old = _position(oldId);
        if (old.liquidity != positionLiquidity || old.liquidity == 0) revert InvalidPosition();
        (int24 spot, int24 twap, uint160 sqrtPrice) = _oracle();
        _range(plan, twap, spot);
        (Inventory memory inventory, Inventory memory baseline) = _remove(plan, old, sqrtPrice);
        uint256 beforeValue = _value(twap, baseline.amount0, baseline.amount1);
        if (beforeValue == 0 || beforeValue > lpPolicy.maxPositionValueQuote) revert EconomicLimit();
        // A quote made with the old NFT still in the pool is not a post-removal quote.
        // Refuse inadequate remaining liquidity BEFORE calling the swap router.
        (,, sqrtPrice) = _oracle();
        uint160 swapStartPrice = sqrtPrice;
        SwapFill memory fill = _swap(plan, inventory, twap, sqrtPrice);
        // The original LP has now been removed. Check the remaining pool, not the old quote.
        (spot,, sqrtPrice) = _oracle();
        if (
            plan.swapAmount != 0
                && (plan.zeroForOne
                        ? sqrtPrice < plan.sqrtPriceLimitX96 || sqrtPrice > swapStartPrice
                        : sqrtPrice > plan.sqrtPriceLimitX96 || sqrtPrice < swapStartPrice)
        ) revert EconomicLimit();
        _range(plan, twap, spot);
        (uint256 newId, uint128 liquidity) = _mint(plan, inventory, sqrtPrice);
        (,, sqrtPrice) = _oracle();
        (uint256 deployed0, uint256 deployed1) = PancakeMath.amountsForLiquidity(
            sqrtPrice,
            PancakeMath.sqrtRatioAtTick(plan.tickLower),
            PancakeMath.sqrtRatioAtTick(plan.tickUpper),
            liquidity
        );
        uint256 deployedValue = _value(twap, deployed0, deployed1);
        uint256 afterValue = deployedValue + _value(twap, inventory.amount0, inventory.amount1);
        if (
            deployedValue == 0
                || deployedValue < PancakeMath.mulDivRoundingUp(afterValue, lpPolicy.minDeployedBps, BPS)
        ) {
            revert EconomicLimit();
        }
        uint256 loss = beforeValue > afterValue ? beforeValue - afterValue : 0;
        if (
            loss > lpPolicy.maxLossQuote || loss > PancakeMath.mulDiv(beforeValue, lpPolicy.maxLossBps, BPS)
                || cumulativeLossQuote + loss > lpPolicy.maxCumulativeLossQuote
        ) revert EconomicLimit();
        cumulativeLossQuote += loss; // Gains NEVER replenish this budget.
        positionManager.burn(oldId);
        currentTokenId = newId;
        positionLiquidity = liquidity;
        idle0 = inventory.amount0;
        idle1 = inventory.amount1;
        emit Rebalanced(
            policyHash,
            operationNonce,
            oldId,
            newId,
            liquidity,
            fill.amountIn,
            fill.amountOut,
            loss,
            idle0,
            idle1
        );
        _finish(keccak256(abi.encode(plan)));
    }

    function _remove(RebalancePlan calldata plan, ILPPositionManager.Position memory old, uint160 sqrtPrice)
        private
        returns (Inventory memory inventory, Inventory memory baseline)
    {
        uint256 balance0 = StrategyToken.balance(token0, address(this));
        uint256 balance1 = StrategyToken.balance(token1, address(this));
        if (balance0 < idle0 || balance1 < idle1) revert InventoryMismatch();
        (uint256 expected0, uint256 expected1) = PancakeMath.amountsForLiquidity(
            sqrtPrice,
            PancakeMath.sqrtRatioAtTick(old.tickLower),
            PancakeMath.sqrtRatioAtTick(old.tickUpper),
            old.liquidity
        );
        uint256 min0 = _max(plan.minBurn0, _liquidityMinimum(expected0));
        uint256 min1 = _max(plan.minBurn1, _liquidityMinimum(expected1));
        (uint256 burned0, uint256 burned1) = positionManager.decreaseLiquidity(
            ILPPositionManager.DecreaseLiquidityParams(
                currentTokenId, old.liquidity, min0, min1, plan.deadline
            )
        );
        if (burned0 < min0 || burned1 < min1) revert EconomicLimit();
        (uint256 collected0, uint256 collected1) = positionManager.collect(
            ILPPositionManager.CollectParams(
                currentTokenId, address(this), type(uint128).max, type(uint128).max
            )
        );
        if (
            StrategyToken.balance(token0, address(this)) != balance0 + collected0
                || StrategyToken.balance(token1, address(this)) != balance1 + collected1
                || collected0 < burned0 || collected1 < burned1
        ) revert InventoryMismatch();
        // Spend ONLY actual receipts. Value the whole operation against the canonical
        // pre-burn principal plus fees (collected minus burned), never less than
        // already recorded tokensOwed. This also counts any known collect shortfall.
        // A burn-side shortfall inside the burn-minimum tolerance must still consume
        // the execution-loss budget. Fees appear on BOTH sides, never as an offset.
        inventory = Inventory(idle0 + collected0, idle1 + collected1);
        baseline = Inventory(
            idle0 + expected0 + _max(old.tokensOwed0, collected0 - burned0),
            idle1 + expected1 + _max(old.tokensOwed1, collected1 - burned1)
        );
    }

    function _swap(RebalancePlan calldata plan, Inventory memory inventory, int24 twap, uint160 sqrtPrice)
        private
        returns (SwapFill memory fill)
    {
        if (plan.swapAmount == 0) {
            if (plan.minSwapOut != 0 || plan.sqrtPriceLimitX96 != 0) revert InvalidPlan();
            return fill;
        }
        bool zeroForOne = plan.zeroForOne;
        address input = zeroForOne ? token0 : token1;
        address output = zeroForOne ? token1 : token0;
        if (
            plan.swapAmount > (zeroForOne ? lpPolicy.maxSwap0 : lpPolicy.maxSwap1)
                || plan.swapAmount > (zeroForOne ? inventory.amount0 : inventory.amount1)
        ) revert EconomicLimit();
        int256 boundaryTick = int256(twap)
            + (zeroForOne
                    ? -int256(uint256(lpPolicy.maxDeviationTicks))
                    : int256(uint256(lpPolicy.maxDeviationTicks)));
        if (boundaryTick <= PancakeMath.MIN_TICK || boundaryTick >= PancakeMath.MAX_TICK) {
            revert InvalidPlan();
        }
        uint160 boundary = PancakeMath.sqrtRatioAtTick(int24(boundaryTick));
        uint160 limit = plan.sqrtPriceLimitX96;
        if (zeroForOne ? (limit < boundary || limit >= sqrtPrice) : (limit > boundary || limit <= sqrtPrice))
        {
            revert InvalidPlan();
        }
        uint256 minInput = PancakeMath.mulDivRoundingUp(plan.swapAmount, lpPolicy.minSwapFillBps, BPS);
        uint256 minimum = _max(plan.minSwapOut, _swapMinimum(twap, uint128(minInput), input, output));
        if (minimum == 0) revert EconomicLimit();
        uint256 inputBefore = StrategyToken.balance(input, address(this));
        uint256 outputBefore = StrategyToken.balance(output, address(this));
        StrategyToken.approveExact(input, address(router), plan.swapAmount);
        uint256 reportedOutput = router.exactInputSingle(
            ILPRouter.ExactInputSingleParams(
                input, output, fee, address(this), plan.deadline, plan.swapAmount, minimum, limit
            )
        );
        StrategyToken.approveExact(input, address(router), 0);
        uint256 inputAfter = StrategyToken.balance(input, address(this));
        uint256 outputAfter = StrategyToken.balance(output, address(this));
        if (inputAfter > inputBefore || outputAfter < outputBefore) revert InventoryMismatch();
        fill = SwapFill(inputBefore - inputAfter, outputAfter - outputBefore);
        if (
            fill.amountIn < minInput || fill.amountIn > plan.swapAmount || fill.amountOut != reportedOutput
                || fill.amountOut < minimum
                || fill.amountOut < _swapMinimum(twap, uint128(fill.amountIn), input, output)
        ) revert EconomicLimit();
        if (zeroForOne) {
            inventory.amount0 -= fill.amountIn;
            inventory.amount1 += fill.amountOut;
        } else {
            inventory.amount1 -= fill.amountIn;
            inventory.amount0 += fill.amountOut;
        }
    }

    function _mint(RebalancePlan calldata plan, Inventory memory inventory, uint160 sqrtPrice)
        private
        returns (uint256 newId, uint128 liquidity)
    {
        (ILPPositionManager.MintParams memory params, uint128 expectedLiquidity) =
            _mintParams(plan, inventory, sqrtPrice);
        Inventory memory beforeBalances = Inventory(
            StrategyToken.balance(token0, address(this)), StrategyToken.balance(token1, address(this))
        );
        StrategyToken.approveExact(token0, address(positionManager), inventory.amount0);
        StrategyToken.approveExact(token1, address(positionManager), inventory.amount1);
        MintResult memory minted;
        (minted.tokenId, minted.liquidity, minted.amount0, minted.amount1) = positionManager.mint(params);
        StrategyToken.approveExact(token0, address(positionManager), 0);
        StrategyToken.approveExact(token1, address(positionManager), 0);
        if (
            minted.amount0 > inventory.amount0 || minted.amount1 > inventory.amount1
                || minted.amount0 < params.amount0Min || minted.amount1 < params.amount1Min
                || StrategyToken.balance(token0, address(this)) != beforeBalances.amount0 - minted.amount0
                || StrategyToken.balance(token1, address(this)) != beforeBalances.amount1 - minted.amount1
        ) {
            revert InventoryMismatch();
        }
        _verifyMint(plan, minted, expectedLiquidity);
        inventory.amount0 -= minted.amount0;
        inventory.amount1 -= minted.amount1;
        return (minted.tokenId, minted.liquidity);
    }

    function _mintParams(RebalancePlan calldata plan, Inventory memory inventory, uint160 sqrtPrice)
        private
        view
        returns (ILPPositionManager.MintParams memory params, uint128 expectedLiquidity)
    {
        uint160 sqrtA = PancakeMath.sqrtRatioAtTick(plan.tickLower);
        uint160 sqrtB = PancakeMath.sqrtRatioAtTick(plan.tickUpper);
        expectedLiquidity =
            PancakeMath.liquidityForAmounts(sqrtPrice, sqrtA, sqrtB, inventory.amount0, inventory.amount1);
        (uint256 expected0, uint256 expected1) =
            PancakeMath.amountsForLiquidity(sqrtPrice, sqrtA, sqrtB, expectedLiquidity);
        params = ILPPositionManager.MintParams(
            token0,
            token1,
            fee,
            plan.tickLower,
            plan.tickUpper,
            inventory.amount0,
            inventory.amount1,
            _max(plan.minMint0, _liquidityMinimum(expected0)),
            _max(plan.minMint1, _liquidityMinimum(expected1)),
            address(this),
            plan.deadline
        );
    }

    function _verifyMint(RebalancePlan calldata plan, MintResult memory minted, uint128 expectedLiquidity)
        private
        view
    {
        ILPPositionManager.Position memory p = _position(minted.tokenId);
        if (
            minted.tokenId == 0 || minted.tokenId == currentTokenId
                || positionManager.ownerOf(minted.tokenId) != address(this) || minted.liquidity == 0
                || minted.liquidity < plan.minLiquidity
                || minted.liquidity < _liquidityMinimum(expectedLiquidity) || p.liquidity != minted.liquidity
                || p.tickLower != plan.tickLower || p.tickUpper != plan.tickUpper
        ) {
            revert InvalidPosition();
        }
    }

    /// @notice Returns the whole NFT (without forced redemption) and all idle tokens.
    /// Works when paused/expired or an upstream swap/oracle is unavailable.
    function withdrawPosition() external onlyOwner nonReentrant {
        uint256 id = currentTokenId;
        if (id == 0) revert InvalidPosition();
        _invalidate();
        currentTokenId = 0;
        positionLiquidity = 0;
        idle0 = 0;
        idle1 = 0;
        positionManager.safeTransferFrom(address(this), msg.sender, id);
        StrategyToken.safeTransfer(token0, msg.sender, StrategyToken.balance(token0, address(this)));
        StrategyToken.safeTransfer(token1, msg.sender, StrategyToken.balance(token1, address(this)));
        emit PositionWithdrawn(id, msg.sender);
    }

    /// @notice Donated ERC20 balances are recoverable but never enter automated inventory.
    function recoverSurplus(address token) external onlyOwner nonReentrant {
        uint256 tracked = token == token0 ? idle0 : token == token1 ? idle1 : 0;
        uint256 amount = StrategyToken.balance(token, address(this)) - tracked;
        _invalidate();
        StrategyToken.safeTransfer(token, msg.sender, amount);
        emit SurplusRecovered(token, amount);
    }

    function recoverUntrackedNFT(uint256 tokenId) external onlyOwner nonReentrant {
        if (tokenId == currentTokenId) revert InvalidPosition();
        _invalidate();
        positionManager.safeTransferFrom(address(this), msg.sender, tokenId);
    }

    function _position(uint256 tokenId) private view returns (ILPPositionManager.Position memory p) {
        p = positionManager.positions(tokenId);
        if (
            p.token0 != token0 || p.token1 != token1 || p.fee != fee || p.tickLower < PancakeMath.MIN_TICK
                || p.tickUpper > PancakeMath.MAX_TICK || p.tickLower >= p.tickUpper
                || p.tickLower % tickSpacing != 0 || p.tickUpper % tickSpacing != 0
        ) {
            revert InvalidPosition();
        }
    }

    function _oracle() private view returns (int24 spot, int24 twap, uint160 sqrtPrice) {
        return PancakeOracle.checkedState(
            pool, lpPolicy.twapWindow, lpPolicy.maxDeviationTicks, lpPolicy.minPoolLiquidity
        );
    }

    function _range(RebalancePlan calldata plan, int24 twap, int24 spot) private view {
        if (
            plan.tickLower < PancakeMath.MIN_TICK || plan.tickUpper > PancakeMath.MAX_TICK
                || int256(plan.tickUpper) - plan.tickLower != lpPolicy.rangeWidth
                || plan.tickLower % tickSpacing != 0 || plan.tickUpper % tickSpacing != 0
                || spot <= plan.tickLower || spot >= plan.tickUpper
        ) revert InvalidPlan();
        int256 twiceOffset = int256(plan.tickLower) + plan.tickUpper - int256(twap) * 2;
        if (twiceOffset < 0) twiceOffset = -twiceOffset;
        if (uint256(twiceOffset) > uint256(lpPolicy.maxCenterOffsetTicks) * 2) revert InvalidPlan();
    }

    function _value(int24 twap, uint256 amount0, uint256 amount1) private view returns (uint256) {
        if (amount0 > type(uint128).max || amount1 > type(uint128).max) revert EconomicLimit();
        return quoteToken == token0
            ? amount0 + PancakeMath.quoteAtTick(twap, uint128(amount1), token1, token0)
            : amount1 + PancakeMath.quoteAtTick(twap, uint128(amount0), token0, token1);
    }

    function _swapMinimum(int24 twap, uint128 amount, address input, address output)
        private
        view
        returns (uint256)
    {
        uint256 quote = PancakeMath.quoteAtTick(twap, amount, input, output);
        quote = PancakeMath.mulDiv(quote, 1_000_000 - fee, 1_000_000);
        return PancakeMath.mulDiv(quote, BPS - lpPolicy.maxSwapSlippageBps, BPS);
    }

    function _liquidityMinimum(uint256 amount) private view returns (uint256) {
        return PancakeMath.mulDiv(amount, BPS - lpPolicy.maxLiquiditySlippageBps, BPS);
    }

    function _max(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a : b;
    }
}
