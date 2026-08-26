// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-7710-shaped caveat enforcer. Hand-written; this repository has no external
///         Solidity dependencies.
/// @dev Hooks DENY BY REVERTING. There is deliberately no boolean return: a bool the manager
///      forgets to check is a silent bypass, and a silent bypass is exactly the failure this
///      contract suite exists to prevent.
interface ICaveatEnforcer {
    function beforeHook(
        bytes calldata terms,
        bytes calldata args,
        bytes32 mode,
        bytes calldata executionCallData,
        bytes32 delegationHash,
        address delegator,
        address redeemer
    ) external;

    function afterHook(
        bytes calldata terms,
        bytes calldata args,
        bytes32 mode,
        bytes calldata executionCallData,
        bytes32 delegationHash,
        address delegator,
        address redeemer
    ) external;
}
