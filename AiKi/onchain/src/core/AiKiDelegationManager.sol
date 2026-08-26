// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Caveat, Constants, Delegation} from "./Types.sol";
import {EncoderLib} from "./EncoderLib.sol";
import {ExecutionLib} from "./ExecutionLib.sol";
import {SignatureLib} from "./SignatureLib.sol";
import {PolicyDenied, Rules, Reasons} from "./Errors.sol";
import {ICaveatEnforcer} from "../interfaces/ICaveatEnforcer.sol";
import {IDeleGatorCore} from "../interfaces/IDeleGatorCore.sol";
import {IDelegationManager} from "../interfaces/IDelegationManager.sol";

/// @title AiKiDelegationManager
/// @notice The only trusted stateful contract in the suite. It authenticates a signed
///         delegation, enforces the structural invariants the off-chain `Action` type cannot
///         express, runs every caveat, and performs the execution through the delegator
///         account.
///
/// @dev NON-UPGRADEABLE, OWNERLESS, NON-PAUSABLE, no `delegatecall`, no `selfdestruct`. This is
///      not a stylistic preference. An owner-upgradeable manager means a key AiKi holds can
///      rewrite the rule after the user signed it, and the honest tier for every caveat behind
///      it is T1, not T0. Migration is a fresh deployment plus fresh signatures, never an
///      upgrade.
///
///      The manager holds NO policy logic of its own. Policy lives entirely in enforcers, so a
///      mandate is a value the user signs rather than code the manager decides.
contract AiKiDelegationManager is IDelegationManager {
    // --- structural rejections, each with its own error so a failure is legible ---
    error LengthMismatch();
    error UnsupportedMode();
    error RedelegationUnsupported();
    error NotDelegate();
    error ZeroDelegate();
    error ArgsNotEmpty();
    error DuplicateEnforcer();
    error MissingExpiryCaveat();
    error NoCaveats();
    error TooManyCaveats();
    error EnforcerHasNoCode();
    error DelegationRevoked();
    error StaleEpoch();
    error NativeValueNotSupported();
    error ForbiddenTarget();
    error Reentrancy();
    error NotDelegator();
    error InvalidRevokeNonce();
    error OnlySelf();

    /// @dev Sentinel thrown by the dry-run probe when every check passed. It is a revert so
    ///      that the probe's state writes (the session-cap increment) are rolled back.
    error DryRunAllowed();

    event RedeemedDelegation(
        address indexed delegator,
        address indexed redeemer,
        bytes32 indexed delegationHash,
        address target,
        bytes4 selector
    );
    event DelegationDisabled(bytes32 indexed delegationHash, address indexed delegator);
    event EpochBumped(address indexed delegator, uint256 epoch);

    string public constant NAME = "AiKi Delegation";
    string public constant VERSION = "1";

    /// @dev Every delegation must carry this enforcer at caveat index 0. See `_validate`.
    address public immutable EXPIRY_ENFORCER;

    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;

    mapping(bytes32 => bool) public isDisabled;
    mapping(address => uint256) public epochOf;
    /// @notice Per-delegator nonce for gasless revocation.
    mapping(address => uint256) public revokeNonce;

    uint256 private _entered = 1;

    constructor(address expiryEnforcer) {
        if (expiryEnforcer == address(0) || expiryEnforcer.code.length == 0) revert EnforcerHasNoCode();
        EXPIRY_ENFORCER = expiryEnforcer;
        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = EncoderLib.domainSeparator(NAME, VERSION, address(this));
    }

    /// @dev Plain storage guard, not EIP-1153 transient storage: whether TSTORE/TLOAD are live
    ///      on chain 56 is not verified in this repository, and an unverified assumption is not
    ///      something to build a reentrancy guard on.
    modifier nonReentrant() {
        if (_entered != 1) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    // ---------------------------------------------------------------- domain / hashing

    /// @dev Recomputed whenever `block.chainid` differs from the cached value, so a chain split
    ///      cannot resurrect signatures.
    function domainSeparator() public view returns (bytes32) {
        if (block.chainid == _CACHED_CHAIN_ID) return _CACHED_DOMAIN_SEPARATOR;
        return EncoderLib.domainSeparator(NAME, VERSION, address(this));
    }

    function getDelegationHash(Delegation calldata delegation) external pure returns (bytes32) {
        return EncoderLib.hashDelegation(delegation);
    }

    function getDelegationDigest(Delegation calldata delegation) external view returns (bytes32) {
        return EncoderLib.toDigest(domainSeparator(), EncoderLib.hashDelegation(delegation));
    }

    // ---------------------------------------------------------------- redemption

    function redeemDelegations(
        bytes[] calldata permissionContexts,
        bytes32[] calldata modes,
        bytes[] calldata executionCallDatas
    ) external nonReentrant {
        uint256 n = permissionContexts.length;
        for (uint256 i; i < n; ++i) {
            _redeem(permissionContexts[i], modes[i], executionCallDatas[i], msg.sender);
        }
    }

    function _redeem(bytes calldata context, bytes32 mode, bytes calldata exec, address redeemer) private {
        Delegation[] memory delegations = abi.decode(context, (Delegation[]));
        // A redelegation chain has no off-chain analogue: a sub-delegation's effective policy
        // is the intersection of two constraint sets, which CompiledPolicy cannot express, and
        // a leaf delegation is the cleanest route an agent has to a fresh session counter.
        if (delegations.length != 1) revert RedelegationUnsupported();
        Delegation memory d = delegations[0];

        HookContext memory ctx = HookContext({
            mode: mode,
            delegationHash: _authenticate(d, mode, exec, redeemer),
            delegator: d.delegator,
            redeemer: redeemer
        });

        _runHooks(d.caveats, ctx, exec, true);

        // No try/catch. A swallowed revert would let an afterHook commit spend on a failed
        // execution, and would let a non-reverting ERC-20 that returned false look successful.
        IDeleGatorCore(d.delegator).executeFromExecutor(mode, exec);

        // Forward order, deliberately NOT the reference framework's reverse nesting. Our parity
        // target is evaluatePolicy's "first constraint in array order wins" reporting; reverse
        // iteration would report the last constraint first. The afterHooks in this suite are
        // mutually independent, each with its own snapshot, so order does not affect
        // correctness -- only which rule a user sees first.
        _runHooks(d.caveats, ctx, exec, false);

        (address target,, bytes calldata callData) = ExecutionLib.decode(exec);
        (bytes4 selector,) = ExecutionLib.selectorOf(callData);
        emit RedeemedDelegation(d.delegator, redeemer, ctx.delegationHash, target, selector);
    }

    /// @dev Hook fan-out is packed into a memory struct rather than passed as loose
    ///      parameters; the flat version does not fit in the EVM stack.
    struct HookContext {
        bytes32 mode;
        bytes32 delegationHash;
        address delegator;
        address redeemer;
    }

    function _runHooks(Caveat[] memory caveats, HookContext memory ctx, bytes calldata exec, bool before)
        private
    {
        uint256 n = caveats.length;
        for (uint256 i; i < n; ++i) {
            Caveat memory c = caveats[i];
            if (before) {
                ICaveatEnforcer(c.enforcer)
                    .beforeHook(
                        c.terms, c.args, ctx.mode, exec, ctx.delegationHash, ctx.delegator, ctx.redeemer
                    );
            } else {
                ICaveatEnforcer(c.enforcer)
                    .afterHook(
                        c.terms, c.args, ctx.mode, exec, ctx.delegationHash, ctx.delegator, ctx.redeemer
                    );
            }
        }
    }

    function _authenticate(Delegation memory d, bytes32 mode, bytes calldata exec, address redeemer)
        private
        view
        returns (bytes32 delegationHash)
    {
        _validate(d, mode, exec, redeemer);
        delegationHash = EncoderLib.hashDelegation(d);
        if (isDisabled[delegationHash]) revert DelegationRevoked();
        if (d.epoch != epochOf[d.delegator]) revert StaleEpoch();
        // The EIP-712 preimage covers the FULL caveat array, every enforcer address and every
        // terms blob. An agent that removes or swaps a caveat produces a different hash and an
        // invalid signature. This is the single highest-severity bug available in this
        // architecture and it is closed here.
        SignatureLib.check(d.delegator, EncoderLib.toDigest(domainSeparator(), delegationHash), d.signature);
    }

    /// @dev Every structural invariant the off-chain `Action` tuple cannot express. All of them
    ///      live HERE rather than in optional caveats: a caveat a compiler forgets to emit is a
    ///      T0 badge over an unguarded chain.
    function _validate(Delegation memory d, bytes32 mode, bytes calldata exec, address redeemer)
        private
        view
    {
        // Single call, revert-on-failure. Batch would let an agent make N transfers each at the
        // per-action cap inside one redemption that the mirror scored as a single Action;
        // DELEGATECALL runs attacker code in the account's own storage context and voids every
        // caveat; TRY leaves a reverting inner call inside a successful transaction, so a
        // balance-delta afterHook measures a zero delta.
        if (mode != Constants.MODE_SINGLE_DEFAULT) revert UnsupportedMode();

        if (d.authority != Constants.ROOT_AUTHORITY) revert RedelegationUnsupported();
        if (d.delegate == address(0)) revert ZeroDelegate();
        // Never tx.origin. The signed delegate is the only party who may redeem.
        if (d.delegate != redeemer) revert NotDelegate();

        uint256 n = d.caveats.length;
        if (n == 0) revert NoCaveats();
        if (n > Constants.MAX_CAVEATS) revert TooManyCaveats();

        // A delegation is INTENTIONALLY reusable -- that is what a session is -- so there is no
        // nonce, and the only bounds on reuse are expiry, the session cap and revocation.
        // compilePolicy treats expiry as optional; the chain does not. Refusing to enforce an
        // unbounded standing authorization is the safe direction to diverge. An intentionally
        // unbounded mandate must sign a far-future expiry explicitly rather than omit one.
        if (d.caveats[0].enforcer != EXPIRY_ENFORCER) revert MissingExpiryCaveat();

        (address target, uint256 value,) = ExecutionLib.decode(exec);

        // `Action` has no `value` field, so a redemption carrying native BNB is scored by
        // evaluatePolicy as amount 0 and allowed by every cap. The absence of a field is a
        // hole, not a permission. v1 refuses native value outright rather than enforcing
        // something with no off-chain representation.
        if (value != 0) revert NativeValueNotSupported();

        // Targeting the account itself would let the agent call addOwner/execute/
        // setFallbackHandler on the very account the caveats protect, converting a bounded
        // mandate into permanent full control. Targeting the manager or an enforcer would let
        // it reach this contract's own state.
        if (target == address(0) || target == d.delegator || target == address(this)) {
            revert ForbiddenTarget();
        }

        for (uint256 i; i < n; ++i) {
            address enforcer = d.caveats[i].enforcer;
            if (enforcer.code.length == 0) revert EnforcerHasNoCode();
            if (target == enforcer) revert ForbiddenTarget();
            // `args` sit outside the EIP-712 preimage and are attacker-chosen at redemption
            // time. Requiring them empty removes the entire "enforcer trusts redeemer-supplied
            // args" class rather than leaving it to enforcer discipline.
            if (d.caveats[i].args.length != 0) revert ArgsNotEmpty();
            // Stateful enforcers double-count under duplication while evaluatePolicy shares one
            // counter across duplicate constraints of the same kind. Deny by construction.
            for (uint256 j = i + 1; j < n; ++j) {
                if (enforcer == d.caveats[j].enforcer) revert DuplicateEnforcer();
            }
        }
    }

    // ---------------------------------------------------------------- dry run

    /// @notice Run every pre-execution check and report the verdict instead of reverting.
    /// @dev Call via `eth_call`. It is declared non-view because the probe writes state, but
    ///      every write is rolled back by the sentinel revert, so it cannot change the chain.
    ///
    ///      This is what closes the gap the product's central claim depends on. The API should
    ///      eth_call this on every attempt alongside `evaluatePolicy` and alarm on any mismatch,
    ///      which turns "the API's answer is the chain's answer" from a design intention into a
    ///      monitored runtime invariant.
    ///
    ///      It covers beforeHooks only. The afterHook balance-delta backstop needs the
    ///      execution to have happened, and is strictly stricter than what is reported here.
    function dryRun(Delegation calldata delegation, bytes32 mode, bytes calldata executionCallData)
        external
        returns (bool allow, string memory rule, string memory reason)
    {
        try this.dryRunProbe(delegation, mode, executionCallData, msg.sender) {
            // Unreachable: the probe always reverts.
            return (false, "internal", "Dry-run probe did not revert.");
        } catch (bytes memory err) {
            return _decodeProbe(err);
        }
    }

    function dryRunProbe(
        Delegation calldata delegation,
        bytes32 mode,
        bytes calldata executionCallData,
        address redeemer
    ) external {
        if (msg.sender != address(this)) revert OnlySelf();
        HookContext memory ctx = HookContext({
            mode: mode,
            delegationHash: _authenticate(delegation, mode, executionCallData, redeemer),
            delegator: delegation.delegator,
            redeemer: redeemer
        });
        _runHooks(delegation.caveats, ctx, executionCallData, true);
        revert DryRunAllowed();
    }

    function _decodeProbe(bytes memory err)
        private
        pure
        returns (bool allow, string memory rule, string memory reason)
    {
        if (err.length < 4) return (false, "revert", "Redemption reverted without a reason.");
        bytes4 sel;
        assembly {
            sel := mload(add(err, 0x20))
        }
        if (sel == DryRunAllowed.selector) return (true, Rules.POLICY, Reasons.ALLOWED);
        if (sel == PolicyDenied.selector) {
            bytes memory payload = new bytes(err.length - 4);
            for (uint256 i; i < payload.length; ++i) {
                payload[i] = err[i + 4];
            }
            (string memory r, string memory why) = abi.decode(payload, (string, string));
            return (false, r, why);
        }
        return (false, Rules.STRUCTURE, "Redemption is structurally invalid.");
    }

    // ---------------------------------------------------------------- revocation

    /// @notice Revoke one delegation. One-way: there is deliberately no `enableDelegation`.
    /// @dev A re-enable path is a re-entry point for any agent that can induce a call into the
    ///      manager, and it does not match the API's terminal `status: 'revoked'`.
    function disableDelegation(Delegation calldata delegation) external {
        if (msg.sender != delegation.delegator) revert NotDelegator();
        bytes32 delegationHash = EncoderLib.hashDelegation(delegation);
        isDisabled[delegationHash] = true;
        emit DelegationDisabled(delegationHash, delegation.delegator);
    }

    /// @notice Revoke through a relayer, so a user holding no BNB can still revoke.
    /// @dev Without this, `revokePath.immediate: true` is a claim about the happy path only --
    ///      and the user with an empty gas balance is precisely the one whose agent has gone
    ///      wrong.
    function disableDelegationWithSig(
        bytes32 delegationHash,
        address delegator,
        uint256 nonce,
        bytes calldata signature
    ) external {
        if (nonce != revokeNonce[delegator]) revert InvalidRevokeNonce();
        bytes32 structHash = keccak256(abi.encode(EncoderLib.REVOKE_TYPEHASH, delegationHash, nonce));
        SignatureLib.check(delegator, EncoderLib.toDigest(domainSeparator(), structHash), signature);
        revokeNonce[delegator] = nonce + 1;
        isDisabled[delegationHash] = true;
        emit DelegationDisabled(delegationHash, delegator);
    }

    /// @notice Kill every outstanding mandate of the caller in one transaction.
    /// @dev `epoch` is inside the signed struct, so this needs no enumeration. Note that
    ///      re-authorizing after a bump produces a new delegationHash and therefore a FRESH
    ///      session-spend counter. That is semantically correct -- it is a new session -- and
    ///      it is invisible unless the UI says so.
    function bumpEpoch() external returns (uint256 epoch) {
        epoch = ++epochOf[msg.sender];
        emit EpochBumped(msg.sender, epoch);
    }
}
