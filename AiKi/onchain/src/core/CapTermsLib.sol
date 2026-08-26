// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AmountSite, Constants} from "./Types.sol";
import {AmountLib} from "./AmountLib.sol";
import {ExecutionLib} from "./ExecutionLib.sol";
import {PolicyDenied, Reasons} from "./Errors.sol";

/// @notice The shared decode for both cap enforcers.
/// @dev Both PerActionCapEnforcer and SessionTotalCapEnforcer call THIS, so they cannot
///      derive different amounts from the same execution. Two independent derivations diverge
///      from each other before either diverges from the API.
library CapTermsLib {
    error InvalidTerms();

    /// @param rule The caller's `Constraint.kind`, so a denial carries the right rule token.
    function declaredAmount(bytes calldata terms, bytes calldata executionCallData, string memory rule)
        internal
        pure
        returns (address asset, uint256 cap, uint256 declared)
    {
        AmountSite[] memory sites;
        (asset, cap, sites) = abi.decode(terms, (address, uint256, AmountSite[]));
        if (asset == address(0) || sites.length == 0 || sites.length > Constants.MAX_ALLOWLIST) {
            revert InvalidTerms();
        }

        (address target,, bytes calldata callData) = ExecutionLib.decode(executionCallData);
        address resolved;
        bool ok;
        (resolved, declared, ok) = AmountLib.resolve(sites, target, callData);

        // Fail closed. "Unknown selector, so amount is zero" is a total bypass of every cap.
        if (!ok) revert PolicyDenied(rule, Reasons.AMOUNT_NOT_DECODABLE);
        // A cap is denominated in exactly one asset. A call that moves a different token is
        // one this cap cannot price, and is denied rather than waved through.
        if (resolved != asset) revert PolicyDenied(rule, Reasons.CAP_ASSET_MISMATCH);
    }

    function capOf(bytes calldata terms) internal pure returns (uint256 cap) {
        (, cap,) = abi.decode(terms, (address, uint256, AmountSite[]));
    }
}
