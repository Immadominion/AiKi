// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Checked ERC-20 operations for fixed, reviewed strategy assets.
/// @dev No EOA "tokens", false returns, malformed return values or leftover approvals.
library StrategyToken {
    error InvalidStrategyToken();
    error StrategyTokenCallFailed();
    error StrategyApprovalMismatch();
    error InvalidStrategyRecipient();

    function balance(address token, address account) internal view returns (uint256) {
        return _read(token, abi.encodeWithSelector(bytes4(0x70a08231), account));
    }

    function allowance(address token, address account, address spender) internal view returns (uint256) {
        return _read(token, abi.encodeWithSelector(bytes4(0xdd62ed3e), account, spender));
    }

    function safeTransfer(address token, address to, uint256 amount) internal {
        if (to == address(0)) revert InvalidStrategyRecipient();
        _call(token, abi.encodeWithSelector(bytes4(0xa9059cbb), to, amount));
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        if (from == address(0) || to == address(0)) revert InvalidStrategyRecipient();
        _call(token, abi.encodeWithSelector(bytes4(0x23b872dd), from, to, amount));
    }

    /// @dev Set an exact, checked allowance, including cleanup with amount zero.
    function approveExact(address token, address spender, uint256 amount) internal {
        if (spender == address(0)) revert InvalidStrategyRecipient();
        _call(token, abi.encodeWithSelector(bytes4(0x095ea7b3), spender, 0));
        if (allowance(token, address(this), spender) != 0) revert StrategyApprovalMismatch();
        if (amount != 0) {
            _call(token, abi.encodeWithSelector(bytes4(0x095ea7b3), spender, amount));
            if (allowance(token, address(this), spender) != amount) revert StrategyApprovalMismatch();
        }
    }

    function _read(address token, bytes memory data) private view returns (uint256) {
        if (token.code.length == 0) revert InvalidStrategyToken();
        (bool ok, bytes memory result) = token.staticcall(data);
        if (!ok || result.length != 32) revert StrategyTokenCallFailed();
        return abi.decode(result, (uint256));
    }

    function _call(address token, bytes memory data) private {
        if (token.code.length == 0) revert InvalidStrategyToken();
        (bool ok, bytes memory result) = token.call(data);
        if (!ok) revert StrategyTokenCallFailed();
        if (result.length != 0 && (result.length != 32 || abi.decode(result, (uint256)) != 1)) {
            revert StrategyTokenCallFailed();
        }
    }
}
