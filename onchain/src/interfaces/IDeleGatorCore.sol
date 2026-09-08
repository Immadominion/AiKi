// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The execution surface the delegation manager calls back into on the delegator
///         account. ERC-7579 executor shape.
interface IDeleGatorCore {
    function executeFromExecutor(bytes32 mode, bytes calldata executionCallData)
        external
        payable
        returns (bytes[] memory returnData);
}
