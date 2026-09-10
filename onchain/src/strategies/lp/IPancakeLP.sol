// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

// ABI shapes from Pancake V3 periphery, commit 986847948755cba528324d41be19480731c36c2a.
// Only the fixed operations this strategy uses are exposed.
interface ILPPositionManager {
    struct Position {
        uint96 nonce;
        address operator;
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }
    function factory() external view returns (address);
    function deployer() external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function positions(uint256 tokenId) external view returns (Position memory);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256, uint256);
    function collect(CollectParams calldata params) external payable returns (uint256, uint256);
    function mint(MintParams calldata params) external payable returns (uint256, uint128, uint256, uint256);
    function burn(uint256 tokenId) external payable;
}

interface ILPRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function factory() external view returns (address);
    function deployer() external view returns (address);
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

interface ILPPool {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
}

interface ILPFactory {
    function getPool(address token0, address token1, uint24 fee) external view returns (address);
    function poolDeployer() external view returns (address);
}
