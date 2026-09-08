// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Decode of the ERC-7579 single-execution calldata blob.
/// @dev Layout: abi.encodePacked(address target, uint256 value, bytes callData).
library ExecutionLib {
    error MalformedExecution();

    /// @dev 1-to-3 byte calldata right-pads into a valid-looking bytes4 and then reaches the
    ///      target's fallback. Rejected outright rather than normalised.
    error ShortCallData();

    function decode(bytes calldata executionCallData)
        internal
        pure
        returns (address target, uint256 value, bytes calldata callData)
    {
        if (executionCallData.length < 52) revert MalformedExecution();
        target = address(bytes20(executionCallData[0:20]));
        value = uint256(bytes32(executionCallData[20:52]));
        callData = executionCallData[52:];
        if (callData.length != 0 && callData.length < 4) revert ShortCallData();
    }

    /// @return sel The 4-byte selector.
    /// @return present False when the call carries no calldata at all.
    function selectorOf(bytes calldata callData) internal pure returns (bytes4 sel, bool present) {
        if (callData.length < 4) return (bytes4(0), false);
        return (bytes4(callData[0:4]), true);
    }

    /// @dev Reads the 32-byte word at `argIndex` after the selector. Reverts rather than
    ///      returning zero when the word is not present; a short read that silently yields a
    ///      small number passes every cap.
    function wordAt(bytes calldata callData, uint256 argIndex) internal pure returns (uint256 word, bool ok) {
        uint256 offset = 4 + (argIndex * 32);
        if (callData.length < offset + 32) return (0, false);
        return (uint256(bytes32(callData[offset:offset + 32])), true);
    }
}
