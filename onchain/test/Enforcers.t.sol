// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./base/Fixture.sol";
import {AmountSite, Caveat, Delegation} from "../src/core/Types.sol";
import {PolicyDenied, Rules, Reasons} from "../src/core/Errors.sol";
import {CapTermsLib} from "../src/core/CapTermsLib.sol";
import {AllowedTargetsEnforcer} from "../src/enforcers/AllowedTargetsEnforcer.sol";
import {AllowedSelectorsEnforcer} from "../src/enforcers/AllowedSelectorsEnforcer.sol";
import {AssetScopeEnforcer} from "../src/enforcers/AssetScopeEnforcer.sol";
import {ExpiryEnforcer} from "../src/enforcers/ExpiryEnforcer.sol";
import {StatefulCaveatEnforcerBase} from "../src/core/StatefulCaveatEnforcerBase.sol";
import {CaveatEnforcerBase} from "../src/core/CaveatEnforcerBase.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockProtocol} from "./mocks/MockTargets.sol";

/// @notice Allow case and deny case for every enforcer, plus the terms-validation and
///         fail-closed paths that have no off-chain twin.
contract EnforcersTest is Fixture {
    uint256 internal constant NOW = 1_800_000_000;
    uint256 internal constant SOON = 1_800_003_600;

    function setUp() public {
        deploySuite();
        vm.warp(NOW);
    }

    function _dry(Delegation memory d, bytes memory exec)
        internal
        returns (bool allow, string memory rule, string memory reason)
    {
        vm.prank(agent);
        return manager.dryRun(d, bytes32(0), exec);
    }

    function _assertDenied(
        Delegation memory d,
        bytes memory exec,
        string memory rule,
        string memory reason,
        string memory what
    ) internal {
        (bool allow, string memory r, string memory why) = _dry(d, exec);
        assertFalse(allow, what);
        assertEq(r, rule, string.concat(what, ": wrong rule"));
        assertEq(why, reason, string.concat(what, ": wrong reason"));
    }

    function _assertAllowed(Delegation memory d, bytes memory exec, string memory what) internal {
        (bool allow, string memory r, string memory why) = _dry(d, exec);
        assertTrue(allow, what);
        assertEq(r, Rules.POLICY, string.concat(what, ": allow must report rule 'policy'"));
        assertEq(why, Reasons.ALLOWED, string.concat(what, ": allow must report the conformance reason"));
    }

    // ------------------------------------------------------------------ expiry

    function test_Expiry_AllowsBeforeDeadline() public {
        _assertAllowed(standardMandate(1000 ether, 1000 ether, NOW + 1), transferExec(1), "one second left");
    }

    function test_Expiry_DeniesExactlyAtDeadline() public {
        // policy.ts denies on `at >= expiresAt`. Equality DENIES. This is the boundary a
        // `<=` in the enforcer would get wrong in the permissive direction.
        _assertDenied(
            standardMandate(1000 ether, 1000 ether, NOW),
            transferExec(1),
            Rules.EXPIRY,
            Reasons.EXPIRED,
            "at == expiresAt must deny"
        );
    }

    function test_Expiry_DeniesAfterDeadline() public {
        _assertDenied(
            standardMandate(1000 ether, 1000 ether, NOW - 1),
            transferExec(1),
            Rules.EXPIRY,
            Reasons.EXPIRED,
            "past deadline must deny"
        );
    }

    function test_Expiry_RejectsMalformedTerms() public {
        Caveat[] memory caveats = new Caveat[](1);
        caveats[0] = Caveat({enforcer: address(expiryE), terms: hex"1234", args: ""});
        Delegation memory d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);

        (bool allow, string memory rule,) = _dry(d, transferExec(1));
        assertFalse(allow, "malformed expiry terms must not allow");
        assertEq(rule, Rules.STRUCTURE, "malformed terms are a structural failure, not a policy one");
    }

    // ------------------------------------------------------------------ contract_allowlist

    function test_Targets_AllowsListedTarget() public {
        _assertAllowed(standardMandate(1000 ether, 1000 ether, SOON), transferExec(1), "token is allowlisted");
    }

    function test_Targets_DeniesUnlistedTarget() public {
        MockERC20 other = new MockERC20();
        Delegation memory d = standardMandate(1000 ether, 1000 ether, SOON);
        bytes memory exec =
            execOf(address(other), 0, abi.encodeWithSelector(TRANSFER_SELECTOR, recipient, uint256(1)));
        _assertDenied(d, exec, Rules.CONTRACT_ALLOWLIST, Reasons.TARGET_NOT_ALLOWED, "unlisted target");
    }

    /// @dev THE inversion. policy.ts line 57 gives `values = []` for a non-array or empty
    ///      value, and `[].includes(x)` is always false, so an empty allowlist denies EVERY
    ///      action. `if (terms.length == 0) return; // no restriction` would flip deny-all into
    ///      allow-all, which is the single most dangerous line that could be written here.
    function test_Targets_EmptyAllowlistDeniesEverything() public {
        Delegation memory d = _mandateWithCaveat(Caveat({enforcer: address(targetsE), terms: "", args: ""}));
        _assertDenied(
            d, transferExec(1), Rules.CONTRACT_ALLOWLIST, Reasons.TARGET_NOT_ALLOWED, "empty allowlist"
        );
    }

    function test_Targets_RejectsUnalignedTerms() public {
        vm.expectRevert(AllowedTargetsEnforcer.InvalidTerms.selector);
        targetsE.beforeHook(hex"aabbcc", "", bytes32(0), transferExec(1), bytes32(0), address(0), address(0));
    }

    function test_Targets_RejectsOversizedAllowlist() public {
        address[] memory many = new address[](33);
        for (uint256 i; i < 33; ++i) {
            many[i] = address(uint160(i + 1));
        }
        vm.expectRevert(AllowedTargetsEnforcer.InvalidTerms.selector);
        targetsE.beforeHook(
            packAddresses(many), "", bytes32(0), transferExec(1), bytes32(0), address(0), address(0)
        );
    }

    // ------------------------------------------------------------------ selector_allowlist

    function test_Selectors_AllowsListedSelector() public {
        _assertAllowed(standardMandate(1000 ether, 1000 ether, SOON), transferExec(1), "transfer is listed");
    }

    function test_Selectors_DeniesUnlistedSelector() public {
        Delegation memory d = standardMandate(1000 ether, 1000 ether, SOON);
        bytes memory exec =
            execOf(address(token), 0, abi.encodeWithSelector(bytes4(0xdeadbeef), recipient, uint256(1)));
        // The target allowlist passes (still the token) and the selector allowlist is what
        // denies, which is also a check that constraint order is preserved.
        _assertDenied(d, exec, Rules.SELECTOR_ALLOWLIST, Reasons.SELECTOR_NOT_ALLOWED, "unlisted selector");
    }

    function test_Selectors_EmptyAllowlistDeniesEverything() public {
        Delegation memory d = _mandateWithCaveat(Caveat({enforcer: address(selectorsE), terms: "", args: ""}));
        _assertDenied(
            d, transferExec(1), Rules.SELECTOR_ALLOWLIST, Reasons.SELECTOR_NOT_ALLOWED, "empty selector list"
        );
    }

    /// @dev A bare call with no calldata has no selector to match. Off chain the selector is an
    ///      arbitrary string so `'0x'` could sit in an allowlist and match; on chain there is
    ///      bytes4 or nothing, and nothing denies.
    function test_Selectors_DeniesCallWithNoSelector() public {
        Delegation memory d = _mandateWithCaveat(
            Caveat({enforcer: address(selectorsE), terms: packSelectors(one(TRANSFER_SELECTOR)), args: ""})
        );
        bytes memory exec = execOf(address(token), 0, "");
        _assertDenied(d, exec, Rules.SELECTOR_ALLOWLIST, Reasons.NO_SELECTOR, "no selector");
    }

    function test_Selectors_RejectsUnalignedTerms() public {
        vm.expectRevert(AllowedSelectorsEnforcer.InvalidTerms.selector);
        selectorsE.beforeHook(
            hex"aabbccddee", "", bytes32(0), transferExec(1), bytes32(0), address(0), address(0)
        );
    }

    // ------------------------------------------------------------------ asset_scope

    function test_AssetScope_AllowsScopedAsset() public {
        _assertAllowed(standardMandate(1000 ether, 1000 ether, SOON), transferExec(1), "token is in scope");
    }

    function test_AssetScope_DeniesUnscopedAsset() public {
        MockERC20 other = new MockERC20();
        AmountSite[] memory sites = siteFor(address(token), TRANSFER_SELECTOR, address(other), 1);
        Delegation memory d = _mandateWithCaveat(
            Caveat({enforcer: address(assetsE), terms: abi.encode(one(address(token)), sites), args: ""})
        );
        _assertDenied(
            d, transferExec(1), Rules.ASSET_SCOPE, Reasons.ASSET_OUT_OF_SCOPE, "asset outside scope"
        );
    }

    function test_AssetScope_EmptyScopeDeniesEverything() public {
        AmountSite[] memory sites = siteFor(address(token), TRANSFER_SELECTOR, address(token), 1);
        address[] memory empty = new address[](0);
        Delegation memory d = _mandateWithCaveat(
            Caveat({enforcer: address(assetsE), terms: abi.encode(empty, sites), args: ""})
        );
        _assertDenied(d, transferExec(1), Rules.ASSET_SCOPE, Reasons.ASSET_OUT_OF_SCOPE, "empty scope");
    }

    /// @dev A call the mandate never declared an asset for cannot be scoped, so it is denied.
    ///      "Unknown call, so no asset, so nothing to check" would be a total bypass.
    function test_AssetScope_DeniesUndeclaredCall() public {
        AmountSite[] memory sites = siteFor(address(token), bytes4(0x11111111), address(token), 1);
        Delegation memory d = _mandateWithCaveat(
            Caveat({enforcer: address(assetsE), terms: abi.encode(one(address(token)), sites), args: ""})
        );
        _assertDenied(
            d, transferExec(1), Rules.ASSET_SCOPE, Reasons.ASSET_NOT_DECLARED, "no site for this call"
        );
    }

    /// @dev address(0) is also the uninitialised default, so a bug leaving an asset field zero
    ///      must never read as "in scope".
    function test_AssetScope_RejectsZeroAddressInScope() public {
        AmountSite[] memory sites = siteFor(address(token), TRANSFER_SELECTOR, address(token), 1);
        address[] memory scope = new address[](1);
        scope[0] = address(0);
        vm.expectRevert(AssetScopeEnforcer.InvalidTerms.selector);
        assetsE.beforeHook(
            abi.encode(scope, sites), "", bytes32(0), transferExec(1), bytes32(0), address(0), address(0)
        );
    }

    // ------------------------------------------------------------------ per_action_cap

    function test_PerActionCap_AllowsBelowCap() public {
        _assertAllowed(standardMandate(100, 1000, SOON), transferExec(99), "99 < 100");
    }

    /// @dev policy.ts denies on `amount > cap`, so `amount == cap` is ALLOWED.
    ///      `require(amount < cap)` breaks the legitimate "spend exactly your cap" action.
    function test_PerActionCap_AllowsExactlyAtCap() public {
        _assertAllowed(standardMandate(100, 1000, SOON), transferExec(100), "amount == cap must allow");
    }

    function test_PerActionCap_DeniesOneOverCap() public {
        _assertDenied(
            standardMandate(100, 1000, SOON),
            transferExec(101),
            Rules.PER_ACTION_CAP,
            Reasons.OVER_PER_ACTION_CAP,
            "cap + 1 must deny"
        );
    }

    /// @dev The most important default in the whole design. `harvest()` carries no amount
    ///      anywhere in its calldata. Treating an undecodable call as amount zero would let it
    ///      through every cap.
    function test_PerActionCap_FailsClosedOnUndecodableCall() public {
        MockProtocol protocol = new MockProtocol(token);
        AmountSite[] memory sites =
            siteFor(address(protocol), bytes4(keccak256("repayBorrow(uint256)")), address(token), 0);

        Caveat[] memory caveats = new Caveat[](2);
        caveats[0] = expiryCaveat(SOON);
        caveats[1] =
            Caveat({enforcer: address(perActionE), terms: capTerms(address(token), 100, sites), args: ""});
        Delegation memory d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);

        bytes memory exec = execOf(address(protocol), 0, abi.encodeWithSignature("harvest()"));
        _assertDenied(d, exec, Rules.PER_ACTION_CAP, Reasons.AMOUNT_NOT_DECODABLE, "no site for harvest()");
    }

    /// @dev A cap is denominated in one asset. A call that moves a different token is one this
    ///      cap cannot price, and is denied rather than waved through.
    function test_PerActionCap_DeniesCallMovingADifferentAsset() public {
        MockERC20 other = new MockERC20();
        AmountSite[] memory sites = siteFor(address(token), TRANSFER_SELECTOR, address(other), 1);

        Caveat[] memory caveats = new Caveat[](2);
        caveats[0] = expiryCaveat(SOON);
        caveats[1] =
            Caveat({enforcer: address(perActionE), terms: capTerms(address(token), 100, sites), args: ""});
        Delegation memory d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);

        _assertDenied(
            d, transferExec(1), Rules.PER_ACTION_CAP, Reasons.CAP_ASSET_MISMATCH, "cap cannot price this"
        );
    }

    function test_PerActionCap_RejectsEmptySiteTable() public {
        AmountSite[] memory none = new AmountSite[](0);
        vm.expectRevert(CapTermsLib.InvalidTerms.selector);
        vm.prank(address(manager));
        perActionE.beforeHook(
            capTerms(address(token), 100, none),
            "",
            bytes32(0),
            transferExec(1),
            bytes32(uint256(1)),
            address(account),
            agent
        );
    }

    /// @dev Every hook is a public function. Without this pin anyone could call beforeHook
    ///      with a victim's delegationHash and brick a live mandate.
    function test_StatefulEnforcers_RejectDirectCalls() public {
        AmountSite[] memory sites = siteFor(address(token), TRANSFER_SELECTOR, address(token), 1);

        vm.expectRevert(StatefulCaveatEnforcerBase.NotDelegationManager.selector);
        vm.prank(stranger);
        perActionE.beforeHook(
            capTerms(address(token), 100, sites),
            "",
            bytes32(0),
            transferExec(1),
            bytes32(uint256(1)),
            address(account),
            agent
        );

        vm.expectRevert(StatefulCaveatEnforcerBase.NotDelegationManager.selector);
        vm.prank(stranger);
        sessionE.beforeHook(
            capTerms(address(token), 100, sites),
            "",
            bytes32(0),
            transferExec(1),
            bytes32(uint256(1)),
            address(account),
            agent
        );
    }

    // ------------------------------------------------------------------ session_total_cap

    function test_SessionCap_AccumulatesAcrossRedemptions() public {
        Delegation memory d = standardMandate(100, 250, SOON);
        bytes32 h = manager.getDelegationHash(d);

        redeem(d, transferExec(100));
        assertEq(sessionE.spentOf(address(manager), h), 100, "first redemption");
        redeem(d, transferExec(100));
        assertEq(sessionE.spentOf(address(manager), h), 200, "second redemption");

        // 200 + 50 == 250 == cap. Equality is allowed.
        redeem(d, transferExec(50));
        assertEq(sessionE.spentOf(address(manager), h), 250, "spent + amount == cap must allow");
        assertEq(sessionE.remainingOf(address(manager), h, 250), 0, "budget exhausted");

        _assertDenied(
            d, transferExec(1), Rules.SESSION_TOTAL_CAP, Reasons.OVER_SESSION_CAP, "one wei past the cap"
        );
    }

    /// @dev The counter is incremented in the beforeHook, so a reverting execution un-counts
    ///      automatically: the whole transaction reverts. An after-the-fact increment would
    ///      leave the budget consumed by a transfer that never happened.
    function test_SessionCap_RevertingExecutionDoesNotConsumeBudget() public {
        Delegation memory d = standardMandate(10_000_000 ether, 10_000_000 ether, SOON);
        bytes32 h = manager.getDelegationHash(d);

        // More than the account holds: MockERC20 underflows and reverts.
        vm.expectRevert();
        redeem(d, transferExec(2_000_000 ether));

        assertEq(sessionE.spentOf(address(manager), h), 0, "a failed execution must not consume budget");
    }

    function test_SessionCap_SpentIsIsolatedPerDelegation() public {
        Delegation memory a = standardMandate(100, 250, SOON);
        Delegation memory b = standardMandate(100, 250, SOON);
        b.salt = 999;
        b.signature = signAs(OWNER_PK, b);

        redeem(a, transferExec(100));
        assertEq(sessionE.spentOf(address(manager), manager.getDelegationHash(a)), 100, "a spent");
        // A second delegation compiled from the same policy has its own budget, i.e. twice the
        // cap. The session IS the delegation; the API must mint exactly one per session.
        assertEq(sessionE.spentOf(address(manager), manager.getDelegationHash(b)), 0, "b is independent");
    }

    // ------------------------------------------------------------------ helpers

    /// @dev A minimal mandate: expiry at index 0 plus the one caveat under test.
    function _mandateWithCaveat(Caveat memory c) internal view returns (Delegation memory d) {
        Caveat[] memory caveats = new Caveat[](2);
        caveats[0] = expiryCaveat(SOON);
        caveats[1] = c;
        d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);
    }
}
