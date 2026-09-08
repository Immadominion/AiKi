// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CaveatEnforcerBase} from "../core/CaveatEnforcerBase.sol";
import {PolicyDenied, Rules, Reasons} from "../core/Errors.sol";

/// @notice `expiry`. terms = abi.encode(uint256 expiresAtUnixSeconds).
/// @dev Boundary copied from policy.ts line 54: the off-chain check denies on
///      `Date.parse(action.at) >= Date.parse(policy.expiresAt)`, so equality DENIES, and the
///      on-chain condition is therefore `block.timestamp < expiresAt` -- strictly less-than,
///      not `<=`.
///
///      Resolution: `Date.parse` yields milliseconds, `block.timestamp` yields seconds. The
///      compiler must emit whole-second expiries; a sub-second expiry has no exact on-chain
///      representation and must be rejected rather than rounded. See README.
contract ExpiryEnforcer is CaveatEnforcerBase {
    error InvalidTerms();

    function beforeHook(
        bytes calldata terms,
        bytes calldata args,
        bytes32 mode,
        bytes calldata,
        bytes32,
        address,
        address
    ) external view override noArgs(args) singleCallMode(mode) {
        if (terms.length != 32) revert InvalidTerms();
        uint256 expiresAt = abi.decode(terms, (uint256));
        // Comparing against block.timestamp IS the constraint. BNB Chain validators have some
        // discretion over the timestamp and blocks are ~0.75s, so the two evaluators agree
        // except within a few seconds of the deadline. That window is irreducible and is
        // documented in README.md rather than papered over.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= expiresAt) revert PolicyDenied(Rules.EXPIRY, Reasons.EXPIRED);
    }

    function name() external pure override returns (string memory) {
        return "ExpiryEnforcer";
    }

    function constraintKind() external pure override returns (string memory) {
        return "expiry";
    }
}
