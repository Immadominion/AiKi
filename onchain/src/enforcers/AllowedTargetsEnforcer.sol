// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CaveatEnforcerBase} from "../core/CaveatEnforcerBase.sol";
import {Constants} from "../core/Types.sol";
import {ExecutionLib} from "../core/ExecutionLib.sol";
import {PolicyDenied, Rules, Reasons} from "../core/Errors.sol";

/// @notice `contract_allowlist`. terms = packed 20-byte addresses, no padding.
/// @dev EMPTY TERMS DENY EVERYTHING. policy.ts line 57 sets `values = []` whenever `c.value`
///      is not an array, and `[].includes(x)` is always false -- so an empty or malformed
///      allowlist denies every action off chain. The reflexive Solidity shortcut
///      `if (terms.length == 0) return; // no restriction` inverts deny-all into allow-all.
///      That is the single most dangerous line that could be written in this file.
///
///      Note also that this checks the OUTER call target only, exactly as the off-chain
///      evaluator does. Allowlisting a router, a Multicall3, a Permit2 or any forwarding proxy
///      makes the allowlist decorative. That is not a divergence between the two evaluators;
///      it is a divergence between both of them and the sentence the UI prints.
contract AllowedTargetsEnforcer is CaveatEnforcerBase {
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
        if (terms.length % 20 != 0) revert InvalidTerms();
        uint256 count = terms.length / 20;
        if (count > Constants.MAX_ALLOWLIST) revert InvalidTerms();

        (address target,,) = ExecutionLib.decode(executionCallData);

        for (uint256 i; i < count; ++i) {
            if (address(bytes20(terms[i * 20:(i * 20) + 20])) == target) return;
        }
        revert PolicyDenied(Rules.CONTRACT_ALLOWLIST, Reasons.TARGET_NOT_ALLOWED);
    }

    function name() external pure override returns (string memory) {
        return "AllowedTargetsEnforcer";
    }

    function constraintKind() external pure override returns (string memory) {
        return "contract_allowlist";
    }
}
