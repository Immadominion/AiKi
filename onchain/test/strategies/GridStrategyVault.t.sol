// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "../base/Test.sol";
import {StrategyVaultBase} from "../../src/strategies/StrategyVaultBase.sol";
import {StrategyToken} from "../../src/strategies/StrategyToken.sol";
import {GridStrategyVault} from "../../src/strategies/grid/GridStrategyVault.sol";
import {IGridRouter} from "../../src/strategies/grid/GridInterfaces.sol";
import {PancakeMath} from "../../src/strategies/pancake/PancakeMath.sol";
import {PancakeOracle} from "../../src/strategies/pancake/PancakeOracle.sol";
import {
    GridMockController,
    GridMockToken,
    GridMockDeployer,
    GridMockFactory,
    GridMockPool,
    GridMockRouter
} from "./GridMocks.t.sol";

interface GridLogVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract GridStrategyVaultTest is Test {
    address private constant OWNER = address(0xA11CE);
    address private constant STRANGER = address(0xBAD);
    GridMockController private controller;
    GridMockToken private token0;
    GridMockToken private token1;
    GridMockDeployer private deployer;
    GridMockFactory private factory;
    GridMockPool private pool;
    GridMockRouter private router;
    GridStrategyVault private vault;
    uint256 private _testTime;

    function setUp() public {
        vm.chainId(56);
        vm.warp(100_000);
        _testTime = 100_000;
        controller = new GridMockController(OWNER);
        GridMockToken a = new GridMockToken();
        GridMockToken b = new GridMockToken();
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        deployer = new GridMockDeployer();
        factory = new GridMockFactory(address(deployer));
        pool = new GridMockPool(address(factory), address(token0), address(token1));
        factory.setPool(address(pool), address(token0), address(token1), 500);
        router = new GridMockRouter(address(factory), address(deployer), pool);
        vault = _deploy(_policy(), _rungPolicies());
        token0.mint(OWNER, 100_000 ether);
        token1.mint(OWNER, 100_000 ether);
        token0.mint(address(router), 100_000 ether);
        token1.mint(address(router), 100_000 ether);
        vm.startPrank(OWNER);
        token0.approve(address(vault), type(uint256).max);
        token1.approve(address(vault), type(uint256).max);
        vault.fund(0, 0, 1_000 ether);
        vault.resume();
        vm.stopPrank();
    }

    function _common() private view returns (StrategyVaultBase.CommonPolicy memory) {
        return StrategyVaultBase.CommonPolicy(uint64(block.timestamp + 7 days), 5, 120);
    }

    function _protocol() private view returns (GridStrategyVault.Protocol memory) {
        return GridStrategyVault.Protocol(
            address(router), address(factory), address(pool), address(token0), address(token1)
        );
    }

    function _policy() private pure returns (GridStrategyVault.GridPolicy memory) {
        return GridStrategyVault.GridPolicy({
            tickLower: -2_000,
            tickUpper: 2_000,
            maxInput0: 100 ether,
            maxInput1: 100 ether,
            fundingCap0: 10_000 ether,
            fundingCap1: 10_000 ether,
            turnoverCap0: 1_000 ether,
            turnoverCap1: 1_000 ether,
            twapWindow: 300,
            maxDeviationTicks: 100,
            minLiquidity: 1e12,
            maxSlippageBps: 100,
            minFillBps: 5_000,
            minCycleGainBps: 50,
            hysteresisTicks: 50
        });
    }

    function _rungPolicies() private pure returns (GridStrategyVault.RungPolicy[] memory r) {
        r = new GridStrategyVault.RungPolicy[](1);
        r[0] = GridStrategyVault.RungPolicy(-300, 300, 100 ether, 100 ether, false);
    }

    function _deploy(GridStrategyVault.GridPolicy memory p, GridStrategyVault.RungPolicy[] memory r)
        private
        returns (GridStrategyVault)
    {
        return new GridStrategyVault(address(controller), _common(), _protocol(), p, r);
    }

    function _step(int24 tick) private returns (bool) {
        return _stepRung(tick, 0);
    }

    function _stepRung(int24 tick, uint32 index) private returns (bool) {
        pool.setTick(tick);
        _testTime += 5;
        vm.warp(_testTime);
        uint256 nonce = vault.operationNonce();
        vm.prank(address(controller));
        return vault.execute(nonce, _testTime + 60, index);
    }

    function _buy() private {
        assertFalse(_step(0), "baseline traded");
        assertTrue(_step(-301), "buy absent");
    }

    function _failStep(int24 tick, bytes4 reason) private {
        pool.setTick(tick);
        _testTime += 5;
        vm.warp(_testTime);
        uint256 nonce = vault.operationNonce();
        vm.prank(address(controller));
        if (reason == bytes4(0)) vm.expectRevert();
        else vm.expectRevert(reason);
        vault.execute(nonce, _testTime + 60, 0);
    }

    function _expectUnchanged(uint256 nonce, uint256 a0, uint256 a1, uint256 swaps) private view {
        assertEq(vault.operationNonce(), nonce, "nonce changed on failure");
        assertEq(vault.allocated0(), a0, "base accounting changed on failure");
        assertEq(vault.allocated1(), a1, "quote accounting changed on failure");
        assertEq(router.swaps(), swaps, "router side effect survived revert");
        assertEq(token1.allowance(address(vault), address(router)), 0, "allowance leaked");
    }

    function test_ConstructorPinsAllConfigurationAndRequiresCode() public {
        assertEq(
            vault.policyHash(),
            keccak256(
                abi.encode(
                    "AIKI_PANCAKE_GRID_V1",
                    block.chainid,
                    address(controller),
                    _common(),
                    _protocol(),
                    _policy(),
                    _rungPolicies()
                )
            ),
            "config hash mismatch"
        );
        assertEq(vault.controller(), address(controller), "controller mismatch");
        assertEq(vault.pool(), address(pool), "pool mismatch");
        assertEq(
            vault.operationSelector(),
            bytes32(bytes4(keccak256("execute(uint256,uint256,uint32)"))),
            "selector mismatch"
        );
        GridStrategyVault.Protocol memory bad = _protocol();
        bad.router = STRANGER;
        vm.expectRevert(GridStrategyVault.InvalidProtocol.selector);
        new GridStrategyVault(address(controller), _common(), bad, _policy(), _rungPolicies());
    }

    function test_ConstructorRejectsWrongFactoryPoolPairAndDeployer() public {
        factory.setPool(STRANGER, address(token0), address(token1), 500);
        vm.expectRevert(GridStrategyVault.InvalidProtocol.selector);
        _deploy(_policy(), _rungPolicies());
        factory.setPool(address(pool), address(token0), address(token1), 500);
        GridStrategyVault.Protocol memory bad = _protocol();
        (bad.token0, bad.token1) = (bad.token1, bad.token0);
        vm.expectRevert(GridStrategyVault.InvalidProtocol.selector);
        new GridStrategyVault(address(controller), _common(), bad, _policy(), _rungPolicies());
        GridMockDeployer other = new GridMockDeployer();
        bad = _protocol();
        bad.router = address(new GridMockRouter(address(factory), address(other), pool));
        vm.expectRevert(GridStrategyVault.InvalidProtocol.selector);
        new GridStrategyVault(address(controller), _common(), bad, _policy(), _rungPolicies());
    }

    function test_ConstructorRejectsUnboundedAndUneconomicGrid() public {
        GridStrategyVault.GridPolicy memory p = _policy();
        p.minFillBps = 0;
        vm.expectRevert(GridStrategyVault.InvalidConfiguration.selector);
        _deploy(p, _rungPolicies());
        GridStrategyVault.RungPolicy[] memory r = _rungPolicies();
        r[0].buyTick = -60;
        r[0].sellTick = 60;
        vm.expectRevert(GridStrategyVault.InvalidConfiguration.selector);
        _deploy(_policy(), r);
        r = _rungPolicies();
        r[0].lot1 = 101 ether;
        vm.expectRevert(GridStrategyVault.InvalidConfiguration.selector);
        _deploy(_policy(), r);
    }

    function test_FirstObservationNeverCatchesUpHistoricalCrossing() public {
        assertFalse(_step(-301), "historical crossing traded");
        assertFalse(_step(-400), "unarmed rung traded");
        assertFalse(_step(-260), "inside hysteresis armed");
        assertFalse(_step(-301), "noise crossing traded");
        assertFalse(_step(-250), "arming observation traded");
        assertTrue(_step(-301), "qualified crossing not traded");
    }

    function test_FixedRouterPairRecipientPriceBoundAndMeaningfulMinimum() public {
        _buy();
        IGridRouter.ExactInputSingleParams memory p = router.lastParams();
        assertEq(p.tokenIn, address(token1), "wrong input");
        assertEq(p.tokenOut, address(token0), "wrong output");
        assertEq(p.recipient, address(vault), "foreign recipient");
        assertEq(p.fee, 500, "wrong fee");
        assertEq(p.amountIn, 100 ether, "wrong lot");
        assertEq(p.sqrtPriceLimitX96, PancakeMath.sqrtRatioAtTick(-300), "wrong signed bound");
        assertTrue(p.amountOutMinimum > 50 ether, "meaningless minimum output");
        assertEq(token1.allowance(address(vault), address(router)), 0, "uncleared allowance");
    }

    function test_ActualFillUpdatesInventoryAndCannotRepeatAtSamePrice() public {
        _buy();
        GridStrategyVault.RungState memory s = vault.rungState(0);
        assertTrue(s.nextSell, "direction did not change");
        assertEq(s.inventory1, 900 ether, "actual input not debited");
        assertEq(s.inventory0, token0.balanceOf(address(vault)), "actual output not credited");
        assertEq(vault.turnover1(), 100 ether, "wrong quote turnover");
        assertFalse(_step(-301), "same-price buy repeated");
        assertFalse(_step(-301), "same-price sell repeated");
        assertEq(router.swaps(), 1, "duplicate swap");
        assertTrue(_step(301), "opposite qualified crossing absent");
        assertEq(vault.rungState(0).cycle, 1, "cycle not completed");
        assertEq(vault.turnover0(), 100 ether, "wrong base turnover");
        assertFalse(_step(301), "same-price sell repeated after cycle");
    }

    function test_PartialInputUsesActualFillAndClearsAllowance() public {
        router.configure(5_000, 10_000, false, false, false, false);
        _buy();
        assertEq(vault.rungState(0).inventory1, 950 ether, "unspent input lost");
        assertEq(vault.turnover1(), 50 ether, "nominal input charged");
        assertEq(token1.allowance(address(vault), address(router)), 0, "partial allowance leaked");
        assertTrue(vault.rungState(0).nextSell, "partial fill replayable");
    }

    function test_InsufficientPartialFillRevertsEverything() public {
        _step(0);
        router.configure(4_999, 10_000, false, false, true, false);
        uint256 nonce = vault.operationNonce();
        _failStep(-301, GridStrategyVault.InvalidFill.selector);
        _expectUnchanged(nonce, 0, 1_000 ether, 0);
    }

    function test_ActualPriceCheckStricterThanRouterMinimumForPartialFloor() public {
        _step(0);
        // Full input, but only 75% output clears the router's 50%-fill floor.
        router.configure(10_000, 7_500, false, false, false, false);
        uint256 nonce = vault.operationNonce();
        _failStep(-301, GridStrategyVault.InvalidFill.selector);
        _expectUnchanged(nonce, 0, 1_000 ether, 0);
    }

    function test_MissingOutputAndLyingRouterRevertEverything() public {
        _step(0);
        router.configure(10_000, 10_000, false, true, false, false);
        uint256 nonce = vault.operationNonce();
        _failStep(-301, GridStrategyVault.InvalidFill.selector);
        _expectUnchanged(nonce, 0, 1_000 ether, 0);
        router.configure(10_000, 10_000, true, false, false, false);
        _failStep(-301, GridStrategyVault.InvalidFill.selector);
        _expectUnchanged(nonce, 0, 1_000 ether, 0);
    }

    function test_FailedSwapAndApprovalRollback() public {
        _step(0);
        uint256 nonce = vault.operationNonce();
        router.configure(10_000, 10_000, false, false, false, true);
        _failStep(-301, bytes4(0));
        _expectUnchanged(nonce, 0, 1_000 ether, 0);
        router.configure(10_000, 10_000, false, false, false, false);
        token1.behavior(false, true, false, false);
        _failStep(-301, StrategyToken.StrategyTokenCallFailed.selector);
        _expectUnchanged(nonce, 0, 1_000 ether, 0);
    }

    function test_FailedPartialApprovalCleanupRollsBackFill() public {
        _step(0);
        router.configure(5_000, 10_000, false, false, false, false);
        token1.behavior(false, false, true, false);
        uint256 nonce = vault.operationNonce();
        _failStep(-301, StrategyToken.StrategyTokenCallFailed.selector);
        _expectUnchanged(nonce, 0, 1_000 ether, 0);
    }

    function test_FeeOnTransferAndInputOverDebitFailClosed() public {
        _step(0);
        uint256 nonce = vault.operationNonce();
        token0.fees(100, 0);
        _failStep(-301, GridStrategyVault.InvalidFill.selector);
        _expectUnchanged(nonce, 0, 1_000 ether, 0);
        token0.fees(0, 0);
        token1.fees(0, 100);
        _failStep(-301, GridStrategyVault.InvalidFill.selector);
        _expectUnchanged(nonce, 0, 1_000 ether, 0);
    }

    function test_OptionalReturnTokensWorkAndReentryIsRejected() public {
        token0.behavior(false, false, false, true);
        token1.behavior(false, false, false, true);
        router.setReentry(true);
        _buy();
        assertTrue(router.reentryRejected(), "router reentry succeeded");
    }

    function test_DeadlineNonceCooldownAndCallerChecks() public {
        uint256 nonce = vault.operationNonce();
        vm.prank(STRANGER);
        vm.expectRevert(StrategyVaultBase.NotStrategyController.selector);
        vault.execute(nonce, block.timestamp + 60, 0);
        vm.prank(OWNER);
        vm.expectRevert(StrategyVaultBase.NotStrategyController.selector);
        vault.execute(nonce, block.timestamp + 60, 0);
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.InvalidStrategyDeadline.selector);
        vault.execute(nonce, block.timestamp + 121, 0);
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.InvalidStrategyDeadline.selector);
        vault.execute(nonce, block.timestamp - 1, 0);
        _step(0);
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.StaleStrategyNonce.selector);
        vault.execute(nonce, block.timestamp + 60, 0);
        nonce = vault.operationNonce();
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.StrategyCooldown.selector);
        vault.execute(nonce, block.timestamp + 60, 0);
    }

    function test_TwapDeviationHistoryAndLiquidityFailClosed() public {
        uint256 nonce = vault.operationNonce();
        pool.setOracle(200, 0, 3600, 1e18, true);
        vm.prank(address(controller));
        vm.expectRevert(PancakeOracle.InvalidOracle.selector);
        vault.execute(nonce, block.timestamp + 60, 0);
        pool.setOracle(0, 0, 299, 1e18, true);
        vm.prank(address(controller));
        vm.expectRevert(PancakeOracle.InvalidOracle.selector);
        vault.execute(nonce, block.timestamp + 60, 0);
        pool.setOracle(0, 0, 3600, 0, true);
        vm.prank(address(controller));
        vm.expectRevert(PancakeOracle.InvalidOracle.selector);
        vault.execute(nonce, block.timestamp + 60, 0);
        _expectUnchanged(nonce, 0, 1_000 ether, 0);
    }

    function test_OutsideImmutableGridWaitsWithoutRegridding() public {
        _step(0);
        assertFalse(_step(-2_001), "outside grid traded");
        assertTrue(vault.rungPolicy(0).buyTick == -300, "rung changed");
        assertTrue(_step(-301), "return inside grid not executable");
    }

    function test_WithdrawalInvalidatesPlanAndResumeRequiresFreshBaseline() public {
        _step(0);
        uint256 oldNonce = vault.operationNonce();
        vm.prank(OWNER);
        vault.withdraw(0, 0, 10 ether, OWNER);
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.StaleStrategyNonce.selector);
        vault.execute(oldNonce, block.timestamp + 60, 0);
        assertFalse(_step(-301), "owner edit allowed stale crossing");
        _step(0);
        vm.prank(OWNER);
        vault.pause();
        vm.prank(OWNER);
        vault.resume();
        assertFalse(_step(-301), "pause/resume caught up historical crossing");
        assertEq(router.swaps(), 0, "unexpected swap");
    }

    function test_OwnerRecoverySurvivesExpiryAndOwnershipChange() public {
        vm.warp(vault.expiresAt());
        uint256 nonce = vault.operationNonce();
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.StrategyExpired.selector);
        vault.execute(nonce, block.timestamp, 0);
        vm.prank(OWNER);
        controller.changeOwner(STRANGER);
        vm.prank(OWNER);
        vm.expectRevert(StrategyVaultBase.NotStrategyOwner.selector);
        vault.withdraw(0, 0, 1 ether, OWNER);
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.NotStrategyOwner.selector);
        vault.withdraw(0, 0, 1 ether, STRANGER);
        vm.prank(STRANGER);
        vault.withdraw(0, 0, 1_000 ether, STRANGER);
        assertEq(vault.allocated1(), 0, "recovery blocked by expiry");
        assertEq(vault.funded1(), 1_000 ether, "funding cap replenished on withdrawal");
    }

    function test_DonationsNeverIncreaseRungOrCapsAndOnlySurplusRecoverable() public {
        token1.mint(address(vault), 400 ether);
        assertEq(vault.rungState(0).inventory1, 1_000 ether, "donation allocated");
        assertEq(vault.funded1(), 1_000 ether, "donation affected principal");
        vm.prank(OWNER);
        vm.expectRevert(GridStrategyVault.InventoryShortfall.selector);
        vault.recoverSurplus(address(token1), 401 ether, OWNER);
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.NotStrategyOwner.selector);
        vault.recoverSurplus(address(token1), 400 ether, STRANGER);
        vm.prank(OWNER);
        vault.recoverSurplus(address(token1), 400 ether, OWNER);
        assertEq(token1.balanceOf(address(vault)), 1_000 ether, "allocated inventory lost");
    }

    function test_UnexpectedInventoryLossStopsOperations() public {
        token1.burn(address(vault), 1);
        _failStep(0, GridStrategyVault.InventoryShortfall.selector);
    }

    function test_FundingCapsAndTokenDeltasAreChecked() public {
        vm.prank(OWNER);
        vm.expectRevert(GridStrategyVault.FundingLimit.selector);
        vault.fund(0, 0, 9_001 ether);
        token1.fees(100, 0);
        vm.prank(OWNER);
        vm.expectRevert(GridStrategyVault.UnsupportedToken.selector);
        vault.fund(0, 0, 1 ether);
        assertEq(vault.funded1(), 1_000 ether, "failed funding persisted");
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.NotStrategyOwner.selector);
        vault.fund(0, 0, 1 ether);
    }

    function test_RuntimeChainAndCodeIdentityFailClosed() public {
        vm.chainId(97);
        _failStep(0, GridStrategyVault.InvalidProtocol.selector);
        vm.chainId(56);
        vm.etch(address(router), hex"00");
        _failStep(0, GridStrategyVault.InvalidProtocol.selector);
        // Recovery does not require a functioning router.
        vm.prank(OWNER);
        vault.withdraw(0, 0, 1_000 ether, OWNER);
    }

    function test_FilledOperationReplayCannotTradeAfterLostAcknowledgement() public {
        _step(0);
        uint256 originalNonce = vault.operationNonce();
        assertTrue(_step(-301), "buy absent");
        uint256 newNonce = vault.operationNonce();
        vm.warp(_testTime + 5);
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.StaleStrategyNonce.selector);
        vault.execute(originalNonce, _testTime + 60, 0);
        assertEq(vault.operationNonce(), newNonce, "replay mutated nonce");
        assertEq(router.swaps(), 1, "lost acknowledgement replayed a fill");
    }

    function test_CompletedBuyArmsOppositeCrossingWithoutExtraPaidObservation() public {
        _buy();
        assertTrue(vault.rungState(0).armed, "next direction not armed by bounded fill");
        assertTrue(_step(301), "direct opposite crossing missed");
        assertEq(router.swaps(), 2, "wrong number of fills");
        assertTrue(_step(-301), "next cycle crossing missed");
        assertEq(vault.rungState(0).cycle, 1, "cycle counter advanced too early");
    }

    function test_SqrtBoundaryEqualityWaitsAndUnexpectedPostPriceReverts() public {
        _step(0);
        assertFalse(_step(-300), "invalid exact-equality pool limit sent");
        router.setPostTick(-299);
        uint256 nonce = vault.operationNonce();
        _failStep(-301, GridStrategyVault.InvalidFill.selector);
        _expectUnchanged(nonce, 0, 1_000 ether, 0);
    }

    function test_PerTokenTurnoverCannotBeReplenishedByCyclesOrWithdrawals() public {
        GridStrategyVault.GridPolicy memory p = _policy();
        p.turnoverCap1 = 100 ether;
        vault = _deploy(p, _rungPolicies());
        vm.startPrank(OWNER);
        token1.approve(address(vault), type(uint256).max);
        vault.fund(0, 0, 1_000 ether);
        vault.resume();
        vm.stopPrank();
        _buy();
        assertTrue(_step(301), "reverse sell absent");
        uint256 nonce = vault.operationNonce();
        uint256 a0 = vault.allocated0();
        uint256 a1 = vault.allocated1();
        _failStep(-301, GridStrategyVault.TurnoverLimit.selector);
        _expectUnchanged(nonce, a0, a1, 2);
        assertEq(vault.turnover1(), 100 ether, "quote turnover replenished");
        assertEq(vault.turnover0(), 100 ether, "base turnover mixed into quote units");
        vm.prank(OWNER);
        vault.withdraw(0, 0, 1 ether, OWNER);
        assertEq(vault.turnover1(), 100 ether, "withdrawal reset turnover");
    }

    function test_MultipleRungsHaveIsolatedLotsAndAtMostOneFillPerPass() public {
        GridStrategyVault.RungPolicy[] memory r = new GridStrategyVault.RungPolicy[](2);
        r[0] = GridStrategyVault.RungPolicy(-400, 300, 100 ether, 100 ether, false);
        r[1] = GridStrategyVault.RungPolicy(-300, 400, 100 ether, 100 ether, false);
        vault = _deploy(_policy(), r);
        vm.startPrank(OWNER);
        token1.approve(address(vault), type(uint256).max);
        vault.fund(0, 0, 200 ether);
        vault.fund(1, 0, 300 ether);
        vault.resume();
        vm.stopPrank();
        _step(0);
        assertTrue(_step(-401), "first selected rung did not fill");
        assertEq(router.swaps(), 1, "multiple swaps in one pass");
        assertEq(vault.rungState(0).inventory1, 100 ether, "selected lot not debited");
        assertEq(vault.rungState(1).inventory1, 300 ether, "other rung debited");
        assertTrue(_stepRung(-401, 1), "second crossed rung lost its eligibility");
        assertEq(router.swaps(), 2, "second pass wrong swap count");
        assertEq(vault.allocated1(), 300 ether, "aggregate inventory mismatch");
        assertEq(
            vault.allocated0(),
            vault.rungState(0).inventory0 + vault.rungState(1).inventory0,
            "base lots pooled incorrectly"
        );
    }

    function test_RungWithNoInventoryCannotSpendAnotherRungsInventoryOrDonation() public {
        GridStrategyVault.RungPolicy[] memory r = new GridStrategyVault.RungPolicy[](2);
        r[0] = GridStrategyVault.RungPolicy(-400, 300, 100 ether, 100 ether, false);
        r[1] = GridStrategyVault.RungPolicy(-300, 400, 100 ether, 100 ether, false);
        vault = _deploy(_policy(), r);
        vm.startPrank(OWNER);
        token1.approve(address(vault), type(uint256).max);
        vault.fund(0, 0, 200 ether);
        vault.resume();
        vm.stopPrank();
        token1.mint(address(vault), 1_000 ether);
        _step(0);
        assertFalse(_stepRung(-401, 1), "empty rung stole inventory");
        assertEq(vault.rungState(0).inventory1, 200 ether, "funded rung changed");
        assertEq(router.swaps(), 0, "donation spent");
    }

    function test_StartWithBaseInventorySellsThenBuysWithoutLeverage() public {
        GridStrategyVault.RungPolicy[] memory r = _rungPolicies();
        r[0].initialSell = true;
        vault = _deploy(_policy(), r);
        vm.startPrank(OWNER);
        token0.approve(address(vault), type(uint256).max);
        vault.fund(0, 1_000 ether, 0);
        vault.resume();
        vm.stopPrank();
        assertFalse(_step(0), "baseline sold");
        assertTrue(_step(301), "base-initial sell missing");
        assertFalse(vault.rungState(0).nextSell, "buy not next");
        assertTrue(_step(-301), "base-initial return buy missing");
        assertEq(vault.rungState(0).cycle, 1, "base-initial cycle not counted");
        assertEq(vault.funded1(), 0, "proceeds counted as owner funding");
    }

    function test_PartialFillEventCarriesCanonicalNonceAndActualInventory() public {
        _step(0);
        router.configure(5_000, 10_000, false, false, false, false);
        GridLogVm logVm = GridLogVm(address(vm));
        logVm.recordLogs();
        assertTrue(_step(-301), "partial fill absent");
        GridLogVm.Log[] memory logs = logVm.getRecordedLogs();
        uint256 fills;
        uint256 finishes;
        bytes32 fillTopic =
            keccak256("GridFilled(uint256,uint32,uint64,bool,uint256,uint256,uint256,uint256)");
        bytes32 finishTopic = keccak256("StrategyExecuted(bytes32,uint256,bytes32)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) continue;
            if (logs[i].topics[0] == fillTopic) {
                fills++;
                assertEq(uint256(logs[i].topics[1]), vault.operationNonce(), "fill nonce wrong");
                (uint64 cycle, bool sell, uint256 input, uint256 output, uint256 a0, uint256 a1) =
                    abi.decode(logs[i].data, (uint64, bool, uint256, uint256, uint256, uint256));
                assertEq(cycle, 0, "wrong event cycle");
                assertFalse(sell, "wrong event direction");
                assertEq(input, 50 ether, "event reports nominal input");
                assertEq(output, vault.rungState(0).inventory0, "event output mismatch");
                assertEq(a0, vault.allocated0(), "event base inventory mismatch");
                assertEq(a1, vault.allocated1(), "event quote inventory mismatch");
            }
            if (logs[i].topics[0] == finishTopic) {
                finishes++;
                assertEq(logs[i].topics[1], vault.policyHash(), "completion policy hash wrong");
                assertEq(uint256(logs[i].topics[2]), vault.operationNonce(), "completion nonce wrong");
                assertTrue(logs[i].topics[3] != bytes32(0), "empty completion plan hash");
            }
        }
        assertEq(fills, 1, "missing or duplicated fill event");
        assertEq(finishes, 1, "missing or duplicated completion event");
    }

    function testFuzz_PartialFillDebitsOnlyActualInput(uint16 rawBps) public {
        uint16 fill = uint16(5_000 + uint256(rawBps) % 5_001);
        router.configure(fill, 10_000, false, false, false, false);
        _buy();
        uint256 actual = uint256(100 ether) * uint256(fill) / 10_000;
        assertEq(vault.turnover1(), actual, "partial input accounting mismatch");
        assertEq(vault.rungState(0).inventory1, 1_000 ether - actual, "partial inventory mismatch");
        assertEq(token1.allowance(address(vault), address(router)), 0, "partial approval leaked");
    }

    function test_NativeValueAndUnknownCallsCannotBecomeTradingAuthority() public {
        uint256 nonce = vault.operationNonce();
        vm.deal(address(controller), 1 ether);
        vm.prank(address(controller));
        (bool valueAccepted,) = address(vault).call{value: 1}(
            abi.encodeWithSelector(vault.execute.selector, nonce, block.timestamp + 60, uint32(0))
        );
        assertFalse(valueAccepted, "native route accepted");
        vm.prank(address(controller));
        (bool arbitraryAccepted,) = address(vault).call(abi.encodeWithSignature("borrow(uint256)", 1 ether));
        assertFalse(arbitraryAccepted, "unknown operation accepted");
        assertEq(vault.operationNonce(), nonce, "rejected route changed nonce");
    }

    function testFuzz_SequencePreservesInventoryAndOneFillPerPass(bytes32 choices) public {
        _step(0);
        for (uint256 i; i < 12; ++i) {
            uint256 raw = (uint256(choices) >> (i * 16)) & 0xffff;
            int24 tick = int24(int256(raw % 3_999) - 1_999);
            uint256 swaps = router.swaps();
            uint256 nonce = vault.operationNonce();
            _step(tick);
            GridStrategyVault.RungState memory s = vault.rungState(0);
            assertTrue(router.swaps() <= swaps + 1, "more than one fill in pass");
            assertEq(vault.operationNonce(), nonce + 1, "successful pass nonce not monotonic");
            assertEq(s.inventory0, vault.allocated0(), "base lot detached from aggregate");
            assertEq(s.inventory1, vault.allocated1(), "quote lot detached from aggregate");
            assertEq(token0.balanceOf(address(vault)), vault.allocated0(), "base balance not conserved");
            assertEq(token1.balanceOf(address(vault)), vault.allocated1(), "quote balance not conserved");
            assertEq(s.cycle, router.swaps() / 2, "cycle not tied to pair of fills");
            assertTrue(
                vault.turnover0() <= 1_000 ether && vault.turnover1() <= 1_000 ether, "turnover bypass"
            );
            assertEq(vault.funded1(), 1_000 ether, "trading increased authorized principal");
            assertEq(token0.allowance(address(vault), address(router)), 0, "base allowance remains");
            assertEq(token1.allowance(address(vault), address(router)), 0, "quote allowance remains");
        }
    }
}
