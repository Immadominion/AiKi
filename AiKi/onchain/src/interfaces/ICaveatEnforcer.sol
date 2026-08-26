// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-7710-shaped caveat enforcer. Hand-written; this repository has no external
///         Solidity dependencies.
/// @dev Hooks DENY BY REVERTING. There is deliberately no boolean return: a bool the manager
///      forgets to check is a silent bypass, and a silent bypass is exactly the failure this
///      contract suite exists to prevent.
interface ICaveatEnforcer {
    /// @dev The deployed MetaMask DelegationManager on BSC calls all four hooks, not two.
    ///      `beforeAllHook` and `afterAllHook` bracket the whole redemption batch, while
    ///      `beforeHook` and `afterHook` bracket each individual execution. An enforcer that
    ///      omits the "All" pair does not merely skip them: the manager's call lands on a
    ///      missing function and the redemption reverts, so the enforcer is unusable with the
    ///      real manager. This suite's enforcement lives entirely in the per-execution pair, so
    ///      the batch pair is implemented as a no-op rather than left absent.
    function beforeAllHook(
        bytes calldata terms,
        bytes calldata args,
        bytes32 mode,
        bytes calldata executionCallData,
        bytes32 delegationHash,
        address delegator,
        address redeemer
    ) external;

    function afterAllHook(
        bytes calldata terms,
        bytes calldata args,
        bytes32 mode,
        bytes calldata executionCallData,
        bytes32 delegationHash,
        address delegator,
        address redeemer
    ) external;

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
