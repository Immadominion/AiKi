// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./base/Fixture.sol";
import {AmountSite, Caveat, Delegation} from "../src/core/Types.sol";
import {PolicyDenied, Reasons, Rules} from "../src/core/Errors.sol";
import {PullingTarget} from "./mocks/MockTargets.sol";

/// @notice What the session counter charges when an execution moves more than it named.
///
/// @dev The review flagged that the balance-delta afterHook charges outflows the execution did
///      not cause, so the on-chain counter can run ahead of the off-chain mirror's. That is
///      real, and these tests pin down its boundary rather than removing it, because the
///      alternative is worse in every direction: trusting the amount in calldata is exactly the
///      bypass a fee-on-transfer or rebasing token walks through, and it is how a cap stops
///      meaning anything.
///
///      The scope is narrower than it first sounds. The snapshot spans one execution inside one
///      transaction, the manager is non-reentrant, and the account accepts calls only from the
///      manager, so nothing unrelated can move the delegator's balance in between. What remains
///      is a target the mandate ITSELF allowlisted drawing on an allowance the delegator
///      granted, which is an outflow the user authorised twice over.
contract UnnamedOutflowTest is Fixture {
    uint256 internal constant NOW = 1_800_000_000;
    uint256 internal constant SOON = 1_800_003_600;
    address internal sink = address(0x51ee);

    function setUp() public {
        deploySuite();
        vm.warp(NOW);
    }

    function mandateOver(address target, uint256 cap) internal view returns (Delegation memory d) {
        AmountSite[] memory sites = siteFor(target, TRANSFER_SELECTOR, address(token), 1);
        Caveat[] memory caveats = new Caveat[](4);
        caveats[0] = expiryCaveat(SOON);
        caveats[1] = Caveat({enforcer: address(targetsE), terms: packAddresses(one(target)), args: ""});
        caveats[2] =
            Caveat({enforcer: address(selectorsE), terms: packSelectors(one(TRANSFER_SELECTOR)), args: ""});
        caveats[3] =
            Caveat({enforcer: address(sessionE), terms: capTerms(address(token), cap, sites), args: ""});
        d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);
    }

    function test_AnUnnamedOutflowIsCharged_NotIgnored() public {
        PullingTarget target = new PullingTarget(address(token), sink);
        // The delegator's own prior allowance. Nothing in the mandate grants this.
        vm.prank(address(account));
        token.approve(address(target), type(uint256).max);

        Delegation memory d = mandateOver(address(target), 500 ether);
        bytes memory exec = execOf(
            address(target), 0, abi.encodeWithSelector(TRANSFER_SELECTOR, recipient, 100 ether)
        );
        redeemAs(agent, d, bytes32(0), exec);

        assertEq(token.balanceOf(recipient), 100 ether, "the named transfer did not happen");
        assertEq(token.balanceOf(sink), 50 ether, "the unnamed transfer did not happen");
        // 150 actually left the account, and 150 is what the cap is charged. A counter that
        // recorded the 100 in calldata would let the next call spend 400 of a 500 cap after
        // 150 had already gone.
        assertEq(
            sessionE.spentOf(address(manager), manager.getDelegationHash(d)),
            150 ether,
            "the counter recorded the named amount rather than what left"
        );
    }

    function test_AnUnnamedOutflowPastTheCapUnwindsEverything() public {
        PullingTarget target = new PullingTarget(address(token), sink);
        vm.prank(address(account));
        token.approve(address(target), type(uint256).max);

        // 100 named fits a 120 cap; the 150 actually moved does not.
        Delegation memory d = mandateOver(address(target), 120 ether);
        bytes memory exec = execOf(
            address(target), 0, abi.encodeWithSelector(TRANSFER_SELECTOR, recipient, 100 ether)
        );

        uint256 before = token.balanceOf(address(account));
        vm.expectRevert(
            abi.encodeWithSelector(PolicyDenied.selector, Rules.SESSION_TOTAL_CAP, Reasons.OVER_SESSION_CAP)
        );
        redeemAs(agent, d, bytes32(0), exec);

        // Both legs unwind: a cap that only caught the overspend after the money left would be
        // a report, not a limit.
        assertEq(token.balanceOf(address(account)), before, "the redemption did not unwind");
        assertEq(token.balanceOf(sink), 0, "the unnamed outflow survived a denied redemption");
    }
}
