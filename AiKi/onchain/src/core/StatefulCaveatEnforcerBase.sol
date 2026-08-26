// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CaveatEnforcerBase} from "./CaveatEnforcerBase.sol";

/// @notice Base for enforcers that keep state (spend counters, balance snapshots).
/// @dev Two independent protections, because either one alone has a live failure mode:
///        1. `onlyManager` with an immutable manager address. Every hook is a public function;
///           without this, anyone can call `beforeHook` with a victim's delegationHash and
///           exhaust the cap, bricking a live mandate.
///        2. All state is additionally keyed by `msg.sender`. Even a second, hostile manager
///           cannot reach into this manager's counters.
abstract contract StatefulCaveatEnforcerBase is CaveatEnforcerBase {
    error NotDelegationManager();

    address public immutable DELEGATION_MANAGER;

    constructor(address delegationManager_) {
        if (delegationManager_ == address(0)) revert NotDelegationManager();
        DELEGATION_MANAGER = delegationManager_;
    }

    modifier onlyManager() {
        if (msg.sender != DELEGATION_MANAGER) revert NotDelegationManager();
        _;
    }
}
