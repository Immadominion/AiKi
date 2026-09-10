// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStrategyController {
    function owner() external view returns (address);
}

/// @notice Common authority boundary for separately funded strategy vaults.
/// @dev Existing mandate accounts stay unchanged. Only their current owner can
///      pause/recover; the controller is NOT accepted as an owner escape caller.
abstract contract StrategyVaultBase {
    struct CommonPolicy {
        uint64 expiresAt;
        uint32 minInterval;
        uint32 maxDeadlineDelay;
    }

    error InvalidController();
    error InvalidCommonPolicy();
    error NotStrategyOwner();
    error NotStrategyController();
    error StrategyPaused();
    error StrategyExpired();
    error StaleStrategyNonce();
    error InvalidStrategyDeadline();
    error StrategyCooldown();
    error StrategyReentrancy();
    error MissingStrategyGuard();

    address public immutable controller;
    bytes32 public immutable policyHash;
    uint64 public immutable expiresAt;
    uint32 public immutable minInterval;
    uint32 public immutable maxDeadlineDelay;
    uint256 public operationNonce;
    uint256 public lastExecutionAt;
    bool public paused = true;
    uint256 private _entered = 1;

    event StrategyExecuted(bytes32 indexed policyHash, uint256 indexed nonce, bytes32 indexed planHash);
    event StrategyPauseChanged(bool paused, uint256 nonce);
    event StrategyOwnerStateChanged(uint256 nonce);

    constructor(address controller_, bytes32 policyHash_, CommonPolicy memory common) {
        if (controller_.code.length == 0) revert InvalidController();
        try IStrategyController(controller_).owner() returns (address currentOwner) {
            if (currentOwner == address(0) || currentOwner == controller_) revert InvalidController();
        } catch {
            revert InvalidController();
        }
        if (
            policyHash_ == bytes32(0) || common.expiresAt <= block.timestamp || common.maxDeadlineDelay == 0
                || common.maxDeadlineDelay > 1 hours || common.minInterval > 30 days
        ) revert InvalidCommonPolicy();
        controller = controller_;
        policyHash = policyHash_;
        expiresAt = common.expiresAt;
        minInterval = common.minInterval;
        maxDeadlineDelay = common.maxDeadlineDelay;
    }

    modifier onlyOwner() {
        if (msg.sender != IStrategyController(controller).owner() || msg.sender == controller) {
            revert NotStrategyOwner();
        }
        _;
    }

    modifier nonReentrant() {
        if (_entered != 1) revert StrategyReentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    /// @notice Owner control remains callable after expiry and while paused.
    function pause() external onlyOwner nonReentrant {
        if (!paused) {
            paused = true;
            _invalidate();
            emit StrategyPauseChanged(true, operationNonce);
        }
    }

    /// @notice Funding alone never turns automation on.
    function resume() external onlyOwner nonReentrant {
        if (block.timestamp >= expiresAt) revert StrategyExpired();
        if (paused) {
            paused = false;
            _invalidate();
            emit StrategyPauseChanged(false, operationNonce);
        }
    }

    function strategyKind() external pure virtual returns (bytes32);
    function operationSelector() external pure virtual returns (bytes4);

    /// @dev Concrete operation entrypoints must hold nonReentrant before beginning.
    ///      State is reserved before external calls; a revert rolls it all back.
    function _begin(uint256 expectedNonce, uint256 deadline) internal {
        if (_entered != 2) revert MissingStrategyGuard();
        if (msg.sender != controller) revert NotStrategyController();
        if (paused) revert StrategyPaused();
        if (block.timestamp >= expiresAt) revert StrategyExpired();
        if (expectedNonce != operationNonce) revert StaleStrategyNonce();
        if (
            deadline < block.timestamp || deadline > expiresAt
                || deadline - block.timestamp > maxDeadlineDelay
        ) revert InvalidStrategyDeadline();
        if (lastExecutionAt != 0 && block.timestamp < lastExecutionAt + minInterval) {
            revert StrategyCooldown();
        }
        operationNonce++;
        lastExecutionAt = block.timestamp;
    }

    function _finish(bytes32 planHash) internal {
        if (_entered != 2 || planHash == bytes32(0)) revert MissingStrategyGuard();
        emit StrategyExecuted(policyHash, operationNonce, planHash);
    }

    /// @dev Owner funding/recovery invalidates any previously prepared operation.
    function _invalidate() internal {
        operationNonce++;
        emit StrategyOwnerStateChanged(operationNonce);
    }
}
