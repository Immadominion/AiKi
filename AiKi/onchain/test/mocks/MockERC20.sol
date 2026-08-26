// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 for tests. 18 decimals, matching USDT on BNB Chain (which is 18,
///         not the 6 that USDT uses elsewhere -- a decimals mistake here is a 10^12 error in
///         the cap).
contract MockERC20 {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 value) external virtual returns (bool) {
        _take(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        _take(from, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function _take(address from, address to, uint256 value) internal {
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// @notice A token whose `transfer` moves MORE than the caller asked for.
///
/// @dev This is the case the stateful enforcer's afterHook exists for. The cap is checked
///      before the call against the amount DECLARED in calldata, but what a token actually
///      moves is the token's decision. Fee-on-transfer, rebasing and outright malicious tokens
///      all break the assumption that declared equals realised, and a cap that trusts calldata
///      alone is a cap the token can walk straight through.
contract OverchargingERC20 is MockERC20 {
    uint256 public immutable EXTRA;
    address public immutable SINK;

    constructor(uint256 extra, address sink) {
        EXTRA = extra;
        SINK = sink;
    }

    function transfer(address to, uint256 value) external override returns (bool) {
        _take(msg.sender, to, value);
        _take(msg.sender, SINK, EXTRA);
        return true;
    }
}
