// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "../base/Test.sol";
import {StrategyVaultBase} from "../../src/strategies/StrategyVaultBase.sol";
import {PancakeLPVault} from "../../src/strategies/lp/PancakeLPVault.sol";
import {PancakeMath} from "../../src/strategies/pancake/PancakeMath.sol";
import {
    LPControllerMock,
    LPTokenMock,
    LPPoolMock,
    LPFactoryMock,
    LPManagerMock,
    LPRouterMock
} from "./LPTestMocks.sol";

contract LPVaultTest is Test {
    address private constant OWNER = address(0xA11CE);
    LPControllerMock private controller;
    LPTokenMock private t0;
    LPTokenMock private t1;
    LPPoolMock private pool;
    LPFactoryMock private factory;
    LPManagerMock private manager;
    LPRouterMock private router;
    PancakeLPVault private vault;
    uint256 private nft;
    uint128 private constant LIQUIDITY = 1e20;

    function setUp() public {
        vm.warp(1_800_000_000);
        controller = new LPControllerMock(OWNER);
        LPTokenMock a = new LPTokenMock();
        LPTokenMock b = new LPTokenMock();
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);
        pool = new LPPoolMock(address(t0), address(t1));
        factory = new LPFactoryMock(address(pool));
        pool.setFactory(address(factory));
        manager = new LPManagerMock(address(factory), address(pool));
        router = new LPRouterMock(address(factory), address(pool));
        t0.mint(address(router), 1e24);
        t1.mint(address(router), 1e24);
        vault = _newVault(_policy());
        nft = _enroll(vault, -120, 120, 0, 0);
        vm.prank(OWNER);
        vault.resume();
    }

    function _policy() private pure returns (PancakeLPVault.LPPolicy memory p) {
        p = PancakeLPVault.LPPolicy({
            twapWindow: 300,
            maxDeviationTicks: 100,
            minPoolLiquidity: 1e18,
            rangeWidth: 120,
            maxCenterOffsetTicks: 20,
            maxSwapSlippageBps: 100,
            maxLiquiditySlippageBps: 100,
            minSwapFillBps: 5000,
            minDeployedBps: 7000,
            maxLossBps: 200,
            maxSwap0: 1e22,
            maxSwap1: 1e22,
            maxPositionValueQuote: 1e24,
            maxLossQuote: 1e21,
            maxCumulativeLossQuote: 2e21
        });
    }

    function _newVault(PancakeLPVault.LPPolicy memory p) private returns (PancakeLPVault) {
        return new PancakeLPVault(
            address(controller),
            StrategyVaultBase.CommonPolicy(uint64(block.timestamp + 7 days), 60, 120),
            PancakeLPVault.Protocol(address(manager), address(router), address(pool), address(t1)),
            p
        );
    }

    function _enroll(PancakeLPVault v, int24 lower, int24 upper, uint128 fees0, uint128 fees1)
        private
        returns (uint256 id)
    {
        id = manager.seed(OWNER, lower, upper, LIQUIDITY, fees0, fees1);
        vm.prank(OWNER);
        manager.approve(address(v), id);
        vm.prank(OWNER);
        v.enroll(id);
        assertTrue(v.paused(), "funding did not activate");
    }

    function _plan() private view returns (PancakeLPVault.RebalancePlan memory p) {
        p.expectedNonce = vault.operationNonce();
        p.expectedTokenId = vault.currentTokenId();
        p.tickLower = -60;
        p.tickUpper = 60;
        p.minLiquidity = 1;
        p.deadline = block.timestamp + 60;
    }

    function _execute(PancakeLPVault.RebalancePlan memory p) private {
        vm.prank(address(controller));
        vault.rebalance(p);
    }

    function _swapPlan(bool zeroForOne, uint128 amount)
        private
        view
        returns (PancakeLPVault.RebalancePlan memory p)
    {
        p = _plan();
        p.zeroForOne = zeroForOne;
        p.swapAmount = amount;
        p.sqrtPriceLimitX96 = PancakeMath.sqrtRatioAtTick(zeroForOne ? int24(-50) : int24(50));
    }

    function _assertRollback(uint256 id, uint256 nonce) private view {
        assertEq(vault.currentTokenId(), id, "same NFT");
        assertEq(vault.operationNonce(), nonce, "nonce rolled back");
        assertEq(manager.ownerOf(id), address(vault), "custody intact");
        assertEq(manager.positions(id).liquidity, LIQUIDITY, "old liquidity intact");
        assertEq(t0.balanceOf(address(vault)), 0, "no partial collection");
        assertEq(t1.balanceOf(address(vault)), 0, "no partial collection");
        assertEq(t0.allowance(address(vault), address(manager)), 0, "no leftover mint approval");
        assertEq(t1.allowance(address(vault), address(router)), 0, "no leftover swap approval");
    }

    function testAtomicZeroSwapReplacementAndReplay() public {
        PancakeLPVault.RebalancePlan memory p = _plan();
        _execute(p);
        uint256 next = vault.currentTokenId();
        assertTrue(next != nft, "replaced NFT");
        assertEq(manager.ownerOf(nft), address(0), "old NFT burned");
        assertEq(manager.ownerOf(next), address(vault), "new NFT remains in custody");
        assertTrue(vault.positionLiquidity() > 0, "deployed liquidity");
        assertEq(vault.operationNonce(), p.expectedNonce + 1, "one operation");
        assertEq(t0.allowance(address(vault), address(manager)), 0, "t0 exact allowance cleared");
        assertEq(t1.allowance(address(vault), address(manager)), 0, "t1 exact allowance cleared");
        vm.expectRevert(StrategyVaultBase.StaleStrategyNonce.selector);
        _execute(p);
    }

    function testBothSwapDirectionsReplaceOutOfRangeNFTs() public {
        for (uint256 i; i < 2; i++) {
            bool direction = i == 0;
            vault = _newVault(_policy());
            nft = _enroll(
                vault, direction ? int24(120) : int24(-240), direction ? int24(240) : int24(-120), 0, 0
            );
            vm.prank(OWNER);
            vault.resume();
            (uint256 a, uint256 b) = PancakeMath.amountsForLiquidity(
                PancakeMath.sqrtRatioAtTick(0),
                PancakeMath.sqrtRatioAtTick(direction ? int24(120) : int24(-240)),
                PancakeMath.sqrtRatioAtTick(direction ? int24(240) : int24(-120)),
                LIQUIDITY
            );
            _execute(_swapPlan(direction, uint128((direction ? a : b) / 2)));
            assertTrue(vault.currentTokenId() != nft, "both directions actually remint");
            assertEq(t0.allowance(address(vault), address(router)), 0, "router allowance cleared");
            assertEq(t1.allowance(address(vault), address(router)), 0, "router allowance cleared");
        }
    }

    function testPartialInputAccountsActualFillNotDeclaredInput() public {
        router.configure(5000, 10000, false);
        PancakeLPVault.RebalancePlan memory p = _swapPlan(true, 1e16);
        _execute(p);
        assertTrue(vault.idle1() > vault.idle0(), "actual swap changed token mix");
        assertEq(t0.balanceOf(address(router)), 1e24 + 5e15, "only actual input paid");
    }

    function testEveryManagerStageFailureRollsBackEntireOperation() public {
        for (uint8 stage = 1; stage <= 4; stage++) {
            manager.setFailure(stage);
            PancakeLPVault.RebalancePlan memory p = _plan();
            vm.expectRevert();
            _execute(p);
            _assertRollback(nft, p.expectedNonce);
        }
    }

    function testSwapFailureRollsBackRemovalAndFees() public {
        router.configure(10000, 10000, true);
        PancakeLPVault.RebalancePlan memory p = _swapPlan(true, 1e16);
        vm.expectRevert();
        _execute(p);
        _assertRollback(nft, p.expectedNonce);
    }

    function testActualOutputMustMatchReportedOutput() public {
        router.setBadReport();
        PancakeLPVault.RebalancePlan memory p = _swapPlan(true, 1e16);
        vm.expectRevert();
        _execute(p);
        _assertRollback(nft, p.expectedNonce);
    }

    function testPriceCannotCrossTheStricterPlanLimitEvenInsidePolicyDeviation() public {
        router.setNextTick(-55);
        PancakeLPVault.RebalancePlan memory p = _swapPlan(true, 1e16);
        vm.expectRevert(PancakeLPVault.EconomicLimit.selector);
        _execute(p);
        _assertRollback(nft, p.expectedNonce);
    }

    function testPartialFillBelowPolicyMinimumRollsBack() public {
        router.configure(4999, 10000, false);
        PancakeLPVault.RebalancePlan memory p = _swapPlan(true, 1e16);
        vm.expectRevert(PancakeLPVault.EconomicLimit.selector);
        _execute(p);
        _assertRollback(nft, p.expectedNonce);
    }

    function testOwnerMustApproveExactNFTBeforeEnrollment() public {
        PancakeLPVault other = _newVault(_policy());
        uint256 id = manager.seed(OWNER, -120, 120, LIQUIDITY, 0, 0);
        vm.expectRevert(PancakeLPVault.InvalidPosition.selector);
        vm.prank(OWNER);
        other.enroll(id);
        assertEq(manager.ownerOf(id), OWNER, "no custody change");
    }

    function testMandatorySwapMinimumCannotBeDisabledByZeroUserMinimum() public {
        router.configure(10000, 9000, false);
        PancakeLPVault.RebalancePlan memory p = _swapPlan(true, 1e16);
        assertEq(p.minSwapOut, 0, "agent sets zero");
        vm.expectRevert();
        _execute(p);
        _assertRollback(nft, p.expectedNonce);
    }

    function testWrongReplacementCustodyRollsBack() public {
        manager.setBadRecipient(true);
        PancakeLPVault.RebalancePlan memory p = _plan();
        vm.expectRevert();
        _execute(p);
        _assertRollback(nft, p.expectedNonce);
    }

    function testInsufficientRemainingPoolLiquidityRollsBack() public {
        manager.setAfterRemoveLiquidity(1);
        PancakeLPVault.RebalancePlan memory p = _plan();
        vm.expectRevert();
        _execute(p);
        _assertRollback(nft, p.expectedNonce);
    }

    function testUnsolicitedNFTLiquidityCannotExpandAllocation() public {
        manager.increaseUnsolicited(nft);
        PancakeLPVault.RebalancePlan memory p = _plan();
        vm.expectRevert(PancakeLPVault.InvalidPosition.selector);
        _execute(p);
    }

    function testTokenDonationsStayOutsideAutomatedInventory() public {
        t0.mint(address(vault), 1e21);
        t1.mint(address(vault), 2e21);
        _execute(_plan());
        assertEq(t0.balanceOf(address(vault)) - vault.idle0(), 1e21, "t0 donation excluded");
        assertEq(t1.balanceOf(address(vault)) - vault.idle1(), 2e21, "t1 donation excluded");
        uint256 nonce = vault.operationNonce();
        vm.prank(OWNER);
        vault.recoverSurplus(address(t0));
        assertEq(t0.balanceOf(OWNER), 1e21, "owner recovered surplus");
        assertEq(vault.operationNonce(), nonce + 1, "withdrawal invalidates plans");
    }

    function testOwnerRecoveryWorksPausedExpiredAndOracleDown() public {
        pool.setOracle(0, false, true, true);
        vm.prank(OWNER);
        vault.pause();
        vm.warp(block.timestamp + 8 days);
        vm.prank(OWNER);
        vault.withdrawPosition();
        assertEq(manager.ownerOf(nft), OWNER, "NFT returned without liquidation");
        assertEq(vault.currentTokenId(), 0, "closed");
    }

    function testDynamicOwnerNotControllerCanWithdraw() public {
        vm.expectRevert(StrategyVaultBase.NotStrategyOwner.selector);
        vm.prank(address(controller));
        vault.withdrawPosition();
        controller.changeOwner(address(0xB0B));
        vm.expectRevert(StrategyVaultBase.NotStrategyOwner.selector);
        vm.prank(OWNER);
        vault.withdrawPosition();
        vm.prank(address(0xB0B));
        vault.withdrawPosition();
        assertEq(manager.ownerOf(nft), address(0xB0B), "new owner recovers");
    }

    function testCannotEnrollSecondNFTOrResetBudget() public {
        vm.prank(OWNER);
        vault.withdrawPosition();
        uint256 other = manager.seed(OWNER, -120, 120, LIQUIDITY, 0, 0);
        vm.prank(OWNER);
        manager.approve(address(vault), other);
        vm.expectRevert(PancakeLPVault.InvalidPosition.selector);
        vm.prank(OWNER);
        vault.enroll(other);
    }

    function testMalformedRangeExpiryNonceAndForeignCallerRefuse() public {
        PancakeLPVault.RebalancePlan memory p = _plan();
        vm.expectRevert(StrategyVaultBase.NotStrategyController.selector);
        vault.rebalance(p);
        p.tickLower = -61;
        vm.expectRevert(PancakeLPVault.InvalidPlan.selector);
        _execute(p);
        p = _plan();
        p.deadline = block.timestamp + 121;
        vm.expectRevert(StrategyVaultBase.InvalidStrategyDeadline.selector);
        _execute(p);
        p = _plan();
        p.expectedTokenId = nft + 1;
        vm.expectRevert(PancakeLPVault.InvalidPosition.selector);
        _execute(p);
        p = _plan();
        p.sqrtPriceLimitX96 = 1;
        vm.expectRevert(PancakeLPVault.InvalidPlan.selector);
        _execute(p);
    }

    function testReentrancyRollsBack() public {
        PancakeLPVault.RebalancePlan memory p = _plan();
        manager.setReentry(address(vault), abi.encodeCall(vault.rebalance, (p)));
        vm.expectRevert();
        _execute(p);
        _assertRollback(nft, p.expectedNonce);
    }

    function testFalseApprovalAndTaxedTokenRefused() public {
        PancakeLPVault.RebalancePlan memory p = _plan();
        t0.configure(false, true, false);
        vm.expectRevert();
        _execute(p);
        _assertRollback(nft, p.expectedNonce);
        t0.configure(false, false, true);
        vm.expectRevert();
        _execute(p);
        _assertRollback(nft, p.expectedNonce);
    }

    function testFeesCannotHideSwapLossAndCumulativeBudgetDoesNotReset() public {
        PancakeLPVault.LPPolicy memory policy = _policy();
        policy.maxLossQuote = 1;
        policy.maxCumulativeLossQuote = 1;
        vault = _newVault(policy);
        nft = _enroll(vault, -120, 120, 1e19, 1e19);
        vm.prank(OWNER);
        vault.resume();
        router.configure(10000, 9990, false);
        PancakeLPVault.RebalancePlan memory p = _swapPlan(true, 1e16);
        vm.expectRevert(PancakeLPVault.EconomicLimit.selector);
        _execute(p);
        assertEq(vault.cumulativeLossQuote(), 0, "revert rolls back budget");
        assertEq(manager.positions(nft).tokensOwed0, 1e19, "fees also rolled back");
    }

    function testDeployedRatioCannotBeDisabledByTinyMintMinimum() public {
        PancakeLPVault.LPPolicy memory policy = _policy();
        policy.minDeployedBps = 10000;
        vault = _newVault(policy);
        nft = _enroll(vault, -120, 120, 1e19, 0);
        vm.prank(OWNER);
        vault.resume();
        PancakeLPVault.RebalancePlan memory p = _plan();
        vm.expectRevert(PancakeLPVault.EconomicLimit.selector);
        _execute(p);
    }

    function testCumulativeLossSurvivesGainsAndPauseResume() public {
        PancakeLPVault.LPPolicy memory policy = _policy();
        policy.maxLossQuote = 11e12;
        policy.maxCumulativeLossQuote = 15e12;
        vault = _newVault(policy);
        nft = _enroll(vault, -120, 120, 0, 0);
        vm.prank(OWNER);
        vault.resume();
        router.configure(10000, 9990, false);
        _execute(_swapPlan(true, 1e16));
        uint256 charged = vault.cumulativeLossQuote();
        assertTrue(charged >= 10e12 && charged <= 11e12, "actual loss charged");
        vm.prank(OWNER);
        vault.pause();
        vm.prank(OWNER);
        vault.resume();
        assertEq(vault.cumulativeLossQuote(), charged, "pause does not reset loss");
        vm.warp(vault.lastExecutionAt() + 60);
        router.configure(10000, 10010, false);
        _execute(_swapPlan(false, 1e16));
        assertEq(vault.cumulativeLossQuote(), charged, "profit does not replenish budget");
        vm.warp(vault.lastExecutionAt() + 60);
        router.configure(10000, 9990, false);
        PancakeLPVault.RebalancePlan memory p = _swapPlan(true, 1e16);
        vm.expectRevert(PancakeLPVault.EconomicLimit.selector);
        _execute(p);
        assertEq(vault.cumulativeLossQuote(), charged, "failed operation not charged twice");
    }

    function testInvalidIdentityOrPolicyCannotDeploy() public {
        PancakeLPVault.LPPolicy memory policy = _policy();
        policy.minSwapFillBps = 0;
        vm.expectRevert(PancakeLPVault.InvalidConfiguration.selector);
        _newVault(policy);
        policy = _policy();
        policy.rangeWidth = 121;
        vm.expectRevert(PancakeLPVault.InvalidConfiguration.selector);
        _newVault(policy);
        pool.setFactory(address(manager));
        vm.expectRevert();
        _newVault(_policy());
    }

    function testBurnSideShortfallCountsAgainstWholeOperationLossBudget() public {
        PancakeLPVault.LPPolicy memory policy = _policy();
        policy.maxLossQuote = 0;
        policy.maxCumulativeLossQuote = 0;
        policy.maxLossBps = 0;
        vault = _newVault(policy);
        nft = _enroll(vault, -120, 120, 1e19, 1e19);
        vm.prank(OWNER);
        vault.resume();
        // Within the 1% burn minimum tolerance, but NOT within the zero loss budget.
        // Existing fees must not conceal this principal loss.
        manager.setBurnHaircut(50);
        PancakeLPVault.RebalancePlan memory p = _plan();
        vm.expectRevert(PancakeLPVault.EconomicLimit.selector);
        _execute(p);
        assertEq(manager.positions(nft).liquidity, LIQUIDITY, "principal rollback");
        assertEq(manager.positions(nft).tokensOwed0, 1e19, "fee rollback");
    }

    function testKnownCollectedFeeShortfallCountsAsLoss() public {
        PancakeLPVault.LPPolicy memory policy = _policy();
        policy.maxLossQuote = 0;
        policy.maxCumulativeLossQuote = 0;
        vault = _newVault(policy);
        nft = _enroll(vault, -120, 120, 1e19, 1e19);
        vm.prank(OWNER);
        vault.resume();
        manager.setCollectShortfall(1e16);
        PancakeLPVault.RebalancePlan memory p = _plan();
        vm.expectRevert(PancakeLPVault.EconomicLimit.selector);
        _execute(p);
        assertEq(manager.positions(nft).tokensOwed0, 1e19, "known owed amount protected");
    }
}
