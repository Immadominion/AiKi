// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "./MockERC20.sol";
import {AiKiDelegationManager} from "../../src/core/AiKiDelegationManager.sol";
import {Delegation} from "../../src/core/Types.sol";

/// @notice A protocol-shaped target: the caller's tokens move via an internal transferFrom,
///         so the moved asset appears nowhere in the top-level calldata. This is the Venus
///         `repayBorrow` shape that defeats naive calldata decoding.
contract MockProtocol {
    MockERC20 public immutable TOKEN;
    /// @dev Fraction of the pulled amount handed straight back, in basis points. A round-trip
    ///      is what makes a net balance delta understate the gross spend.
    uint256 public refundBps;

    constructor(MockERC20 token) {
        TOKEN = token;
    }

    function setRefundBps(uint256 bps) external {
        refundBps = bps;
    }

    function repayBorrow(uint256 amount) external {
        TOKEN.transferFrom(msg.sender, address(this), amount);
        uint256 refund = (amount * refundBps) / 10_000;
        if (refund != 0) TOKEN.transfer(msg.sender, refund);
    }

    /// @dev No amount anywhere in the calldata. A cap enforcer must refuse to price this.
    function harvest() external {}

    /// @dev A universal forwarder: one allowlisted selector, arbitrary inner calls.
    function forward(address to, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = to.call(data);
        require(ok, "forward failed");
        return ret;
    }
}

/// @notice Calls back into the manager during the execution, with the same delegation.
contract ReentrantTarget {
    AiKiDelegationManager public immutable MANAGER;
    bytes public context;
    bytes public exec;
    bool public armed;

    constructor(AiKiDelegationManager manager) {
        MANAGER = manager;
    }

    function arm(bytes calldata context_, bytes calldata exec_) external {
        context = context_;
        exec = exec_;
        armed = true;
    }

    function poke(uint256) external {
        if (!armed) return;
        armed = false;
        bytes[] memory contexts = new bytes[](1);
        contexts[0] = context;
        bytes32[] memory modes = new bytes32[](1);
        bytes[] memory execs = new bytes[](1);
        execs[0] = exec;
        MANAGER.redeemDelegations(contexts, modes, execs);
    }
}

/// @notice An ERC-1271 that returns a giant blob and burns gas, to prove the manager's
///         staticcall is bounded and cannot be return-bombed.
contract HostileSigner {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes memory) {
        bytes memory bomb = new bytes(200_000);
        return bomb;
    }
}

/// @notice An ERC-1271 that accepts everything. Used to show that a genuine contract account
///         controls its own authorization, and that there is no ECDSA fallback for it.
contract PermissiveSigner {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}

/// @notice An enforcer that always allows. Stands in for the lookalike address a user could be
///         socially engineered into signing, which is what the registry exists to catch.
contract NoopEnforcer {
    function beforeHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address)
        external {}
    function afterHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address)
        external {}
}

/// @notice A token whose balanceOf reverts with the dry-run success sentinel.
///
/// @dev The stateful enforcers call balanceOf on the asset during beforeHook, and the asset is
///      just an address in the signed terms. If the manager's dry run treats a bare
///      DryRunAllowed selector as proof that the hooks completed, then any contract reached
///      during a hook can emit those four bytes and forge an ALLOW that the real redemption
///      would never give. That breaks the invariant the API relies on: the answer it gets from
///      dryRun is supposed to be the answer the chain gives.
contract SentinelForgingERC20 {
    error DryRunAllowed();

    string public name = "Forger";
    uint8 public constant decimals = 18;

    function balanceOf(address) external pure returns (uint256) {
        revert DryRunAllowed();
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert DryRunAllowed();
    }
}
