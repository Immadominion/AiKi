// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {PancakeMath} from "./PancakeMath.sol";

interface IPancakeOraclePool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint32, bool);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory);
    function observations(uint256 index) external view returns (uint32, int56, uint160, bool);
    function liquidity() external view returns (uint128);
}

/// @dev consult/retained-history math ported from Pancake OracleLibrary at commit
/// 986847948755cba528324d41be19480731c36c2a (see PancakeMath.sol for provenance).
/// Cumulative subtraction intentionally wraps, as in Pancake's Solidity 0.7 pool.
/// Additional validation fails closed rather than using spot as an oracle fallback.
library PancakeOracle {
    error InvalidOracle();

    function consult(address pool, uint32 window)
        internal
        view
        returns (int24 twap, uint128 harmonicLiquidity)
    {
        if (window == 0) revert InvalidOracle();
        (,, uint16 index, uint16 cardinality,,,) = IPancakeOraclePool(pool).slot0();
        if (cardinality == 0) revert InvalidOracle();
        (uint32 timestamp,,, bool initialized) =
            IPancakeOraclePool(pool).observations((uint256(index) + 1) % cardinality);
        if (!initialized) (timestamp,,, initialized) = IPancakeOraclePool(pool).observations(0);
        uint32 age;
        unchecked {
            age = uint32(block.timestamp) - timestamp;
        }
        if (!initialized || age < window) revert InvalidOracle();
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        (int56[] memory ticks, uint160[] memory liquidityCumulatives) =
            IPancakeOraclePool(pool).observe(secondsAgos);
        if (ticks.length != 2 || liquidityCumulatives.length != 2) revert InvalidOracle();
        int56 tickDelta;
        uint160 liquidityDelta;
        unchecked {
            tickDelta = ticks[1] - ticks[0];
            liquidityDelta = liquidityCumulatives[1] - liquidityCumulatives[0];
        }
        int56 mean = tickDelta / int56(uint56(window));
        if (tickDelta < 0 && tickDelta % int56(uint56(window)) != 0) mean--;
        if (mean < PancakeMath.MIN_TICK || mean > PancakeMath.MAX_TICK || liquidityDelta == 0) {
            revert InvalidOracle();
        }
        twap = int24(mean);
        uint192 secondsAgoX160 = uint192(window) * type(uint160).max;
        uint192 harmonic = secondsAgoX160 / (uint192(liquidityDelta) << 32);
        if (harmonic == 0 || harmonic > type(uint128).max) revert InvalidOracle();
        harmonicLiquidity = uint128(harmonic);
    }

    function checkedState(address pool, uint32 window, uint24 maxDeviationTicks, uint128 minLiquidity)
        internal
        view
        returns (int24 spot, int24 twap, uint160 sqrtPriceX96)
    {
        bool unlocked;
        (sqrtPriceX96, spot,,,,, unlocked) = IPancakeOraclePool(pool).slot0();
        if (
            !unlocked || spot < PancakeMath.MIN_TICK || spot >= PancakeMath.MAX_TICK
                || sqrtPriceX96 >= PancakeMath.MAX_SQRT_RATIO
                || sqrtPriceX96 < PancakeMath.sqrtRatioAtTick(spot)
                || sqrtPriceX96 > PancakeMath.sqrtRatioAtTick(spot + 1) || minLiquidity == 0
                || IPancakeOraclePool(pool).liquidity() < minLiquidity
        ) revert InvalidOracle();
        uint128 harmonic;
        (twap, harmonic) = consult(pool, window);
        int256 deviation = int256(spot) - twap;
        if (deviation < 0) deviation = -deviation;
        if (uint256(deviation) > maxDeviationTicks || harmonic < minLiquidity) revert InvalidOracle();
    }
}
