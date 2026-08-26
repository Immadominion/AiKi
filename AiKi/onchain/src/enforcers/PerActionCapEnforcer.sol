// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StatefulCaveatEnforcerBase} from "../core/StatefulCaveatEnforcerBase.sol";
import {CapTermsLib} from "../core/CapTermsLib.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {PolicyDenied, Rules, Reasons} from "../core/Errors.sol";

/// @notice `per_action_cap`. terms = abi.encode(address asset, uint256 cap, AmountSite[] sites).
/// @dev Boundary copied from policy.ts line 64: denial is `action.amount > cap`, so
///      `amount == cap` is ALLOWED. `require(amount < cap)` is off by one and breaks the
///      legitimate "spend exactly your cap" action.
///
///      Two independent measurements, and the STRICTER wins:
///        1. DECLARED. The amount at the calldata word the signed site names. This is what
///           `evaluatePolicy` means by "the amount named in the action", so it is the parity
///           surface. Checked in beforeHook, before anything moves.
///        2. REALISED. `balanceOf(delegator)` delta across the execution, floored at zero.
///           Decode-free, so it survives proxies, multicall wrappers and an ABI nobody
///           anticipated. Checked in afterHook.
///      The charge is `max(declared, realised)`. Delta alone is the LENIENT direction -- a call
///      that pulls 100 and refunds 40 has a delta of 60 while the off-chain Action asserted
///      100, and an inbound donation mid-transaction masks the outflow entirely -- so it is a
///      backstop, never the sole check.
///
///      An `approve` is a spend no delta can see: it moves zero tokens now and unlimited
///      tokens later, outside any delegation. Because the amount comes from the signed site,
///      an approval is charged at its FULL GRANTED VALUE at grant time, which is the correct
///      bound. The compiler should still exclude approve-family selectors where it can.
contract PerActionCapEnforcer is StatefulCaveatEnforcerBase {
    error NoSnapshot();
    error SnapshotAlreadyHeld();

    struct Snapshot {
        address asset;
        uint256 balanceBefore;
        uint256 declared;
        bool active;
    }

    /// @dev Keyed by (manager, delegationHash). The manager key is redundant while
    ///      `onlyManager` holds, and deliberately kept so a second manager can never reach
    ///      into this one's state. The `active` flag doubles as a per-enforcer reentrancy lock
    ///      that survives a future manager without a guard.
    mapping(address => mapping(bytes32 => Snapshot)) private _snapshots;

    constructor(address delegationManager_) StatefulCaveatEnforcerBase(delegationManager_) {}

    function beforeHook(
        bytes calldata terms,
        bytes calldata args,
        bytes32 mode,
        bytes calldata executionCallData,
        bytes32 delegationHash,
        address delegator,
        address
    ) external override onlyManager noArgs(args) singleCallMode(mode) {
        (address asset, uint256 cap, uint256 declared) =
            CapTermsLib.declaredAmount(terms, executionCallData, Rules.PER_ACTION_CAP);

        if (declared > cap) revert PolicyDenied(Rules.PER_ACTION_CAP, Reasons.OVER_PER_ACTION_CAP);

        Snapshot storage snap = _snapshots[msg.sender][delegationHash];
        if (snap.active) revert SnapshotAlreadyHeld();
        snap.asset = asset;
        snap.balanceBefore = IERC20(asset).balanceOf(delegator);
        snap.declared = declared;
        snap.active = true;
    }

    function afterHook(
        bytes calldata terms,
        bytes calldata args,
        bytes32 mode,
        bytes calldata,
        bytes32 delegationHash,
        address delegator,
        address
    ) external override onlyManager noArgs(args) singleCallMode(mode) {
        Snapshot memory snap = _snapshots[msg.sender][delegationHash];
        if (!snap.active) revert NoSnapshot();
        delete _snapshots[msg.sender][delegationHash];

        uint256 cap = CapTermsLib.capOf(terms);

        uint256 balanceAfter = IERC20(snap.asset).balanceOf(delegator);
        uint256 realised = snap.balanceBefore > balanceAfter ? snap.balanceBefore - balanceAfter : 0;
        uint256 charged = realised > snap.declared ? realised : snap.declared;

        if (charged > cap) revert PolicyDenied(Rules.PER_ACTION_CAP, Reasons.OVER_PER_ACTION_CAP);
    }

    function name() external pure override returns (string memory) {
        return "PerActionCapEnforcer";
    }

    function constraintKind() external pure override returns (string memory) {
        return "per_action_cap";
    }
}
