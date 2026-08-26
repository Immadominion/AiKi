// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./base/Fixture.sol";
import {AiKiMandateAccount} from "../src/account/AiKiMandateAccount.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice The account's authority graph, asserted rather than assumed.
///
/// @dev The account's own documentation says it has exactly two authorities: the owner, who may
///      withdraw at any time, and the immutable delegation manager, which may only execute. The
///      whole T0 claim rests on that being true, because an unguarded withdrawal or ownership
///      transfer is a side door that empties the account the caveats were protecting.
///
///      Every one of these tests was checked by deleting the matching `onlyOwner` modifier and
///      confirming it goes red. Before this file existed, the suite passed with `withdrawERC20`
///      and `transferOwnership` completely unguarded: 82 tests, all green, while anyone on BNB
///      Chain could have drained the account or taken it over.
contract AccountAuthorityTest is Fixture {
    function setUp() public {
        deploySuite();
        vm.deal(address(account), 10 ether);
    }

    function test_Stranger_CannotWithdrawTokens() public {
        uint256 before = token.balanceOf(address(account));
        vm.prank(stranger);
        vm.expectRevert(AiKiMandateAccount.NotOwner.selector);
        account.withdrawERC20(address(token), stranger, 1 ether);
        assertEq(token.balanceOf(address(account)), before, "balance moved");
        assertEq(token.balanceOf(stranger), 0, "stranger was paid");
    }

    function test_Stranger_CannotWithdrawNative() public {
        uint256 before = address(account).balance;
        vm.prank(stranger);
        vm.expectRevert(AiKiMandateAccount.NotOwner.selector);
        account.withdrawNative(payable(stranger), 1 ether);
        assertEq(address(account).balance, before, "native moved");
    }

    function test_Stranger_CannotTakeOwnership() public {
        vm.prank(stranger);
        vm.expectRevert(AiKiMandateAccount.NotOwner.selector);
        account.transferOwnership(stranger);
        assertEq(account.owner(), owner, "ownership moved");
    }

    function test_Stranger_CannotExecuteDirectly() public {
        vm.prank(stranger);
        vm.expectRevert(AiKiMandateAccount.NotOwner.selector);
        account.execute(address(token), 0, abi.encodeWithSelector(MockERC20.mint.selector, stranger, 1 ether));
        assertEq(token.balanceOf(stranger), 0, "stranger minted through the account");
    }

    /// @dev The agent holds a delegation, never the account. Its only route is the manager.
    function test_Delegate_CannotWithdrawEvenHoldingAMandate() public {
        vm.prank(agent);
        vm.expectRevert(AiKiMandateAccount.NotOwner.selector);
        account.withdrawERC20(address(token), agent, 1 ether);
    }

    function test_Owner_CanStillWithdrawAndHandOver() public {
        uint256 before = token.balanceOf(address(account));
        vm.startPrank(owner);
        account.withdrawERC20(address(token), owner, 5 ether);
        account.withdrawNative(payable(owner), 1 ether);
        account.transferOwnership(stranger);
        vm.stopPrank();
        assertEq(token.balanceOf(address(account)), before - 5 ether, "owner withdrawal blocked");
        assertEq(account.owner(), stranger, "ownership transfer blocked");
    }

    /// @dev Only the manager executes. Not the owner's key wearing the manager's hat, not a
    ///      second executor, because there is no way to add one.
    function test_OnlyManagerCanExecuteFromExecutor() public {
        vm.prank(stranger);
        vm.expectRevert(AiKiMandateAccount.NotDelegationManager.selector);
        account.executeFromExecutor(bytes32(0), "");

        vm.prank(owner);
        vm.expectRevert(AiKiMandateAccount.NotDelegationManager.selector);
        account.executeFromExecutor(bytes32(0), "");
    }
}
