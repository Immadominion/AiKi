// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice The smallest thing that behaves like a lending market for repayment.
///
/// @dev It exists to make one distinction testable: `transfer(market, n)` and
///      `repayBorrow(n)` both move n tokens, and only the second reduces a debt. A test that
///      asserted on the market's balance alone would pass for either, which is exactly how a
///      guardian that donates to the pool instead of repaying the loan would go unnoticed.
///      This records the borrow separately from the balance, so the assertion can be about the
///      debt.
contract MockVToken {
    IERC20Minimal public immutable UNDERLYING;
    mapping(address => uint256) public borrowBalance;

    error RepayExceedsBorrow();

    constructor(address underlying_) {
        UNDERLYING = IERC20Minimal(underlying_);
    }

    function setBorrow(address who, uint256 amount) external {
        borrowBalance[who] = amount;
    }

    /// @dev Pulls through an allowance, as Venus does. An account that has not approved the
    ///      market cannot be repaid on behalf of, which is the property that keeps the agent
    ///      from needing an approval caveat of its own.
    function repayBorrow(uint256 repayAmount) external returns (uint256) {
        if (repayAmount > borrowBalance[msg.sender]) revert RepayExceedsBorrow();
        borrowBalance[msg.sender] -= repayAmount;
        UNDERLYING.transferFrom(msg.sender, address(this), repayAmount);
        return 0;
    }
}
