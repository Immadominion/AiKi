// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IYieldToken {
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
}

interface IYieldVenus is IYieldToken {
    function balanceOf(address who) external view returns (uint256);
    function underlying() external view returns (address);
    function comptroller() external view returns (address);
    function exchangeRateCurrent() external returns (uint256);
    function getCash() external view returns (uint256);
    function mint(uint256 amount) external returns (uint256);
    function redeemUnderlying(uint256 amount) external returns (uint256);
}

interface IYieldComptroller {
    function protocolPaused() external view returns (bool);
    function actionPaused(address market, uint8 action) external view returns (bool);
    function supplyCaps(address market) external view returns (uint256);
    function markets(address market)
        external
        view
        returns (bool, uint256, bool, uint256, uint256, uint96, bool);
}

interface IYieldAToken is IYieldToken {
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
    function POOL() external view returns (address);
    function scaledBalanceOf(address user) external view returns (uint256);
}

interface IYieldAavePool {
    function ADDRESSES_PROVIDER() external view returns (address);
    function getReserveNormalizedIncome(address asset) external view returns (uint256);
    function getVirtualUnderlyingBalance(address asset) external view returns (uint128);
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface IYieldAaveProvider {
    function getPool() external view returns (address);
}

interface IYieldAaveData {
    function ADDRESSES_PROVIDER() external view returns (address);
    function getReserveTokensAddresses(address asset) external view returns (address, address, address);
    function getReserveConfigurationData(address asset)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, bool, bool, bool, bool, bool);
    function getPaused(address asset) external view returns (bool);
    function getReserveCaps(address asset) external view returns (uint256, uint256);
}
