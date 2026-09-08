// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CaveatEnforcerBase} from "../core/CaveatEnforcerBase.sol";
import {Constants} from "../core/Types.sol";
import {ExecutionLib} from "../core/ExecutionLib.sol";
import {PolicyDenied, Rules, Reasons} from "../core/Errors.sol";

/// @notice `selector_allowlist`. terms = packed 4-byte selectors, no padding.
/// @dev Empty terms deny everything, for the same reason as AllowedTargetsEnforcer.
///
///      A call carrying no calldata has no selector and is DENIED. Off chain the selector is
///      an arbitrary string, so `'0x'`, `'0x1'` and `'0x00000001'` are three distinct values
///      that all compare as strings; on chain there is bytes4 or nothing. The compiler must
///      reject any selector entry that is not exactly 8 lowercase hex digits, or the two sides
///      are not comparing the same thing.
contract AllowedSelectorsEnforcer is CaveatEnforcerBase {
    error InvalidTerms();

    function beforeHook(
        bytes calldata terms,
        bytes calldata args,
        bytes32 mode,
        bytes calldata executionCallData,
        bytes32,
        address,
        address
    ) external pure override noArgs(args) singleCallMode(mode) {
        if (terms.length % 4 != 0) revert InvalidTerms();
        uint256 count = terms.length / 4;
        if (count > Constants.MAX_ALLOWLIST) revert InvalidTerms();

        (,, bytes calldata callData) = ExecutionLib.decode(executionCallData);
        (bytes4 selector, bool present) = ExecutionLib.selectorOf(callData);
        if (!present) revert PolicyDenied(Rules.SELECTOR_ALLOWLIST, Reasons.NO_SELECTOR);

        for (uint256 i; i < count; ++i) {
            if (bytes4(terms[i * 4:(i * 4) + 4]) == selector) return;
        }
        revert PolicyDenied(Rules.SELECTOR_ALLOWLIST, Reasons.SELECTOR_NOT_ALLOWED);
    }

    function name() external pure override returns (string memory) {
        return "AllowedSelectorsEnforcer";
    }

    function constraintKind() external pure override returns (string memory) {
        return "selector_allowlist";
    }
}
