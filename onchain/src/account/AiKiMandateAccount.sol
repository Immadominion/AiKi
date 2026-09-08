// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Constants} from "../core/Types.sol";
import {ExecutionLib} from "../core/ExecutionLib.sol";
import {SignatureLib} from "../core/SignatureLib.sol";
import {IDeleGatorCore} from "../interfaces/IDeleGatorCore.sol";
import {IERC1271} from "../interfaces/IERC1271.sol";
import {IERC20} from "../interfaces/IERC20.sol";

/// @title AiKiMandateAccount
/// @notice The delegator: a minimal account that holds the working balance a mandate governs.
///
/// @dev WHY THIS EXISTS. T0 is a property of the delegator ACCOUNT, not of the caveat set. If
///      the agent's key is also an owner, a second 7579 executor, or a second delegation
///      manager on the same account, the caveats are decoration. This account's authority graph
///      is the whole point: it is auditable in a single file and has exactly two authorities.
///
///        1. `owner` -- the human. Can execute anything and withdraw at any time.
///        2. `DELEGATION_MANAGER` -- immutable, set at construction, the ONLY executor.
///
///      There is no module system, no fallback handler, no validator registry, and no way to
///      add a second executor. Anything else would be a side door that makes the T0 badge
///      meaningless regardless of which enforcers are attached.
///
///      It also needs no bundler and no paymaster: the agent sends an ordinary transaction to
///      the manager, so a user with a bare EOA can hold a chain-enforced mandate today.
///
///      ERC-1271 is implemented, because the delegator must be able to authorize its own
///      delegation and this account is a contract. It attests to exactly one thing: a digest
///      the OWNER's key signed. The agent cannot induce a signature through it, because the
///      agent does not hold the owner's key and there is no path that makes this account sign
///      anything on its own.
///
///      WHAT IT CANNOT STOP: EIP-2612 `permit` and EIP-3009 `transferWithAuthorization` move
///      value on a SIGNATURE, not a call, so no caveat enforcer ever runs. The owner must not
///      sign one for a token a mandate governs, and the agent key must never be the owner. That
///      is a property of key management, not something a caveat can enforce.
contract AiKiMandateAccount is IDeleGatorCore, IERC1271 {
    error NotOwner();
    error NotDelegationManager();
    error UnsupportedMode();
    error NativeValueNotSupported();
    error ZeroAddress();
    error ExecutionFailed(bytes returnData);

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event ExecutedFromExecutor(address indexed executor, address indexed target, bytes4 selector);

    address public immutable DELEGATION_MANAGER;
    address public owner;

    constructor(address owner_, address delegationManager_) {
        if (owner_ == address(0) || delegationManager_ == address(0)) revert ZeroAddress();
        owner = owner_;
        DELEGATION_MANAGER = delegationManager_;
        emit OwnerTransferred(address(0), owner_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    receive() external payable {}

    /// @inheritdoc IDeleGatorCore
    /// @dev The mode is re-checked HERE as well as in the manager. Two independent checks,
    ///      because a single bug that lets a DELEGATECALL through ends the product: the target
    ///      would run in this account's storage context and could rewrite `owner` outright.
    function executeFromExecutor(bytes32 mode, bytes calldata executionCallData)
        external
        payable
        returns (bytes[] memory returnData)
    {
        if (msg.sender != DELEGATION_MANAGER) revert NotDelegationManager();
        if (mode != Constants.MODE_SINGLE_DEFAULT) revert UnsupportedMode();

        (address target, uint256 value, bytes calldata callData) = ExecutionLib.decode(executionCallData);
        if (value != 0 || msg.value != 0) revert NativeValueNotSupported();

        (bool ok, bytes memory result) = target.call(callData);
        if (!ok) _bubble(result);

        (bytes4 selector,) = ExecutionLib.selectorOf(callData);
        emit ExecutedFromExecutor(msg.sender, target, selector);

        returnData = new bytes[](1);
        returnData[0] = result;
    }

    /// @inheritdoc IERC1271
    /// @dev Returns the magic value only for a digest the owner's key signed, under strict
    ///      ECDSA (low-s, canonical v, non-zero recovery). Returns 0xffffffff rather than
    ///      reverting on a malformed signature, so a caller cannot distinguish failure modes.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        address recovered;
        try this.recoverStrict(hash, signature) returns (address r) {
            recovered = r;
        } catch {
            return 0xffffffff;
        }
        return recovered == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    /// @dev External only so `isValidSignature` can try/catch it. Pure; touches no state.
    function recoverStrict(bytes32 hash, bytes calldata signature) external pure returns (address) {
        return SignatureLib.recoverStrict(hash, signature);
    }

    // ---------------------------------------------------------------- owner escape hatches

    function execute(address target, uint256 value, bytes calldata callData)
        external
        onlyOwner
        returns (bytes memory)
    {
        (bool ok, bytes memory result) = target.call{value: value}(callData);
        if (!ok) _bubble(result);
        return result;
    }

    function withdrawERC20(address token, address to, uint256 amount) external onlyOwner {
        if (!IERC20(token).transfer(to, amount)) revert ExecutionFailed("");
    }

    function withdrawNative(address payable to, uint256 amount) external onlyOwner {
        (bool ok, bytes memory result) = to.call{value: amount}("");
        if (!ok) _bubble(result);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    function _bubble(bytes memory result) private pure {
        if (result.length == 0) revert ExecutionFailed("");
        assembly {
            revert(add(result, 0x20), mload(result))
        }
    }
}
