// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./base/Fixture.sol";
import {AmountSite, Caveat, Delegation} from "../src/core/Types.sol";
import {SentinelForgingERC20} from "./mocks/MockTargets.sol";

/// @notice The dry run must not be able to say ALLOW because someone else said so.
///
/// @dev The API is told to eth_call dryRun on every attempt and alarm on any disagreement with
///      evaluatePolicy, which is what turns "the API's answer is the chain's answer" from an
///      intention into a monitored invariant. A forgeable ALLOW does not merely mislead the
///      API, it silences the alarm that would have caught everything else.
contract DryRunForgeryTest is Fixture {
    uint256 internal constant NOW = 1_800_000_000;
    uint256 internal constant SOON = 1_800_003_600;

    function setUp() public {
        deploySuite();
        vm.warp(NOW);
    }

    function test_AContractReachedDuringAHookCannotForgeAnAllow() public {
        SentinelForgingERC20 forger = new SentinelForgingERC20();

        // A mandate over the hostile token. The stateful cap enforcer will call its balanceOf
        // during beforeHook, and it reverts with the sentinel selector.
        AmountSite[] memory sites =
            siteFor(address(forger), TRANSFER_SELECTOR, address(forger), 1);
        Caveat[] memory caveats = new Caveat[](2);
        caveats[0] = expiryCaveat(SOON);
        caveats[1] = Caveat({
            enforcer: address(sessionE),
            terms: capTerms(address(forger), 500 ether, sites),
            args: ""
        });
        Delegation memory d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);

        bytes memory exec = execOf(
            address(forger), 0, abi.encodeWithSelector(TRANSFER_SELECTOR, recipient, 100 ether)
        );

        vm.prank(agent);
        (bool allow,,) = manager.dryRun(d, bytes32(0), exec);

        // The hooks never completed. Anything but false here is a forged verdict.
        assertFalse(allow, "a contract reached during a hook forged a dry-run ALLOW");
    }

    /// @dev The control: a real allow must still be reported as an allow, or the fix above is
    ///      just "always deny" wearing a disguise.
    function test_AGenuineAllowIsStillReported() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        vm.prank(agent);
        (bool allow, string memory rule,) = manager.dryRun(d, bytes32(0), transferExec(100 ether));
        assertTrue(allow, "a permitted action was reported as denied");
        assertEq(rule, "policy", "wrong rule for an allow");
    }

    /// @dev And a real denial must still carry its own rule and reason rather than being
    ///      flattened into a generic failure.
    function test_AGenuineDenialKeepsItsRuleAndReason() public {
        Delegation memory d = standardMandate(100 ether, 500 ether, SOON);
        vm.prank(agent);
        (bool allow, string memory rule, string memory reason) =
            manager.dryRun(d, bytes32(0), transferExec(150 ether));
        assertFalse(allow, "an over-cap action was reported as allowed");
        assertEq(rule, "per_action_cap", "denial lost its rule");
        assertEq(reason, "Action exceeds per-action cap.", "denial lost its reason");
    }
}
