// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./base/Fixture.sol";
import {AiKiDelegationManager} from "../src/core/AiKiDelegationManager.sol";
import {AmountSite, Caveat, Delegation} from "../src/core/Types.sol";
import {PolicyDenied, Rules, Reasons} from "../src/core/Errors.sol";
import {SessionTotalCapEnforcer} from "../src/enforcers/SessionTotalCapEnforcer.sol";
import {PerActionCapEnforcer} from "../src/enforcers/PerActionCapEnforcer.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockProtocol, ReentrantTarget} from "./mocks/MockTargets.sol";

/// @notice One test per attack the design review identified. Each names the attacker, the
///         primitive, and the mechanism that stops it.
contract AttacksTest is Fixture {
    uint256 internal constant NOW = 1_800_000_000;
    uint256 internal constant SOON = 1_800_003_600;

    function setUp() public {
        deploySuite();
        vm.warp(NOW);
    }

    /// @notice MALICIOUS THIRD PARTY: call the stateful enforcer's hook directly with a
    ///         victim's delegationHash to exhaust the cap and brick a live mandate.
    /// @dev Stopped by `onlyManager` with an immutable manager address, plus keying every
    ///      mapping by `msg.sender` so even a second manager cannot reach these counters.
    function test_Attack_OutsiderCannotPoisonASessionCounter() public {
        Delegation memory d = standardMandate(100 ether, 250 ether, SOON);
        bytes32 h = manager.getDelegationHash(d);
        AmountSite[] memory sites = siteFor(address(token), TRANSFER_SELECTOR, address(token), 1);

        vm.prank(stranger);
        vm.expectRevert();
        sessionE.beforeHook(
            capTerms(address(token), 250 ether, sites),
            "",
            bytes32(0),
            transferExec(250 ether),
            h,
            address(account),
            agent
        );

        assertEq(sessionE.spentOf(address(manager), h), 0, "counter untouched");
        redeem(d, transferExec(100 ether));
        assertEq(sessionE.spentOf(address(manager), h), 100 ether, "mandate still usable");
    }

    /// @notice MALICIOUS AGENT: reenter `redeemDelegations` from inside the execution, with the
    ///         same delegation, to interleave with the outstanding balance snapshots.
    /// @dev Stopped twice over: the manager's `nonReentrant` guard, and each stateful
    ///      enforcer's own snapshot lock, which survives a future manager without a guard.
    function test_Attack_ReentrantRedemptionIsBlocked() public {
        ReentrantTarget hostile = new ReentrantTarget(manager);
        AmountSite[] memory sites =
            siteFor(address(hostile), bytes4(keccak256("poke(uint256)")), address(token), 0);

        Caveat[] memory caveats = new Caveat[](4);
        caveats[0] = expiryCaveat(SOON);
        caveats[1] =
            Caveat({enforcer: address(targetsE), terms: packAddresses(one(address(hostile))), args: ""});
        caveats[2] = Caveat({
            enforcer: address(perActionE), terms: capTerms(address(token), 100 ether, sites), args: ""
        });
        caveats[3] = Caveat({
            enforcer: address(sessionE), terms: capTerms(address(token), 100 ether, sites), args: ""
        });

        Delegation memory d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);

        bytes memory exec =
            execOf(address(hostile), 0, abi.encodeWithSignature("poke(uint256)", uint256(60 ether)));
        hostile.arm(contextOf(d), exec);

        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), exec);
        vm.prank(agent);
        vm.expectRevert(AiKiDelegationManager.Reentrancy.selector);
        manager.redeemDelegations(c, m, e);

        // Two redemptions of 60 under a session cap of 100 must never both land.
        assertEq(sessionE.spentOf(address(manager), manager.getDelegationHash(d)), 0, "nothing committed");
    }

    /// @notice MALICIOUS AGENT: `approve(attacker, type(uint256).max)`. It moves zero tokens
    ///         now, so a balance-delta cap reads a delta of zero, and the attacker drains
    ///         later through `transferFrom` in a transaction that never touches the manager.
    /// @dev Stopped because the amount comes from the SIGNED site, not from the delta: an
    ///      approval is charged at its full granted value at grant time. A delta-only cap
    ///      would wave this through, which is why the delta is a backstop and never the sole
    ///      check.
    function test_Attack_UnlimitedApprovalIsChargedAtGrantTime() public {
        bytes4 approveSel = bytes4(keccak256("approve(address,uint256)"));
        AmountSite[] memory sites = siteFor(address(token), approveSel, address(token), 1);

        Caveat[] memory caveats = new Caveat[](3);
        caveats[0] = expiryCaveat(SOON);
        caveats[1] =
            Caveat({enforcer: address(targetsE), terms: packAddresses(one(address(token))), args: ""});
        caveats[2] = Caveat({
            enforcer: address(perActionE), terms: capTerms(address(token), 100 ether, sites), args: ""
        });

        Delegation memory d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);

        bytes memory exec =
            execOf(address(token), 0, abi.encodeWithSelector(approveSel, stranger, type(uint256).max));
        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), exec);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyDenied.selector, Rules.PER_ACTION_CAP, Reasons.OVER_PER_ACTION_CAP)
        );
        manager.redeemDelegations(c, m, e);

        assertEq(token.allowance(address(account), stranger), 0, "no allowance was granted");
    }

    /// @notice MALICIOUS AGENT: route through an allowlisted contract that exposes a generic
    ///         forwarder, turning one allowed selector into an arbitrary inner call.
    /// @dev The allowlists ARE escaped -- this is a real and unavoidable limitation of checking
    ///      only the outer call, and both evaluators share it. What holds is the value bound:
    ///      the forwarding selector has no signed amount site, so the cap enforcer refuses to
    ///      price the call and denies it outright rather than treating it as amount zero.
    function test_Attack_ForwarderEscapesTheSelectorAllowlistButNotTheCap() public {
        MockProtocol protocol = new MockProtocol(token);
        AmountSite[] memory sites =
            siteFor(address(protocol), bytes4(keccak256("repayBorrow(uint256)")), address(token), 0);

        bytes4 forwardSel = bytes4(keccak256("forward(address,bytes)"));
        bytes4[] memory allowed = new bytes4[](2);
        allowed[0] = bytes4(keccak256("repayBorrow(uint256)"));
        allowed[1] = forwardSel; // a curation mistake: a universal forwarder got allowlisted

        Caveat[] memory caveats = new Caveat[](4);
        caveats[0] = expiryCaveat(SOON);
        caveats[1] =
            Caveat({enforcer: address(targetsE), terms: packAddresses(one(address(protocol))), args: ""});
        caveats[2] = Caveat({enforcer: address(selectorsE), terms: packSelectors(allowed), args: ""});
        caveats[3] = Caveat({
            enforcer: address(perActionE), terms: capTerms(address(token), 10 ether, sites), args: ""
        });

        Delegation memory d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);

        bytes memory inner = abi.encodeWithSelector(TRANSFER_SELECTOR, stranger, uint256(500 ether));
        bytes memory exec =
            execOf(address(protocol), 0, abi.encodeWithSelector(forwardSel, address(token), inner));

        vm.prank(agent);
        (bool allow, string memory rule, string memory reason) = manager.dryRun(d, bytes32(0), exec);
        assertFalse(allow, "the cap refuses to price a forwarded call");
        assertEq(rule, Rules.PER_ACTION_CAP, "rule");
        assertEq(reason, Reasons.AMOUNT_NOT_DECODABLE, "fails closed on an unpriceable call");
    }

    /// @notice MALICIOUS TARGET: a protocol call whose token movement never appears in the
    ///         top-level calldata (the Venus `repayBorrow` shape).
    /// @dev The signed site declares which token moves and where the amount sits, so the cap
    ///      applies. This is the case a calldata-shape-guessing decoder gets wrong.
    function test_ProtocolCallWithHiddenTransferIsStillCapped() public {
        MockProtocol protocol = new MockProtocol(token);
        bytes4 repay = bytes4(keccak256("repayBorrow(uint256)"));
        AmountSite[] memory sites = siteFor(address(protocol), repay, address(token), 0);

        Caveat[] memory caveats = new Caveat[](3);
        caveats[0] = expiryCaveat(SOON);
        caveats[1] =
            Caveat({enforcer: address(targetsE), terms: packAddresses(one(address(protocol))), args: ""});
        caveats[2] = Caveat({
            enforcer: address(perActionE), terms: capTerms(address(token), 100 ether, sites), args: ""
        });

        Delegation memory d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);

        vm.prank(owner);
        account.execute(
            address(token),
            0,
            abi.encodeWithSignature("approve(address,uint256)", address(protocol), type(uint256).max)
        );

        redeem(d, execOf(address(protocol), 0, abi.encodeWithSelector(repay, uint256(100 ether))));
        assertEq(token.balanceOf(address(protocol)), 100 ether, "the protocol pulled the tokens");

        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(
            d, bytes32(0), execOf(address(protocol), 0, abi.encodeWithSelector(repay, uint256(101 ether)))
        );
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyDenied.selector, Rules.PER_ACTION_CAP, Reasons.OVER_PER_ACTION_CAP)
        );
        manager.redeemDelegations(c, m, e);
    }

    /// @notice MALICIOUS TARGET: move MORE than the calldata declares, so a decode-only cap
    ///         under-measures. A fee-on-transfer token does this by accident on BNB Chain.
    /// @dev Caught by the afterHook balance-delta backstop: the charge is
    ///      `max(declared, realised)`, so the stricter of the two measurements wins.
    function test_Attack_MovingMoreThanDeclaredIsCaughtByTheDeltaBackstop() public {
        DoubleDebitToken evil = new DoubleDebitToken();
        evil.mint(address(account), 1_000 ether);

        AmountSite[] memory sites = siteFor(address(evil), TRANSFER_SELECTOR, address(evil), 1);
        Caveat[] memory caveats = new Caveat[](3);
        caveats[0] = expiryCaveat(SOON);
        caveats[1] = Caveat({enforcer: address(targetsE), terms: packAddresses(one(address(evil))), args: ""});
        caveats[2] = Caveat({
            enforcer: address(perActionE), terms: capTerms(address(evil), 100 ether, sites), args: ""
        });

        Delegation memory hostileMandate = baseDelegation(address(account), caveats);
        hostileMandate.delegate = agent;
        hostileMandate.salt = 42;
        hostileMandate.signature = signAs(OWNER_PK, hostileMandate);

        // Declares 60 (under the 100 cap) but actually removes 120.
        bytes memory exec =
            execOf(address(evil), 0, abi.encodeWithSelector(TRANSFER_SELECTOR, stranger, uint256(60 ether)));
        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(hostileMandate, bytes32(0), exec);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyDenied.selector, Rules.PER_ACTION_CAP, Reasons.OVER_PER_ACTION_CAP)
        );
        manager.redeemDelegations(c, m, e);

        assertEq(evil.balanceOf(address(account)), 1_000 ether, "nothing left the account");
    }

    /// @notice MALICIOUS TARGET, the other direction: pull the full amount and refund most of
    ///         it in the same transaction, so the NET balance delta is far below what the
    ///         action declared.
    /// @dev This is why the delta can never be the sole check. A delta-only cap would charge 30
    ///      for a call the off-chain evaluator scored as 100, and the mandate would leak budget
    ///      on every round trip. `max(declared, realised)` charges the declared 100.
    function test_RoundTripRefundDoesNotUnderchargeTheSessionBudget() public {
        MockProtocol protocol = new MockProtocol(token);
        protocol.setRefundBps(7_000); // pulls 100, hands back 70, nets 30
        bytes4 repay = bytes4(keccak256("repayBorrow(uint256)"));
        AmountSite[] memory sites = siteFor(address(protocol), repay, address(token), 0);

        Caveat[] memory caveats = new Caveat[](3);
        caveats[0] = expiryCaveat(SOON);
        caveats[1] =
            Caveat({enforcer: address(targetsE), terms: packAddresses(one(address(protocol))), args: ""});
        caveats[2] = Caveat({
            enforcer: address(sessionE), terms: capTerms(address(token), 250 ether, sites), args: ""
        });

        Delegation memory d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);

        vm.prank(owner);
        account.execute(
            address(token),
            0,
            abi.encodeWithSignature("approve(address,uint256)", address(protocol), type(uint256).max)
        );

        redeem(d, execOf(address(protocol), 0, abi.encodeWithSelector(repay, uint256(100 ether))));

        bytes32 h = manager.getDelegationHash(d);
        assertEq(
            sessionE.spentOf(address(manager), h),
            100 ether,
            "the declared amount is charged, not the 30 that netted out"
        );
    }

    /// @notice MALICIOUS AGENT: re-sign the same mandate to obtain a fresh session budget.
    /// @dev Not preventable and not a bug -- a new signature IS a new session. It is recorded
    ///      here because it is INVISIBLE, and a user who re-authorizes believing the lifetime
    ///      cap still holds is being misled. The API must surface it.
    function test_Documented_ReAuthorizationResetsTheSessionBudget() public {
        Delegation memory d = standardMandate(250 ether, 250 ether, SOON);
        redeem(d, transferExec(250 ether));
        assertEq(sessionE.spentOf(address(manager), manager.getDelegationHash(d)), 250 ether, "exhausted");

        Delegation memory renewed = standardMandate(250 ether, 250 ether, SOON);
        renewed.salt = 2;
        renewed.signature = signAs(OWNER_PK, renewed);
        assertEq(
            sessionE.spentOf(address(manager), manager.getDelegationHash(renewed)),
            0,
            "a fresh salt is a fresh budget -- the UI must say so"
        );

        // The same salt resumes the old counter instead, which is equally invisible.
        Delegation memory resumed = standardMandate(250 ether, 250 ether, SOON);
        assertEq(
            sessionE.spentOf(address(manager), manager.getDelegationHash(resumed)),
            250 ether,
            "an identical re-signature inherits the spent counter"
        );
    }

    /// @notice MALICIOUS AGENT: front-run a revocation with a maximum-value redemption.
    /// @dev This CANNOT be made front-run-proof on a public mempool and the design does not
    ///      pretend otherwise. What is bounded is the exposure:
    ///      `min(per_action_cap, session_total_cap - spent)`. That number is exactly what the
    ///      UI should render as "your exposure until revocation confirms".
    function test_Documented_ExposureWindowIsBoundedNotEliminated() public {
        Delegation memory d = standardMandate(100 ether, 250 ether, SOON);
        redeem(d, transferExec(100 ether));

        bytes32 h = manager.getDelegationHash(d);
        uint256 remaining = sessionE.remainingOf(address(manager), h, 250 ether);
        uint256 exposure = remaining < 100 ether ? remaining : 100 ether;
        assertEq(exposure, 100 ether, "exposure is min(per-action cap, remaining session budget)");

        // The agent wins the race and extracts exactly that much, no more.
        redeem(d, transferExec(exposure));
        vm.prank(address(account));
        manager.disableDelegation(d);

        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), transferExec(1));
        vm.prank(agent);
        vm.expectRevert(AiKiDelegationManager.DelegationRevoked.selector);
        manager.redeemDelegations(c, m, e);
    }

    /// @notice MALICIOUS AGENT: batch N transfers each at the per-action cap inside one
    ///         redemption that the off-chain mirror scored as a single Action.
    /// @dev Rejected at the mode check. This is covered in ManagerTest too; it is repeated here
    ///      because it is the cap-multiplication attack, not merely an unsupported feature.
    function test_Attack_BatchModeWouldMultiplyThePerActionCap() public {
        Delegation memory d = standardMandate(100 ether, 10_000 ether, SOON);
        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) =
            prep(d, bytes32(uint256(0x01) << 248), transferExec(100 ether));
        vm.prank(agent);
        vm.expectRevert(AiKiDelegationManager.UnsupportedMode.selector);
        manager.redeemDelegations(c, m, e);
    }
}

/// @notice A token that debits twice what its calldata declares. Stands in for every case where
///         the realised outflow exceeds the declared amount: fee-on-transfer, rebasing, an
///         upgradeable token whose admin changed the rules, or an ABI nobody anticipated.
contract DoubleDebitToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value * 2;
        balanceOf[to] += value;
        return true;
    }
}
