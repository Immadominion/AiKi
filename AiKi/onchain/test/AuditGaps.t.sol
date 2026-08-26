// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./base/Fixture.sol";
import {AiKiDelegationManager} from "../src/core/AiKiDelegationManager.sol";
import {Caveat, Constants, Delegation} from "../src/core/Types.sol";
import {EncoderLib} from "../src/core/EncoderLib.sol";
import {PolicyDenied, Reasons, Rules} from "../src/core/Errors.sol";
import {SessionTotalCapEnforcer} from "../src/enforcers/SessionTotalCapEnforcer.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice The coverage gaps this suite's own adversarial review found.
///
/// @dev Every test here corresponds to a confirmed finding: a defence that was claimed in a
///      comment, relied on in the README, and never exercised. A guard no test can tell apart
///      from its absence is not a guard, and six of these could each have been deleted outright
///      with the suite staying green.
contract AuditGapsTest is Fixture {
    uint256 internal constant NOW = 1_800_000_000;
    uint256 internal constant SOON = 1_800_003_600;

    function setUp() public {
        deploySuite();
        vm.warp(NOW);
    }

    /// @dev Finding: redeemDelegations with more than one execution per call was entirely
    ///      untested, which is the same cap-multiplication surface the batch-mode rejection
    ///      exists to close. Two executions under one 250 cap must not spend 500.
    function test_ManyExecutionsInOneCall_ShareTheCap() public {
        Delegation memory d = standardMandate(250 ether, 250 ether, SOON);

        bytes[] memory contexts = new bytes[](2);
        contexts[0] = contextOf(d);
        contexts[1] = contextOf(d);
        bytes32[] memory modes = new bytes32[](2);
        bytes[] memory execs = new bytes[](2);
        execs[0] = transferExec(200 ether);
        execs[1] = transferExec(200 ether);

        uint256 before = token.balanceOf(address(account));
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyDenied.selector, Rules.SESSION_TOTAL_CAP, Reasons.OVER_SESSION_CAP)
        );
        manager.redeemDelegations(contexts, modes, execs);

        // The whole call reverts, so neither leg lands: 400 was never within a 250 cap.
        assertEq(token.balanceOf(address(account)), before, "a batched call outspent the cap");
    }

    /// @dev Finding: AmountLib's fail-closed path for a calldata word that is not there was
    ///      untested. A short read priced as zero passes every cap, which is a total bypass.
    ///
    ///      The refusal arrives from the asset-scope enforcer rather than the cap, because it
    ///      sits earlier in the caveat list and cannot decode the call either. That is the same
    ///      fail-closed rule reached one caveat sooner, and asserting the enforcer that
    ///      actually answers is more useful than asserting the one I expected.
    function test_UndecodableAmount_IsRefusedRatherThanPricedAtZero() public {
        Delegation memory d = standardMandate(250 ether, 250 ether, SOON);
        // transfer's selector, then a truncated argument section: the site names word 1 and
        // there is no word 1.
        bytes memory truncated = abi.encodePacked(TRANSFER_SELECTOR, bytes32(uint256(uint160(recipient))));
        bytes memory exec = execOf(address(token), 0, truncated);

        uint256 before = token.balanceOf(address(account));
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyDenied.selector, Rules.ASSET_SCOPE, Reasons.ASSET_NOT_DECLARED
            )
        );
        redeemAs(agent, d, bytes32(0), exec);
        assertEq(token.balanceOf(address(account)), before, "an undecodable amount moved value");
    }

    /// @dev Finding: disableDelegationWithSig's signature check had no negative test, so it
    ///      could be deleted and the suite stayed green. A stranger's signature must not
    ///      revoke someone else's mandate, and the nonce must not be replayable.
    function test_RevokeBySignature_RejectsAStrangerAndAReplay() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        bytes32 hash = manager.getDelegationHash(d);
        uint256 nonce = manager.revokeNonce(address(account));

        bytes32 structHash = keccak256(abi.encode(EncoderLib.REVOKE_TYPEHASH, hash, nonce));
        bytes32 digest = EncoderLib.toDigest(manager.domainSeparator(), structHash);

        // A real signature, from the wrong key.
        vm.expectRevert();
        manager.disableDelegationWithSig(hash, address(account), nonce, signRaw(STRANGER_PK, digest));

        // The owner's signature works once.
        bytes memory good = signRaw(OWNER_PK, digest);
        manager.disableDelegationWithSig(hash, address(account), nonce, good);
        assertTrue(manager.isDisabled(hash), "revocation did not take");

        // And exactly once: the nonce moved, so the same signature is spent.
        vm.expectRevert(AiKiDelegationManager.InvalidRevokeNonce.selector);
        manager.disableDelegationWithSig(hash, address(account), nonce, good);
    }

    /// @dev Finding: the enforcer-level snapshot lock, claimed as the second reentrancy
    ///      defence, was never exercised. Opening a second snapshot for one delegation while
    ///      the first is live must revert rather than silently overwrite the balance the
    ///      afterHook will reconcile against.
    function test_SnapshotLock_RefusesASecondOpenSnapshot() public {
        SessionTotalCapEnforcer lone = new SessionTotalCapEnforcer(address(this));
        bytes memory terms = capTerms(address(token), 500 ether, siteFor(address(token), TRANSFER_SELECTOR, address(token), 1));
        bytes memory exec = execOf(address(token), 0, abi.encodeWithSelector(TRANSFER_SELECTOR, recipient, 100 ether));

        lone.beforeHook(terms, "", bytes32(0), exec, keccak256("d"), address(account), agent);
        vm.expectRevert(SessionTotalCapEnforcer.SnapshotAlreadyHeld.selector);
        lone.beforeHook(terms, "", bytes32(0), exec, keccak256("d"), address(account), agent);
    }

    /// @dev Finding: an afterHook with no snapshot must refuse rather than reconcile against
    ///      a zero balance it never took.
    function test_AfterHookWithoutASnapshot_Refuses() public {
        SessionTotalCapEnforcer lone = new SessionTotalCapEnforcer(address(this));
        bytes memory terms = capTerms(address(token), 500 ether, siteFor(address(token), TRANSFER_SELECTOR, address(token), 1));
        bytes memory exec = execOf(address(token), 0, abi.encodeWithSelector(TRANSFER_SELECTOR, recipient, 100 ether));

        vm.expectRevert(SessionTotalCapEnforcer.NoSnapshot.selector);
        lone.afterHook(terms, "", bytes32(0), exec, keccak256("never-opened"), address(account), agent);
    }

    /// @dev Finding: the headline session-cap invariant was vacuous, because the cap was
    ///      unreachable by construction. This reaches it: successive redemptions must sum to
    ///      the cap and the one that would cross it must be the one that fails.
    function test_SessionCapIsActuallyReachable_AndStops() public {
        Delegation memory d = standardMandate(100 ether, 250 ether, SOON);
        redeem(d, transferExec(100 ether));
        redeem(d, transferExec(100 ether));
        assertEq(
            sessionE.spentOf(address(manager), manager.getDelegationHash(d)),
            200 ether,
            "counter did not accumulate"
        );

        // 100 more would be 300 against 250. The cap is the thing that refuses it.
        vm.expectRevert(
            abi.encodeWithSelector(PolicyDenied.selector, Rules.SESSION_TOTAL_CAP, Reasons.OVER_SESSION_CAP)
        );
        redeem(d, transferExec(100 ether));

        // And the remaining 50 is still spendable, so the cap stopped the excess, not the call.
        redeem(d, transferExec(50 ether));
        assertEq(token.balanceOf(recipient), 250 ether, "the cap was not spendable to its limit");
    }

    /// @dev The same fail-closed rule, reached in the cap enforcer itself.
    ///
    ///      The test above does not get there: the asset-scope enforcer sits earlier in the
    ///      caveat list and refuses first, so CapTermsLib's own branch stays unexecuted. I only
    ///      noticed because mutating that branch to price an undecodable amount as zero left
    ///      the suite entirely green, which is precisely the finding. This mandate carries no
    ///      asset-scope caveat, so the cap is the first thing asked to read the amount.
    function test_UndecodableAmount_IsRefusedByTheCapItself() public {
        Caveat[] memory caveats = new Caveat[](2);
        caveats[0] = expiryCaveat(SOON);
        caveats[1] = Caveat({
            enforcer: address(perActionE),
            terms: capTerms(
                address(token), 250 ether, siteFor(address(token), TRANSFER_SELECTOR, address(token), 1)
            ),
            args: ""
        });
        Delegation memory d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);

        bytes memory truncated =
            abi.encodePacked(TRANSFER_SELECTOR, bytes32(uint256(uint160(recipient))));
        bytes memory exec = execOf(address(token), 0, truncated);

        uint256 before = token.balanceOf(address(account));
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyDenied.selector, Rules.PER_ACTION_CAP, Reasons.AMOUNT_NOT_DECODABLE
            )
        );
        redeemAs(agent, d, bytes32(0), exec);
        assertEq(token.balanceOf(address(account)), before, "an undecodable amount moved value");
    }
}
