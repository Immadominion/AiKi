// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Hand-written subset of the Foundry cheatcode interface.
/// @dev This repository has zero external Solidity dependencies, including forge-std. Only the
///      cheatcodes these tests actually use are declared.
interface Vm {
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber) external returns (uint256);
    function warp(uint256 newTimestamp) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function store(address target, bytes32 slot, bytes32 value) external;
    function load(address target, bytes32 slot) external view returns (bytes32);
    function deal(address account, uint256 newBalance) external;
    function label(address account, string calldata newLabel) external;
    function expectRevert(bytes calldata revertData) external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert() external;
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
    function readFile(string calldata path) external view returns (string memory data);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function parseJsonString(string calldata json, string calldata key) external pure returns (string memory);
    function parseJsonStringArray(string calldata json, string calldata key)
        external
        pure
        returns (string[] memory);
    function parseJsonBool(string calldata json, string calldata key) external pure returns (bool);
    function parseUint(string calldata value) external pure returns (uint256);
    function parseAddress(string calldata value) external pure returns (address);
    function parseBytes32(string calldata value) external pure returns (bytes32);
    function toString(uint256 value) external pure returns (string memory);
    function assume(bool condition) external pure;
    function getCode(string calldata artifactPath) external view returns (bytes memory);
    function envUint(string calldata name) external view returns (uint256);
    function envAddress(string calldata name) external view returns (address);
    function chainId(uint256 newChainId) external;
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;

    // Assertion cheatcodes. These REVERT on failure, which is how a modern Foundry marks a
    // test failed -- a user-defined `failed()` is no longer read, and an assertion helper that
    // only records a flag silently passes. That mistake was made once while writing this
    // harness and caught by mutating an enforcer boundary and watching the suite stay green.
    function assertTrue(bool condition, string calldata error) external pure;
    function assertFalse(bool condition, string calldata error) external pure;
    function assertEq(uint256 left, uint256 right, string calldata error) external pure;
    function assertEq(address left, address right, string calldata error) external pure;
    function assertEq(bytes32 left, bytes32 right, string calldata error) external pure;
    function assertEq(bool left, bool right, string calldata error) external pure;
    function assertEq(string calldata left, string calldata right, string calldata error) external pure;
    function assertEq(bytes calldata left, bytes calldata right, string calldata error) external pure;
}
