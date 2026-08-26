// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Delegation} from "../core/Types.sol";

interface IDelegationManager {
    function redeemDelegations(
        bytes[] calldata permissionContexts,
        bytes32[] calldata modes,
        bytes[] calldata executionCallDatas
    ) external;

    function dryRun(Delegation calldata delegation, bytes32 mode, bytes calldata executionCallData)
        external
        returns (bool allow, string memory rule, string memory reason);

    function disableDelegation(Delegation calldata delegation) external;

    function bumpEpoch() external returns (uint256);

    function isDisabled(bytes32 delegationHash) external view returns (bool);

    function epochOf(address delegator) external view returns (uint256);

    function getDelegationHash(Delegation calldata delegation) external pure returns (bytes32);
}
