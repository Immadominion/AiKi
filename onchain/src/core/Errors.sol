// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The single denial error for every policy constraint.
/// @dev `rule` and `reason` are the exact strings returned by
///      apps/api/src/authority/policy.ts `evaluatePolicy`, so a denial decodes into the same
///      `{rule, reason}` pair the API already emits as a `policy` job event. See Rules/Reasons.
error PolicyDenied(string rule, string reason);

/// @dev The `rule` vocabulary. These strings are `Constraint.kind` verbatim.
library Rules {
    string internal constant EXPIRY = "expiry";
    string internal constant CONTRACT_ALLOWLIST = "contract_allowlist";
    string internal constant SELECTOR_ALLOWLIST = "selector_allowlist";
    string internal constant ASSET_SCOPE = "asset_scope";
    string internal constant PER_ACTION_CAP = "per_action_cap";
    string internal constant SESSION_TOTAL_CAP = "session_total_cap";
    /// @dev Returned on the allow path, matching evaluatePolicy's terminal return.
    string internal constant POLICY = "policy";
    /// @dev No off-chain twin. Structural facts the `Action` type cannot express.
    string internal constant STRUCTURE = "structure";
}

/// @dev The `reason` vocabulary. The first six are byte-identical to policy.ts.
library Reasons {
    string internal constant EXPIRED = "Authorization has expired.";
    string internal constant TARGET_NOT_ALLOWED = "Target is not allowlisted.";
    string internal constant SELECTOR_NOT_ALLOWED = "Function selector is not allowlisted.";
    string internal constant ASSET_OUT_OF_SCOPE = "Asset is outside mandate scope.";
    string internal constant OVER_PER_ACTION_CAP = "Action exceeds per-action cap.";
    string internal constant OVER_SESSION_CAP = "Action exceeds lifetime session cap.";
    string internal constant ALLOWED = "Action conforms to compiled constraints.";

    /// @dev Reasons with no off-chain twin. Every one of these is a fail-closed denial for a
    ///      case the off-chain `Action` tuple cannot describe. The chain is stricter here.
    string internal constant AMOUNT_NOT_DECODABLE = "Amount is not decodable for this call.";
    string internal constant ASSET_NOT_DECLARED = "Asset is not declared for this call.";
    string internal constant NO_SELECTOR = "Call carries no function selector.";
    string internal constant CAP_ASSET_MISMATCH = "Call moves an asset this cap does not price.";
    string internal constant IMPLEMENTATION_CHANGED = "Target proxy implementation is not the pinned one.";
}
