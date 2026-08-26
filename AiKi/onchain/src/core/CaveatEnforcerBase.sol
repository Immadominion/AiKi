// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICaveatEnforcer} from "../interfaces/ICaveatEnforcer.sol";
import {Constants} from "./Types.sol";

/// @notice Base for stateless enforcers.
/// @dev Stateless hooks are safe to call from anywhere: they read only their arguments and
///      write nothing, so an unauthenticated call cannot poison anything. Stateful enforcers
///      extend StatefulCaveatEnforcerBase instead, which pins the manager.
abstract contract CaveatEnforcerBase is ICaveatEnforcer {
    error ArgsNotEmpty();
    error UnsupportedMode();

    /// @dev `args` are chosen by the redeemer, not the delegator, and are outside the EIP-712
    ///      preimage. Any enforcer that reads them for a security decision is trusting the
    ///      attacker to describe their own limits. v1 requires them empty here as well as in
    ///      the manager, so a future manager without that check cannot re-open the hole.
    modifier noArgs(bytes calldata args) {
        if (args.length != 0) revert ArgsNotEmpty();
        _;
    }

    /// @dev Each enforcer re-asserts the execution mode rather than trusting the manager to
    ///      have filtered it. A DELEGATECALL executed by the account runs attacker code in the
    ///      account's own storage context and makes every caveat decorative.
    modifier singleCallMode(bytes32 mode) {
        if (mode != Constants.MODE_SINGLE_DEFAULT) revert UnsupportedMode();
        _;
    }

    function beforeHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address)
        external
        virtual {}

    function afterHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address)
        external
        virtual {}

    /// @notice Human-readable name; this is what `EnforcementInfo.enforcedBy` resolves to
    ///         through AiKiEnforcerRegistry.
    function name() external pure virtual returns (string memory);

    /// @notice The `Constraint.kind` this enforcer implements.
    function constraintKind() external pure virtual returns (string memory);
}
