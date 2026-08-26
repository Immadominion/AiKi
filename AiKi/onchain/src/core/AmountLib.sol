// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AmountSite} from "./Types.sol";
import {ExecutionLib} from "./ExecutionLib.sol";

/// @notice The single derivation of `(asset, amount)` from a raw execution.
/// @dev Off chain, `Action.amount` and `Action.asset` are fields somebody asserts. On chain
///      there is only `(target, value, callData)`. Every cap and scope enforcer in this suite
///      calls THIS function, so they cannot diverge from each other before they diverge from
///      the API.
///
///      The derivation is declared in the signed `terms`, never inferred:
///        - the argument index varies by selector (transfer -> word 1, transferFrom -> word 2,
///          approve -> word 1, Venus repayBorrow -> word 0). A single global "word 1" rule
///          reads address high-bits or a deadline for every other shape, yielding a small
///          number that passes the cap.
///        - the asset frequently does not appear in the calldata at all. Venus `repayBorrow`
///          moves USDT through an internal `transferFrom`; nothing in the top-level call names
///          the token.
///
///      An execution that matches no site is DENIED. "Skip the cap on an unknown selector" and
///      "assume amount zero" are both total bypasses.
library AmountLib {
    /// @notice Resolve the asset and amount this execution moves, per the signed site table.
    /// @return asset The token the site declares this call moves.
    /// @return amount The declared quantity, read from the pinned calldata word.
    /// @return ok False when no site matches, or when the word the site names is not present.
    function resolve(AmountSite[] memory sites, address target, bytes calldata callData)
        internal
        pure
        returns (address asset, uint256 amount, bool ok)
    {
        (bytes4 selector, bool hasSelector) = ExecutionLib.selectorOf(callData);
        if (!hasSelector) return (address(0), 0, false);

        for (uint256 i; i < sites.length; ++i) {
            AmountSite memory site = sites[i];
            if (site.target != target || site.selector != selector) continue;
            (uint256 word, bool present) = ExecutionLib.wordAt(callData, site.argIndex);
            if (!present) return (address(0), 0, false);
            return (site.asset, word, true);
        }
        return (address(0), 0, false);
    }
}
