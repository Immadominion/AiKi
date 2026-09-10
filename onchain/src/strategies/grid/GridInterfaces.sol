// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IGridPool {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

interface IGridFactory {
    function poolDeployer() external view returns (address);
    function getPool(address token0, address token1, uint24 fee) external view returns (address);
}

/// @dev The ORIGINAL Pancake V3 SwapRouter ABI, not SmartRouter or Universal Router.
interface IGridRouter {
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
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

interface IGridTokenMetadata {
    function decimals() external view returns (uint8);
}
