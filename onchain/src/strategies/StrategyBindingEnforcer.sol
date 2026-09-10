// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CaveatEnforcerBase} from "../core/CaveatEnforcerBase.sol";
import {ExecutionLib} from "../core/ExecutionLib.sol";

interface IBoundStrategyVault {
    function controller() external view returns (address);
    function policyHash() external view returns (bytes32);
    function strategyKind() external view returns (bytes32);
    function operationSelector() external view returns (bytes4);
}

/// @notice Signed binding to one reviewed immutable strategy and its economic policy.
/// @dev Terms are abi.encode(vault, policyHash, runtimeCodeHash, selector, kind).
///      Economic bounds live in the immutable vault policy, not a fabricated scalar
///      ERC-20 spending amount. This hook does not authorize owner escape functions.
contract StrategyBindingEnforcer is CaveatEnforcerBase {
    error InvalidStrategyTerms();
    error StrategyBindingMismatch();

    function beforeHook(
        bytes calldata terms,
        bytes calldata args,
        bytes32 mode,
        bytes calldata executionCallData,
        bytes32,
        address delegator,
        address
    ) external view override noArgs(args) singleCallMode(mode) {
        if (terms.length != 160) revert InvalidStrategyTerms();
        (address vault, bytes32 policy, bytes32 runtimeHash, bytes4 selector, bytes32 kind) =
            abi.decode(terms, (address, bytes32, bytes32, bytes4, bytes32));
        if (
            vault == address(0) || policy == bytes32(0) || runtimeHash == bytes32(0) || selector == bytes4(0)
                || kind == bytes32(0)
        ) revert InvalidStrategyTerms();
        (address target, uint256 value, bytes calldata data) = ExecutionLib.decode(executionCallData);
        (bytes4 actual, bool present) = ExecutionLib.selectorOf(data);
        if (
            target != vault || value != 0 || !present || actual != selector || vault.code.length == 0
                || vault.codehash != runtimeHash
        ) revert StrategyBindingMismatch();
        IBoundStrategyVault bound = IBoundStrategyVault(vault);
        if (
            bound.controller() != delegator || bound.policyHash() != policy || bound.strategyKind() != kind
                || bound.operationSelector() != selector
        ) revert StrategyBindingMismatch();
    }

    function name() external pure override returns (string memory) {
        return "StrategyBindingEnforcer";
    }

    function constraintKind() external pure override returns (string memory) {
        return "strategy_binding";
    }
}
