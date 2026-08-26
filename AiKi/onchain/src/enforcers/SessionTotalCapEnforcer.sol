// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StatefulCaveatEnforcerBase} from "../core/StatefulCaveatEnforcerBase.sol";
import {CapTermsLib} from "../core/CapTermsLib.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {PolicyDenied, Rules, Reasons} from "../core/Errors.sol";

/// @notice `session_total_cap`. terms = abi.encode(address asset, uint256 cap, AmountSite[] sites).
///         The only stateful policy in the suite: it tracks cumulative spend on chain.
/// @dev Boundary copied from policy.ts line 66: denial is `spent + action.amount > cap`, so
///      equality is ALLOWED. The check is PROSPECTIVE -- `spent + amount <= cap` is tested
///      BEFORE the execution and the counter is incremented there, not after. Two consequences,
///      both wanted: a reverting execution automatically un-counts (the whole transaction
///      reverts), and a reentrant redemption sees the already-incremented figure.
///
///      THE SESSION IS THE DELEGATION. Off chain `spent` is per-session; on chain it can only
///      be per-delegationHash. Two delegations compiled from one policy get two independent
///      budgets, i.e. twice the cap. The API must mint exactly one delegation per session and
///      treat `delegationHash` as the session identity.
///
///      Re-signing with the same salt and epoch reproduces the same hash and RESUMES the old
///      counter; a fresh salt starts a fresh budget. Both are silent. The API must mint a new
///      256-bit salt per authorization and surface to the user that renewing a mandate resets
///      the lifetime cap.
///
///      KNOWN DIVERGENCE: off chain, `spent` is a single scalar and `action.amount` is added to
///      it regardless of `action.asset` -- so a mandate scoped to {USDT, BNB} adds 18-decimal
///      USDT units to wei as if they were one quantity. There is no faithful on-chain mirror of
///      that, and the single-scalar behaviour is itself wrong. This enforcer is per-token: the
///      cap is denominated in one asset's base units and a call moving any other token is
///      denied. A multi-asset session cap needs a price oracle, which imports oracle
///      manipulation; do not build one, downgrade the tier instead.
contract SessionTotalCapEnforcer is StatefulCaveatEnforcerBase {
    error NoSnapshot();
    error SnapshotAlreadyHeld();

    struct Snapshot {
        address asset;
        uint256 balanceBefore;
        uint256 declared;
        bool active;
    }

    mapping(address => mapping(bytes32 => uint256)) private _spent;
    mapping(address => mapping(bytes32 => Snapshot)) private _snapshots;

    event SessionSpend(
        address indexed manager, bytes32 indexed delegationHash, uint256 charged, uint256 newSpent
    );

    constructor(address delegationManager_) StatefulCaveatEnforcerBase(delegationManager_) {}

    /// @notice The counter that actually stops a transaction.
    /// @dev This is the number the UI must render next to a T0 badge. The API's own counter
    ///      drifts: it charges the declared amount at attempt time even when the transaction
    ///      later reverts, and the agent holds a valid delegation and can redeem without ever
    ///      touching AiKi's relay. Two counters that disagree is worse than one that is
    ///      occasionally stale.
    function spentOf(address manager, bytes32 delegationHash) external view returns (uint256) {
        return _spent[manager][delegationHash];
    }

    function remainingOf(address manager, bytes32 delegationHash, uint256 cap)
        external
        view
        returns (uint256)
    {
        uint256 used = _spent[manager][delegationHash];
        return cap > used ? cap - used : 0;
    }

    function beforeHook(
        bytes calldata terms,
        bytes calldata args,
        bytes32 mode,
        bytes calldata executionCallData,
        bytes32 delegationHash,
        address delegator,
        address
    ) external override noArgs(args) singleCallMode(mode) {
        (address asset, uint256 cap, uint256 declared) =
            CapTermsLib.declaredAmount(terms, executionCallData, Rules.SESSION_TOTAL_CAP);

        uint256 used = _spent[msg.sender][delegationHash];
        // Off chain `spent + action.amount` is BigInt arithmetic and never overflows; here it
        // can. A checked addition would revert with an arithmetic panic instead of the
        // session_total_cap rule, so the two evaluators would disagree on WHY they denied even
        // though both denied. Detect the wrap explicitly and report the right rule.
        uint256 total;
        unchecked {
            total = used + declared;
        }
        if (total < used || total > cap) {
            revert PolicyDenied(Rules.SESSION_TOTAL_CAP, Reasons.OVER_SESSION_CAP);
        }
        _spent[msg.sender][delegationHash] = total;

        Snapshot storage snap = _snapshots[msg.sender][delegationHash];
        if (snap.active) revert SnapshotAlreadyHeld();
        snap.asset = asset;
        snap.balanceBefore = IERC20(asset).balanceOf(delegator);
        snap.declared = declared;
        snap.active = true;
    }

    function afterHook(
        bytes calldata terms,
        bytes calldata args,
        bytes32 mode,
        bytes calldata,
        bytes32 delegationHash,
        address delegator,
        address
    ) external override onlyManager noArgs(args) singleCallMode(mode) {
        Snapshot memory snap = _snapshots[msg.sender][delegationHash];
        if (!snap.active) revert NoSnapshot();
        delete _snapshots[msg.sender][delegationHash];

        uint256 cap = CapTermsLib.capOf(terms);

        uint256 balanceAfter = IERC20(snap.asset).balanceOf(delegator);
        uint256 realised = snap.balanceBefore > balanceAfter ? snap.balanceBefore - balanceAfter : 0;

        uint256 used = _spent[msg.sender][delegationHash];
        if (realised > snap.declared) {
            // The execution moved more than it declared. Charge the difference and re-check.
            uint256 extra = realised - snap.declared;
            uint256 total;
            unchecked {
                total = used + extra;
            }
            if (total < used || total > cap) {
                revert PolicyDenied(Rules.SESSION_TOTAL_CAP, Reasons.OVER_SESSION_CAP);
            }
            used = total;
            _spent[msg.sender][delegationHash] = used;
        }

        emit SessionSpend(
            msg.sender, delegationHash, realised < snap.declared ? realised : snap.declared, used
        );
    }

    function name() external pure override returns (string memory) {
        return "SessionTotalCapEnforcer";
    }

    function constraintKind() external pure override returns (string memory) {
        return "session_total_cap";
    }
}
