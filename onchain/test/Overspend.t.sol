// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./base/Fixture.sol";
import {AmountSite, Caveat, Delegation} from "../src/core/Types.sol";
import {PolicyDenied, Rules, Reasons} from "../src/core/Errors.sol";
import {SessionTotalCapEnforcer} from "../src/enforcers/SessionTotalCapEnforcer.sol";
import {OverchargingERC20} from "./mocks/MockERC20.sol";

/// @notice The gap between what an execution DECLARES and what it actually MOVES.
///
/// @dev The cap is checked before the call, against an amount decoded from calldata. What a
///      token really moves is the token's decision, not the calldata's: fee-on-transfer,
///      rebasing and malicious tokens all break declared == realised. The stateful enforcer
///      takes a balance snapshot and reconciles afterwards for exactly this reason, and until
///      now that reconciliation had no test at all, so it could have been deleted wholesale
///      and the suite would have stayed green.
contract OverspendTest is Fixture {
    uint256 internal constant NOW = 1_800_000_000;
    uint256 internal constant SOON = 1_800_003_600;
    address internal sink = address(0x5152);

    function setUp() public {
        deploySuite();
        vm.warp(NOW);
    }

    /// @dev Declared 100, actually moves 150. The overspend must be charged, not ignored.
    function test_Overspend_IsChargedToTheSessionCounter() public {
        OverchargingERC20 greedy = new OverchargingERC20(50 ether, sink);
        greedy.mint(address(account), 1_000 ether);

        Delegation memory d = mandateFor(address(greedy), 200 ether, 400 ether, SOON);
        bytes memory exec = execOf(
            address(greedy), 0, abi.encodeWithSelector(bytes4(keccak256("transfer(address,uint256)")), recipient, 100 ether)
        );

        redeemAs(agent, d, bytes32(0), exec);

        assertEq(greedy.balanceOf(sink), 50 ether, "the token took its extra");
        // 150 actually left the account. A counter that recorded 100 would let the next
        // redemption spend 300 against a 400 cap, for 450 in total.
        assertEq(
            sessionE.spentOf(address(manager), manager.getDelegationHash(d)),
            150 ether,
            "counter must record what actually left, not what was declared"
        );
    }

    /// @dev The same overspend, but it carries the session past its cap. The reconciliation
    ///      has to revert the whole redemption rather than record an over-cap total.
    function test_Overspend_PastTheCap_RevertsTheRedemption() public {
        OverchargingERC20 greedy = new OverchargingERC20(50 ether, sink);
        greedy.mint(address(account), 1_000 ether);

        // Cap 120: a declared 100 fits, but the realised 150 does not.
        Delegation memory d = mandateFor(address(greedy), 200 ether, 120 ether, SOON);
        bytes memory exec = execOf(
            address(greedy), 0, abi.encodeWithSelector(bytes4(keccak256("transfer(address,uint256)")), recipient, 100 ether)
        );

        uint256 before = greedy.balanceOf(address(account));
        vm.expectRevert(
            abi.encodeWithSelector(PolicyDenied.selector, Rules.SESSION_TOTAL_CAP, Reasons.OVER_SESSION_CAP)
        );
        redeemAs(agent, d, bytes32(0), exec);

        assertEq(greedy.balanceOf(address(account)), before, "the whole redemption must unwind");
        assertEq(greedy.balanceOf(sink), 0, "the token kept nothing");
    }
}
