// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A single caveat: one on-chain enforcer plus the parameters the delegator signed.
/// @dev `terms` is inside the EIP-712 preimage and is therefore signed by the delegator.
///      `args` is supplied by the redeemer at redemption time and is NOT signed. No AiKi
///      enforcer reads `args`; the manager requires `args.length == 0` for every caveat so
///      the entire "enforcer trusts attacker-supplied args" class is closed by construction.
struct Caveat {
    address enforcer;
    bytes terms;
    bytes args;
}

/// @notice An ERC-7710-shaped delegation.
/// @dev Deliberate deviations from the MetaMask delegation-framework struct, both documented
///      in README.md:
///        - `epoch` is added, so `bumpEpoch()` can kill every outstanding mandate of a
///          delegator in one transaction. Carrying it in the signed struct means the manager
///          checks it unconditionally; a caveat-based epoch can be omitted by a buggy compiler.
///        - `authority` is required to equal ROOT_AUTHORITY. Redelegation has no counterpart
///          in the off-chain evaluator, so permitting it would be an automatic divergence.
struct Delegation {
    address delegate;
    address delegator;
    bytes32 authority;
    Caveat[] caveats;
    uint256 salt;
    uint256 epoch;
    bytes signature;
}

/// @notice A signed statement of the form: "calling `selector` on `target` moves `asset`, and
///         the quantity is the 32-byte word at index `argIndex` after the selector."
/// @dev This is the bridge from raw calldata to the `(asset, amount)` pair that the off-chain
///      `Action` type simply asserts. It is inside `terms`, so it is signed. There is no
///      inference and no default: an execution that matches no site is DENIED, never treated
///      as amount zero.
struct AmountSite {
    address target;
    bytes4 selector;
    address asset;
    uint8 argIndex;
}

library Constants {
    /// @dev The only `authority` accepted in v1.
    bytes32 internal constant ROOT_AUTHORITY = bytes32(type(uint256).max);

    /// @dev ERC-7579 mode: CallType 0x00 (single) + ExecType 0x00 (revert on failure).
    ///      Batch multiplies a per-action cap; DELEGATECALL voids every caveat; TRY lets a
    ///      failed inner call leave the transaction successful. All three are rejected.
    bytes32 internal constant MODE_SINGLE_DEFAULT = bytes32(0);

    /// @dev Bound on caveats per delegation, and on entries per allowlist. A user should never
    ///      be asked to sign a mandate whose evaluation cost is unbounded.
    uint256 internal constant MAX_CAVEATS = 16;
    uint256 internal constant MAX_ALLOWLIST = 32;
}
