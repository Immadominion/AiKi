// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CaveatEnforcerBase} from "../core/CaveatEnforcerBase.sol";
import {AmountSite, Constants} from "../core/Types.sol";
import {AmountLib} from "../core/AmountLib.sol";
import {ExecutionLib} from "../core/ExecutionLib.sol";
import {PolicyDenied, Rules, Reasons} from "../core/Errors.sol";

/// @notice `asset_scope`. terms = abi.encode(address[] scopedAssets, AmountSite[] sites).
/// @dev The asset a call moves is NOT readable from the call. For `USDT.transfer` the target
///      and the asset coincide; for `VenusComptroller.repayBorrow` the target is Venus and the
///      moved token is pulled through an allowance and appears nowhere in the calldata. So the
///      asset is declared in the signed site table and resolved from `(target, selector)`.
///
///      A call that matches no site is DENIED. Empty scope denies everything, matching
///      `[].includes(x) === false`.
///
///      KNOWN DIVERGENCE, stated plainly: off chain `Action.asset` is a SYMBOL ('USDT', 'BNB',
///      and the existing unit test literally uses 'u'), compared as a lowercased string. On
///      chain it is a 20-byte address. Symbol-to-address is an off-chain trusted table and is
///      exactly the ambiguity a fake-token scam exploits. An asset_scope constraint expressed
///      with symbols is T1 at best no matter which enforcer is attached; the compiler must
///      normalise to addresses at compile time or the T0 label on that line is false.
contract AssetScopeEnforcer is CaveatEnforcerBase {
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
        (address[] memory scope, AmountSite[] memory sites) = abi.decode(terms, (address[], AmountSite[]));
        if (scope.length > Constants.MAX_ALLOWLIST || sites.length > Constants.MAX_ALLOWLIST) {
            revert InvalidTerms();
        }

        (address target,, bytes calldata callData) = ExecutionLib.decode(executionCallData);
        (address asset,, bool ok) = AmountLib.resolve(sites, target, callData);
        if (!ok) revert PolicyDenied(Rules.ASSET_SCOPE, Reasons.ASSET_NOT_DECLARED);

        for (uint256 i; i < scope.length; ++i) {
            // address(0) is rejected as a scope entry: it is also the uninitialised default,
            // so any bug leaving an asset field zero would silently read as "in scope".
            if (scope[i] == address(0)) revert InvalidTerms();
            if (scope[i] == asset) return;
        }
        revert PolicyDenied(Rules.ASSET_SCOPE, Reasons.ASSET_OUT_OF_SCOPE);
    }

    function name() external pure override returns (string memory) {
        return "AssetScopeEnforcer";
    }

    function constraintKind() external pure override returns (string memory) {
        return "asset_scope";
    }
}
