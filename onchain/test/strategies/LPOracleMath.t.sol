// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "../base/Test.sol";
import {PancakeMath} from "../../src/strategies/pancake/PancakeMath.sol";
import {PancakeOracle} from "../../src/strategies/pancake/PancakeOracle.sol";
import {LPPoolMock} from "./LPTestMocks.sol";

contract LPMathOracleHarness {
    function sqrt(int24 t) external pure returns (uint160) {
        return PancakeMath.sqrtRatioAtTick(t);
    }

    function mul(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return PancakeMath.mulDiv(a, b, d);
    }

    function ceil(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return PancakeMath.mulDivRoundingUp(a, b, d);
    }

    function consult(address p, uint32 w) external view returns (int24, uint128) {
        return PancakeOracle.consult(p, w);
    }

    function check(address p, uint32 w, uint24 d, uint128 l) external view returns (int24, int24, uint160) {
        return PancakeOracle.checkedState(p, w, d, l);
    }
}

contract LPOracleMathTest is Test {
    LPMathOracleHarness private math;
    LPPoolMock private pool;
    uint160 private constant Q96 = 79228162514264337593543950336;

    function setUp() public {
        vm.warp(1_800_000_000);
        math = new LPMathOracleHarness();
        pool = new LPPoolMock(address(1), address(2));
    }

    function testCanonicalTickVectorsAndBounds() public {
        assertEq(math.sqrt(0), Q96, "zero tick");
        assertEq(math.sqrt(1), 79232123823359799118286999568, "positive tick canonical");
        assertEq(math.sqrt(-1), 79224201403219477170569942574, "negative tick canonical");
        assertEq(math.sqrt(-887272), 4295128739, "minimum");
        assertEq(math.sqrt(887272), 1461446703485210103287273052203988822378723970342, "maximum");
        vm.expectRevert();
        math.sqrt(-887273);
        vm.expectRevert();
        math.sqrt(887273);
    }

    function testFullMathPhantomOverflowAndCeiling() public {
        assertEq(
            math.mul(type(uint256).max, type(uint256).max, type(uint256).max),
            type(uint256).max,
            "512-bit product"
        );
        assertEq(math.mul(1 << 200, 1 << 100, 1 << 150), 1 << 150, "phantom overflow quotient");
        assertEq(math.mul(5, 7, 3), 11, "floor");
        assertEq(math.ceil(5, 7, 3), 12, "ceil");
        vm.expectRevert();
        math.mul(1, 1, 0);
        vm.expectRevert();
        math.mul(type(uint256).max, type(uint256).max, 1);
    }

    function testLiquidityExactRationalVectors() public pure {
        (uint256 a, uint256 b) = PancakeMath.amountsForLiquidity(Q96, Q96 / 2, Q96 * 2, 100);
        assertEq(a, 50, "balanced amount0");
        assertEq(b, 50, "balanced amount1");
        assertEq(PancakeMath.liquidityForAmounts(Q96, Q96 / 2, Q96 * 2, 50, 50), 100, "inverse");
        (a, b) = PancakeMath.amountsForLiquidity(Q96 / 2, Q96 / 2, Q96 * 2, 100);
        assertEq(a, 150, "below: only token0");
        assertEq(b, 0, "below no token1");
        (a, b) = PancakeMath.amountsForLiquidity(Q96 * 2, Q96 / 2, Q96 * 2, 100);
        assertEq(a, 0, "above no token0");
        assertEq(b, 150, "above: only token1");
        assertEq(PancakeMath.quoteAtTick(0, 123, address(1), address(2)), 123, "same raw-unit price");
        assertEq(PancakeMath.quoteAtTick(0, 123, address(2), address(1)), 123, "inverse raw-unit price");
    }

    function testFuzzFullMathMatchesBoundedIntegerArithmetic(uint128 a, uint128 b, uint128 denominator)
        public
        pure
    {
        if (denominator == 0) return;
        assertEq(PancakeMath.mulDiv(a, b, denominator), uint256(a) * b / denominator, "integer parity");
    }

    function testFuzzTickRatiosStrictlyIncrease(int24 tick) public pure {
        if (tick < -887272 || tick >= 887272) return;
        assertTrue(
            PancakeMath.sqrtRatioAtTick(tick) < PancakeMath.sqrtRatioAtTick(tick + 1), "strict monotonicity"
        );
    }

    function testFuzzLiquidityRoundTripNeverCreatesInventory(uint96 a, uint96 b, int24 t) public pure {
        if (t < -50000 || t > 50000) return;
        uint160 price = PancakeMath.sqrtRatioAtTick(t);
        uint160 lower = PancakeMath.sqrtRatioAtTick(t - 100);
        uint160 upper = PancakeMath.sqrtRatioAtTick(t + 100);
        uint128 l = PancakeMath.liquidityForAmounts(price, lower, upper, a, b);
        (uint256 used0, uint256 used1) = PancakeMath.amountsForLiquidity(price, lower, upper, l);
        assertTrue(used0 <= a && used1 <= b, "rounding cannot create tokens");
    }

    function testOracleNegativeMeanFloorsAndCounterWrapIsPreserved() public {
        pool.setMean(-1, -1);
        (int24 tick,) = math.consult(address(pool), 300);
        assertEq(uint256(int256(tick) + 887272), 887270, "-301/300 floors to -2");
        pool.setMean(1, 0);
        pool.setCumulativeStarts(type(int56).max - 10, type(uint160).max - 10);
        (tick,) = math.consult(address(pool), 300);
        assertEq(uint256(int256(tick)), 1, "wrapped canonical counters");
    }

    function testOracleRejectsAbsentRetainedHistoryAndMalformedReads() public {
        pool.setOracle(299, true, false, false);
        vm.expectRevert(PancakeOracle.InvalidOracle.selector);
        math.consult(address(pool), 300);
        pool.setOracle(3600, false, false, false);
        vm.expectRevert(PancakeOracle.InvalidOracle.selector);
        math.consult(address(pool), 300);
        pool.setOracle(3600, true, false, true);
        vm.expectRevert(PancakeOracle.InvalidOracle.selector);
        math.consult(address(pool), 300);
        pool.setOracle(3600, true, true, false);
        vm.expectRevert();
        math.consult(address(pool), 300);
    }

    function testOracleRejectsDeviationEmptyPoolAndInconsistentPrice() public {
        pool.setTick(101);
        vm.expectRevert(PancakeOracle.InvalidOracle.selector);
        math.check(address(pool), 300, 100, 1e18);
        pool.setTick(0);
        pool.setLiquidity(0);
        vm.expectRevert(PancakeOracle.InvalidOracle.selector);
        math.check(address(pool), 300, 100, 1e18);
        pool.setLiquidity(1e24);
        pool.setSqrt(Q96 * 2);
        vm.expectRevert(PancakeOracle.InvalidOracle.selector);
        math.check(address(pool), 300, 100, 1e18);
    }

    function testOracleRejectsUnreachableMaximumSqrtPrice() public {
        pool.setTick(887271);
        pool.setMean(887271, 0);
        pool.setSqrt(PancakeMath.MAX_SQRT_RATIO);
        vm.expectRevert(PancakeOracle.InvalidOracle.selector);
        math.check(address(pool), 300, 100, 1e18);
    }
}
