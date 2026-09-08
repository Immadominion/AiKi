// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./base/Fixture.sol";
import {AiKiDelegationManager} from "../src/core/AiKiDelegationManager.sol";
import {AiKiMandateAccount} from "../src/account/AiKiMandateAccount.sol";
import {AmountSite, Caveat, Constants, Delegation} from "../src/core/Types.sol";
import {EncoderLib} from "../src/core/EncoderLib.sol";
import {ExecutionLib} from "../src/core/ExecutionLib.sol";
import {SignatureLib} from "../src/core/SignatureLib.sol";
import {PolicyDenied, Rules, Reasons} from "../src/core/Errors.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {HostileSigner, PermissiveSigner, NoopEnforcer} from "./mocks/MockTargets.sol";

/// @notice The manager's own contract: authentication, the structural invariants that have no
///         off-chain twin, revocation, and the dry-run path the API depends on.
contract ManagerTest is Fixture {
    uint256 internal constant NOW = 1_800_000_000;
    uint256 internal constant SOON = 1_800_003_600;

    function setUp() public {
        deploySuite();
        vm.warp(NOW);
    }

    // ------------------------------------------------------------------ happy path

    function test_Redeem_MovesTokensAndRecordsSpend() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        uint256 before = token.balanceOf(address(account));

        redeem(d, transferExec(250 ether));

        assertEq(token.balanceOf(recipient), 250 ether, "recipient received the transfer");
        assertEq(token.balanceOf(address(account)), before - 250 ether, "account was debited");
        assertEq(
            sessionE.spentOf(address(manager), manager.getDelegationHash(d)),
            250 ether,
            "on-chain spend counter"
        );
    }

    /// @dev The invariant the product's central claim rests on: the answer the API gets from
    ///      `dryRun` is the answer the chain gives when the transaction actually lands.
    function test_DryRunAgreesWithRedemption() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);

        vm.prank(agent);
        (bool allow,,) = manager.dryRun(d, bytes32(0), transferExec(250 ether));
        assertTrue(allow, "dry run allows");
        redeem(d, transferExec(250 ether));

        vm.prank(agent);
        (bool allow2, string memory rule, string memory reason) =
            manager.dryRun(d, bytes32(0), transferExec(251 ether));
        assertFalse(allow2, "dry run denies over-cap");
        assertEq(rule, Rules.PER_ACTION_CAP, "rule");
        assertEq(reason, Reasons.OVER_PER_ACTION_CAP, "reason");

        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) =
            prep(d, bytes32(0), transferExec(251 ether));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyDenied.selector, rule, reason));
        manager.redeemDelegations(c, m, e);
    }

    /// @dev dryRun writes state (the session counter) and must roll all of it back.
    function test_DryRunDoesNotConsumeBudget() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        bytes32 h = manager.getDelegationHash(d);
        vm.prank(agent);
        manager.dryRun(d, bytes32(0), transferExec(250 ether));
        assertEq(sessionE.spentOf(address(manager), h), 0, "a dry run must not spend");
    }

    // ------------------------------------------------------------------ structural rejections

    function test_RejectsBatchAndDelegatecallAndTryModes() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        bytes32[3] memory bad = [
            bytes32(uint256(0x01) << 248), // CALLTYPE_BATCH
            bytes32(uint256(0xff) << 248), // CALLTYPE_DELEGATECALL
            bytes32(uint256(0x01) << 216) // EXECTYPE_TRY
        ];
        for (uint256 i; i < 3; ++i) {
            (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bad[i], transferExec(1 ether));
            vm.prank(agent);
            vm.expectRevert(AiKiDelegationManager.UnsupportedMode.selector);
            manager.redeemDelegations(c, m, e);
        }
    }

    function test_RejectsNonRootAuthority() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        d.authority = bytes32(uint256(1));
        d.signature = signAs(OWNER_PK, d);
        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), transferExec(1 ether));
        vm.prank(agent);
        vm.expectRevert(AiKiDelegationManager.RedelegationUnsupported.selector);
        manager.redeemDelegations(c, m, e);
    }

    function test_RejectsRedelegationChain() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        Delegation[] memory chain = new Delegation[](2);
        chain[0] = d;
        chain[1] = d;
        bytes[] memory c = new bytes[](1);
        c[0] = abi.encode(chain);
        bytes32[] memory m = new bytes32[](1);
        bytes[] memory e = new bytes[](1);
        e[0] = transferExec(1 ether);
        vm.prank(agent);
        vm.expectRevert(AiKiDelegationManager.RedelegationUnsupported.selector);
        manager.redeemDelegations(c, m, e);
    }

    function test_OnlyTheNamedDelegateMayRedeem() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), transferExec(1 ether));
        vm.prank(stranger);
        vm.expectRevert(AiKiDelegationManager.NotDelegate.selector);
        manager.redeemDelegations(c, m, e);
    }

    /// @dev `args` sit outside the EIP-712 preimage and are chosen by the redeemer. The classic
    ///      ERC-7710 footgun is an enforcer that reads them; v1 refuses them entirely.
    function test_RejectsNonEmptyCaveatArgs() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        d.caveats[4].args = hex"00";
        d.signature = signAs(OWNER_PK, d);
        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), transferExec(1 ether));
        vm.prank(agent);
        vm.expectRevert(AiKiDelegationManager.ArgsNotEmpty.selector);
        manager.redeemDelegations(c, m, e);
    }

    function test_RejectsDuplicateEnforcers() public {
        AmountSite[] memory sites = siteFor(address(token), TRANSFER_SELECTOR, address(token), 1);
        Caveat[] memory caveats = new Caveat[](3);
        caveats[0] = expiryCaveat(SOON);
        caveats[1] =
            Caveat({enforcer: address(sessionE), terms: capTerms(address(token), 100, sites), args: ""});
        caveats[2] =
            Caveat({enforcer: address(sessionE), terms: capTerms(address(token), 50, sites), args: ""});
        Delegation memory d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);

        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), transferExec(10));
        vm.prank(agent);
        vm.expectRevert(AiKiDelegationManager.DuplicateEnforcer.selector);
        manager.redeemDelegations(c, m, e);
    }

    function test_RequiresAnExpiryCaveatAtIndexZero() public {
        Caveat[] memory caveats = new Caveat[](1);
        caveats[0] =
            Caveat({enforcer: address(targetsE), terms: packAddresses(one(address(token))), args: ""});
        Delegation memory d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);

        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), transferExec(1));
        vm.prank(agent);
        vm.expectRevert(AiKiDelegationManager.MissingExpiryCaveat.selector);
        manager.redeemDelegations(c, m, e);
    }

    /// @dev `Action` has no `value` field, so a redemption carrying native BNB is scored by
    ///      evaluatePolicy as amount 0 and allowed by every cap.
    function test_RejectsNativeValue() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        bytes memory exec =
            execOf(address(token), 1 ether, abi.encodeWithSelector(TRANSFER_SELECTOR, recipient, uint256(1)));
        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), exec);
        vm.prank(agent);
        vm.expectRevert(AiKiDelegationManager.NativeValueNotSupported.selector);
        manager.redeemDelegations(c, m, e);
    }

    function test_RejectsForbiddenTargets() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        address[3] memory forbidden = [address(account), address(manager), address(expiryE)];
        for (uint256 i; i < 3; ++i) {
            bytes memory exec =
                execOf(forbidden[i], 0, abi.encodeWithSelector(TRANSFER_SELECTOR, recipient, uint256(1)));
            (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), exec);
            vm.prank(agent);
            vm.expectRevert(AiKiDelegationManager.ForbiddenTarget.selector);
            manager.redeemDelegations(c, m, e);
        }
    }

    /// @dev 1-to-3 byte calldata right-pads into a valid-looking bytes4 and reaches the
    ///      target's fallback.
    function test_RejectsShortCallData() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        bytes memory exec = execOf(address(token), 0, hex"a905");
        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), exec);
        vm.prank(agent);
        vm.expectRevert(ExecutionLib.ShortCallData.selector);
        manager.redeemDelegations(c, m, e);
    }

    function test_RejectsEnforcerWithNoCode() public {
        Caveat[] memory caveats = new Caveat[](2);
        caveats[0] = expiryCaveat(SOON);
        caveats[1] = Caveat({enforcer: stranger, terms: "", args: ""});
        Delegation memory d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);

        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), transferExec(1));
        vm.prank(agent);
        vm.expectRevert(AiKiDelegationManager.EnforcerHasNoCode.selector);
        manager.redeemDelegations(c, m, e);
    }

    function test_RejectsOversizedCaveatArray() public {
        Caveat[] memory caveats = new Caveat[](Constants.MAX_CAVEATS + 1);
        for (uint256 i; i < caveats.length; ++i) {
            caveats[i] = expiryCaveat(SOON);
        }
        Delegation memory d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);

        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), transferExec(1));
        vm.prank(agent);
        vm.expectRevert(AiKiDelegationManager.TooManyCaveats.selector);
        manager.redeemDelegations(c, m, e);
    }

    // ------------------------------------------------------------------ signatures

    /// @dev THE highest-severity bug available in this architecture: if the manager took the
    ///      caveats from the redeemer without re-deriving the signed hash from them, the agent
    ///      would simply omit the cap enforcers.
    function test_TamperingWithACaveatInvalidatesTheSignature() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        AmountSite[] memory sites = siteFor(address(token), TRANSFER_SELECTOR, address(token), 1);
        // Raise the per-action cap after signing.
        d.caveats[4].terms = capTerms(address(token), 1_000_000 ether, sites);

        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) =
            prep(d, bytes32(0), transferExec(1000 ether));
        vm.prank(agent);
        vm.expectRevert(SignatureLib.InvalidSignature.selector);
        manager.redeemDelegations(c, m, e);
    }

    function test_DroppingACaveatInvalidatesTheSignature() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        Caveat[] memory fewer = new Caveat[](2);
        fewer[0] = d.caveats[0];
        fewer[1] = d.caveats[1];
        d.caveats = fewer; // signature still the one over six caveats

        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) =
            prep(d, bytes32(0), transferExec(1000 ether));
        vm.prank(agent);
        vm.expectRevert(SignatureLib.InvalidSignature.selector);
        manager.redeemDelegations(c, m, e);
    }

    function test_RejectsSignatureFromTheWrongKey() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        d.signature = signAs(STRANGER_PK, d);
        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), transferExec(1));
        vm.prank(agent);
        vm.expectRevert(SignatureLib.InvalidSignature.selector);
        manager.redeemDelegations(c, m, e);
    }

    /// @dev A flipped-s copy of a valid signature is a second valid signature unless EIP-2
    ///      low-s is enforced -- and a second valid signature over the same delegation is a
    ///      second delegationHash, hence a fresh session counter, hence unbounded spend.
    function test_RejectsMalleableSignature() public {
        uint256 N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

        // Direct ECDSA path: a bare EOA delegator. The manager itself rejects the high-s copy.
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        d.delegator = vm.addr(OWNER_PK);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digestOf(d));
        bytes memory flipped = abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        d.signature = flipped;

        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), transferExec(1));
        vm.prank(agent);
        vm.expectRevert(SignatureLib.MalleableSignature.selector);
        manager.redeemDelegations(c, m, e);

        // ERC-1271 path: the same flipped signature presented to the contract account. The
        // account applies the identical low-s rule internally and simply declines, so the
        // manager sees a refusal rather than a malleability error. Either way it is rejected --
        // the point is that a second valid signature over one delegation must not exist,
        // because that would be a second delegationHash and a fresh session-cap counter.
        Delegation memory viaAccount = standardMandate(250 ether, 500 ether, SOON);
        (v, r, s) = vm.sign(OWNER_PK, digestOf(viaAccount));
        viaAccount.signature = abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        (c, m, e) = prep(viaAccount, bytes32(0), transferExec(1));
        vm.prank(agent);
        vm.expectRevert(SignatureLib.InvalidSignature.selector);
        manager.redeemDelegations(c, m, e);
    }

    function test_PlainEoaDelegatorUsesEcdsa() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        d.delegator = vm.addr(OWNER_PK); // bare EOA, no code
        d.signature = signAs(OWNER_PK, d);
        vm.prank(agent);
        (bool allow,,) = manager.dryRun(d, bytes32(0), transferExec(1));
        assertTrue(allow, "an EOA delegator authorises through ECDSA");
    }

    function test_ContractAccountUsesErc1271WithNoEcdsaFallback() public {
        PermissiveSigner permissive = new PermissiveSigner();
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        d.delegator = address(permissive);
        d.signature = hex"00"; // a contract account decides for itself
        vm.prank(agent);
        (bool allow,,) = manager.dryRun(d, bytes32(0), transferExec(1));
        assertTrue(allow, "ERC-1271 account accepted its own signature");

        // A genuine contract account that says no is not second-guessed: there is no ECDSA
        // fallback, because one would defeat account-level key rotation.
        MockERC20 notASigner = new MockERC20();
        d.delegator = address(notASigner);
        d.signature = signAs(OWNER_PK, d);
        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), transferExec(1));
        vm.prank(agent);
        vm.expectRevert(SignatureLib.InvalidSignature.selector);
        manager.redeemDelegations(c, m, e);
    }

    /// @dev A hostile account can return megabytes from `isValidSignature`. The manager's
    ///      staticcall copies at most 32 bytes and demands exactly 32 back.
    function test_Erc1271ReturnBombIsRejected() public {
        HostileSigner hostile = new HostileSigner();
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        d.delegator = address(hostile);
        d.signature = signAs(OWNER_PK, d);
        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), transferExec(1));
        vm.prank(agent);
        vm.expectRevert(SignatureLib.InvalidSignature.selector);
        manager.redeemDelegations(c, m, e);
    }

    /// @dev EIP-7702 has been live on BNB Chain since Pascal. A delegated EOA carries exactly
    ///      23 bytes of code, `0xef0100 || implementation`. Its key remains the account's
    ///      ultimate authority, so ECDSA is the correct fallback there and ONLY there.
    function test_Eip7702DesignatorFallsBackToEcdsa() public {
        address delegated = vm.addr(OWNER_PK);
        vm.etch(delegated, abi.encodePacked(hex"ef0100", bytes20(address(account))));
        assertEq(delegated.code.length, 23, "designator is 23 bytes");

        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        d.delegator = delegated;
        d.signature = signAs(OWNER_PK, d);
        vm.prank(agent);
        (bool allow,,) = manager.dryRun(d, bytes32(0), transferExec(1));
        assertTrue(allow, "7702-delegated EOA authorises through its own key");
    }

    function test_SignatureIsBoundToChainId() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        vm.chainId(97); // BNB testnet
        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), transferExec(1));
        vm.prank(agent);
        vm.expectRevert(SignatureLib.InvalidSignature.selector);
        manager.redeemDelegations(c, m, e);
    }

    // ------------------------------------------------------------------ revocation

    function test_DisableDelegationIsImmediateAndOneWay() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        redeem(d, transferExec(1 ether));

        vm.prank(owner);
        vm.expectRevert(AiKiDelegationManager.NotDelegator.selector);
        manager.disableDelegation(d); // owner is not the delegator; the account is

        vm.prank(address(account));
        manager.disableDelegation(d);
        assertTrue(manager.isDisabled(manager.getDelegationHash(d)), "disabled");

        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(d, bytes32(0), transferExec(1 ether));
        vm.prank(agent);
        vm.expectRevert(AiKiDelegationManager.DelegationRevoked.selector);
        manager.redeemDelegations(c, m, e);
    }

    /// @dev The user with no BNB is precisely the one whose agent has gone wrong.
    function test_GaslessRevocationThroughARelayer() public {
        Delegation memory d = standardMandate(250 ether, 500 ether, SOON);
        d.delegator = vm.addr(OWNER_PK);
        d.signature = signAs(OWNER_PK, d);
        bytes32 h = manager.getDelegationHash(d);

        bytes32 structHash = keccak256(abi.encode(EncoderLib.REVOKE_TYPEHASH, h, uint256(0)));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(OWNER_PK, EncoderLib.toDigest(manager.domainSeparator(), structHash));
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(stranger); // any relayer
        manager.disableDelegationWithSig(h, vm.addr(OWNER_PK), 0, sig);
        assertTrue(manager.isDisabled(h), "revoked through a relayer");

        // The same signature cannot be replayed: the nonce advanced.
        vm.prank(stranger);
        vm.expectRevert(AiKiDelegationManager.InvalidRevokeNonce.selector);
        manager.disableDelegationWithSig(h, vm.addr(OWNER_PK), 0, sig);
    }

    function test_BumpEpochKillsEveryOutstandingMandate() public {
        Delegation memory a = standardMandate(250 ether, 500 ether, SOON);
        Delegation memory b = standardMandate(250 ether, 500 ether, SOON);
        b.salt = 7;
        b.signature = signAs(OWNER_PK, b);

        redeem(a, transferExec(1 ether));
        redeem(b, transferExec(1 ether));

        vm.prank(address(account));
        assertEq(manager.bumpEpoch(), 1, "epoch advanced");

        (bytes[] memory c, bytes32[] memory m, bytes[] memory e) = prep(a, bytes32(0), transferExec(1 ether));
        vm.prank(agent);
        vm.expectRevert(AiKiDelegationManager.StaleEpoch.selector);
        manager.redeemDelegations(c, m, e);

        (c, m, e) = prep(b, bytes32(0), transferExec(1 ether));
        vm.prank(agent);
        vm.expectRevert(AiKiDelegationManager.StaleEpoch.selector);
        manager.redeemDelegations(c, m, e);
    }

    // ------------------------------------------------------------------ account and registry

    function test_AccountRejectsExecutionFromAnyoneButTheManager() public {
        vm.prank(stranger);
        vm.expectRevert(AiKiMandateAccount.NotDelegationManager.selector);
        account.executeFromExecutor(bytes32(0), transferExec(1));
    }

    /// @dev The account re-checks the mode independently of the manager. One bug that lets a
    ///      DELEGATECALL through would let the target rewrite `owner` outright.
    function test_AccountRejectsNonSingleCallModeIndependently() public {
        vm.prank(address(manager));
        vm.expectRevert(AiKiMandateAccount.UnsupportedMode.selector);
        account.executeFromExecutor(bytes32(uint256(0xff) << 248), transferExec(1));
    }

    function test_OwnerCanAlwaysWithdraw() public {
        vm.prank(owner);
        account.withdrawERC20(address(token), owner, 10 ether);
        assertEq(token.balanceOf(owner), 10 ether, "owner escape hatch works");
    }

    /// @dev A lookalike enforcer that returns without checking anything renders as T0 and
    ///      enforces nothing. The registry is what the UI must resolve `enforcedBy` against.
    function test_RegistryIdentifiesGenuineEnforcersOnly() public {
        assertTrue(registry.isRegistered(address(perActionE)), "real enforcer is registered");
        assertEq(registry.addressOf("SessionTotalCapEnforcer"), address(sessionE), "name resolves to address");
        assertEq(registry.nameOf(address(expiryE)), "ExpiryEnforcer", "address resolves to name");

        NoopEnforcer lookalike = new NoopEnforcer();
        assertFalse(registry.isRegistered(address(lookalike)), "a lookalike is not registered");
        // Note what this does NOT do: the manager will happily run a lookalike enforcer if the
        // user signed it. The registry is the check the COMPILER and the UI must perform.
        assertEq(registry.count(), 6, "six enforcers, one per enforceable constraint kind");
    }

    /// @dev `condition` is an off-chain trigger by nature. There is no enforcer for it, there
    ///      never will be, and a mandate containing one cannot be T0.
    function test_NoEnforcerExistsForTheConditionKind() public view {
        assertEq(registry.addressOf("ConditionEnforcer"), address(0), "condition is out of scope");
    }
}
