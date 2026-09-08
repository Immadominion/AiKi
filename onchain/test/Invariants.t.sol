// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./base/Fixture.sol";
import {Delegation} from "../src/core/Types.sol";
import {Rules} from "../src/core/Errors.sol";

/// @notice The semantics of policy.ts stated as properties over the whole input domain, rather
///         than as table rows. The corpus proves agreement on ~190 specific tuples; these prove
///         the shape of the rule everywhere, including magnitudes no corpus would think to try.
contract InvariantsTest is Fixture {
    uint256 internal constant NOW = 1_800_000_000;
    uint256 internal constant FOREVER = type(uint64).max;

    function setUp() public {
        deploySuite();
        vm.warp(NOW);
    }

    /// @dev policy.ts line 64: deny iff `amount > cap`. Equality allows, everywhere.
    function testFuzz_PerActionCapBoundary(uint256 amount, uint256 cap) public {
        Delegation memory d = standardMandate(cap, type(uint256).max, FOREVER);
        vm.prank(agent);
        (bool allow, string memory rule,) = manager.dryRun(d, bytes32(0), transferExec(amount));

        assertEq(allow, amount <= cap, "per-action cap must deny exactly when amount > cap");
        if (!allow) assertEq(rule, Rules.PER_ACTION_CAP, "the per-action cap is what denied");
    }

    /// @dev policy.ts line 66: deny iff `spent + amount > cap`. The check is prospective and
    ///      equality allows. Seeding `spent` directly covers magnitudes a real sequence of
    ///      redemptions could never reach.
    function testFuzz_SessionCapBoundary(uint256 amount, uint256 cap, uint256 spent) public {
        Delegation memory d = standardMandate(type(uint256).max, cap, FOREVER);
        bytes32 h = manager.getDelegationHash(d);
        vm.store(address(sessionE), sessionSpentSlot(address(manager), h), bytes32(spent));
        assertEq(sessionE.spentOf(address(manager), h), spent, "seeded");

        vm.prank(agent);
        (bool allow, string memory rule,) = manager.dryRun(d, bytes32(0), transferExec(amount));

        // Overflow-safe restatement of the BigInt comparison `spent + amount > cap`.
        bool expected = amount <= cap && spent <= cap - amount;
        assertEq(allow, expected, "session cap must deny exactly when spent + amount > cap");
        if (!allow) assertEq(rule, Rules.SESSION_TOTAL_CAP, "the session cap is what denied");
    }

    /// @dev policy.ts line 54: deny iff `at >= expiresAt`. Equality denies.
    function testFuzz_ExpiryBoundary(uint64 expiresAt, uint64 at) public {
        vm.assume(at > 0);
        vm.warp(at);
        Delegation memory d = standardMandate(type(uint256).max, type(uint256).max, expiresAt);
        vm.prank(agent);
        (bool allow, string memory rule,) = manager.dryRun(d, bytes32(0), transferExec(1));

        assertEq(allow, at < expiresAt, "expiry must deny at and after the deadline");
        if (!allow) assertEq(rule, Rules.EXPIRY, "expiry is what denied");
    }

    /// @notice THE property the session cap exists to provide: across ANY sequence of
    ///         redemptions -- including ones that revert -- the total value that leaves the
    ///         account under a mandate can never exceed its session cap.
    function testFuzz_SessionSpendNeverExceedsCapAcrossAnySequence(uint64[8] calldata amounts) public {
        uint256 perCap = 300 ether;
        uint256 sessionCap = 1_000 ether;
        Delegation memory d = standardMandate(perCap, sessionCap, FOREVER);
        bytes32 h = manager.getDelegationHash(d);

        uint256 startingBalance = token.balanceOf(address(account));

        for (uint256 i; i < amounts.length; ++i) {
            (bytes[] memory c, bytes32[] memory m, bytes[] memory e) =
                prep(d, bytes32(0), transferExec(amounts[i]));
            vm.prank(agent);
            try manager.redeemDelegations(c, m, e) {} catch {}
        }

        uint256 spent = sessionE.spentOf(address(manager), h);
        assertTrue(spent <= sessionCap, "the counter never exceeds the cap");

        uint256 moved = startingBalance - token.balanceOf(address(account));
        assertTrue(moved <= sessionCap, "value that actually left never exceeds the cap");
        assertEq(moved, spent, "the counter and the realised outflow agree");
    }

    /// @dev A reverting execution must never leave the counter incremented. The counter is
    ///      bumped in the beforeHook precisely so the transaction revert un-counts it.
    function testFuzz_FailedRedemptionsLeaveNoResidue(uint64 amount) public {
        Delegation memory d = standardMandate(100 ether, 1_000 ether, FOREVER);
        bytes32 h = manager.getDelegationHash(d);

        // Every one of these must fail for a different reason and leave nothing behind.
        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) =
            prep(d, bytes32(0), transferExec(uint256(amount) + 100 ether + 1));
        vm.prank(agent);
        try manager.redeemDelegations(c, m, e) {} catch {}
        assertEq(sessionE.spentOf(address(manager), h), 0, "over-cap attempt left no residue");

        (c, m, e) = prep(d, bytes32(0), transferExec(amount));
        vm.prank(stranger);
        try manager.redeemDelegations(c, m, e) {} catch {}
        assertEq(sessionE.spentOf(address(manager), h), 0, "wrong-redeemer attempt left no residue");
    }
}
