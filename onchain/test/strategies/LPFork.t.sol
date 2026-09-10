// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "../base/Test.sol";
import {AiKiMandateAccount} from "../../src/account/AiKiMandateAccount.sol";
import {StrategyVaultBase} from "../../src/strategies/StrategyVaultBase.sol";
import {PancakeLPVault} from "../../src/strategies/lp/PancakeLPVault.sol";
import {ILPPositionManager, ILPFactory, ILPPool} from "../../src/strategies/lp/IPancakeLP.sol";
import {PancakeMath} from "../../src/strategies/pancake/PancakeMath.sol";
import {PancakeOracle, IPancakeOraclePool} from "../../src/strategies/pancake/PancakeOracle.sol";

interface LPForkVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function envOr(string calldata name, uint256 defaultValue) external returns (uint256);
    function skip(bool skipTest) external;
    function getBlockTimestamp() external view returns (uint256);
    function setEvmVersion(string calldata evm) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

interface LPForkToken {
    function balanceOf(address who) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function deposit() external payable;
}

interface LPForkNFPM is ILPPositionManager {
    function approve(address spender, uint256 tokenId) external;
}

/// @notice Actual Pancake V3 interactions on an explicitly pinned LOCAL BSC fork.
/// @dev No keys, broadcasts, protocol mocks/etches or live writes. Missing both
/// BSC_FORK_RPC and BSC_FORK_BLOCK produces a genuine skip, never a passing stub.
/// The fork EVM is Cancun; our compiled artifacts remain pinned to Shanghai.
contract LPForkTest is Test {
    address private constant OWNER = address(0xA11CE);
    address private constant AIKI_MANAGER = 0x625cfdA19d2F4424e546B610B4CeF1F5441F84c9;
    address private constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address private constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address private constant FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address private constant NFPM = 0x46A15B0b27311cedF172AB29E4f4766fbE7F4364;
    address private constant ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    // Public balance donor impersonated ONLY inside Foundry's isolated fork.
    address private constant LOCAL_DONOR = 0xF977814e90dA44bFA03b6295A0616a897441aceC;
    uint24 private constant FEE = 500;
    LPForkVm private constant forkVm = LPForkVm(address(vm));
    AiKiMandateAccount private controller;
    PancakeLPVault private vault;
    address private pool;
    int24 private center;
    int24 private width;
    uint256 private originalId;

    function setUp() public {
        string memory rpc = forkVm.envOr("BSC_FORK_RPC", string(""));
        uint256 forkBlock = forkVm.envOr("BSC_FORK_BLOCK", uint256(0));
        if (bytes(rpc).length == 0 && forkBlock == 0) {
            forkVm.skip(true);
            return;
        }
        require(bytes(rpc).length != 0 && forkBlock != 0, "Set both BSC_FORK_RPC and BSC_FORK_BLOCK");
        vm.createSelectFork(rpc, forkBlock);
        forkVm.setEvmVersion("cancun");
        assertEq(block.chainid, 56, "not BNB mainnet");
        assertEq(block.number, forkBlock, "fork must be pinned");
        emit log_named_uint("lp_fork_block", forkBlock);
        pool = ILPFactory(FACTORY).getPool(USDT, WBNB, FEE);
        assertEq(pool, 0x36696169C63e42cd08ce11f5deeBbCeBae652050, "unexpected reviewed pool");
        assertEq(ILPPool(pool).token0(), USDT, "quote token must be token0");
        assertEq(ILPPool(pool).token1(), WBNB, "base token must be token1");
        int24 spacing = ILPPool(pool).tickSpacing();
        (, int24 twap,) = PancakeOracle.checkedState(pool, 300, 200, 1e12);
        center = (twap / spacing) * spacing;
        if (twap < 0 && twap % spacing != 0) center -= spacing;
        width = spacing * 120;
        controller = new AiKiMandateAccount(OWNER, AIKI_MANAGER);
        vault = new PancakeLPVault(
            address(controller),
            StrategyVaultBase.CommonPolicy(uint64(forkVm.getBlockTimestamp() + 1 days), 1, 120),
            PancakeLPVault.Protocol(NFPM, ROUTER, pool, USDT),
            PancakeLPVault.LPPolicy({
                twapWindow: 300,
                maxDeviationTicks: 200,
                minPoolLiquidity: 1e12,
                rangeWidth: width,
                maxCenterOffsetTicks: uint24(spacing),
                maxSwapSlippageBps: 100,
                maxLiquiditySlippageBps: 100,
                minSwapFillBps: 9500,
                minDeployedBps: 7000,
                maxLossBps: 100,
                maxSwap0: 1000 ether,
                maxSwap1: 10 ether,
                maxPositionValueQuote: 5000 ether,
                maxLossQuote: 1 ether,
                maxCumulativeLossQuote: 10 ether
            })
        );
        assertTrue(address(vault).code.length <= 24576, "vault runtime exceeds EIP-170");
        assertTrue(LPForkToken(USDT).balanceOf(LOCAL_DONOR) >= 500 ether, "local donor lacks USDT");
        vm.prank(LOCAL_DONOR);
        assertTrue(LPForkToken(USDT).transfer(OWNER, 500 ether), "local USDT funding failed");
        vm.deal(OWNER, 2 ether);
        vm.prank(OWNER);
        LPForkToken(WBNB).deposit{value: 1 ether}();
        vm.startPrank(OWNER);
        assertTrue(LPForkToken(USDT).approve(NFPM, 500 ether), "local seed approval failed");
        assertTrue(LPForkToken(WBNB).approve(NFPM, 1 ether), "local seed approval failed");
        vm.stopPrank();
    }

    // 0: in-range balanced NFT; 1: token0-only above spot; 2: token1-only below spot.
    function _seedAndEnroll(uint8 mode) private {
        int24 lower = center - width / 2;
        int24 upper = center + width / 2;
        if (mode == 1) {
            lower = center + width;
            upper = center + width * 2;
        }
        if (mode == 2) {
            lower = center - width * 2;
            upper = center - width;
        }
        uint256 desired0 = mode == 2 ? 0 : 100 ether;
        uint256 desired1 = mode == 1 ? 0 : 0.1 ether;
        (uint160 sqrtPrice,,,,,,) = IPancakeOraclePool(pool).slot0();
        uint128 expectedLiquidity = PancakeMath.liquidityForAmounts(
            sqrtPrice,
            PancakeMath.sqrtRatioAtTick(lower),
            PancakeMath.sqrtRatioAtTick(upper),
            desired0,
            desired1
        );
        (uint256 expected0, uint256 expected1) = PancakeMath.amountsForLiquidity(
            sqrtPrice,
            PancakeMath.sqrtRatioAtTick(lower),
            PancakeMath.sqrtRatioAtTick(upper),
            expectedLiquidity
        );
        vm.prank(OWNER);
        (originalId,,,) = LPForkNFPM(NFPM)
            .mint(
                ILPPositionManager.MintParams(
                    USDT,
                    WBNB,
                    FEE,
                    lower,
                    upper,
                    desired0,
                    desired1,
                    expected0 * 99 / 100,
                    expected1 * 99 / 100,
                    OWNER,
                    forkVm.getBlockTimestamp() + 60
                )
            );
        assertEq(LPForkNFPM(NFPM).ownerOf(originalId), OWNER, "real NFT mint missing");
        vm.prank(OWNER);
        LPForkNFPM(NFPM).approve(address(vault), originalId);
        vm.prank(OWNER);
        vault.enroll(originalId);
        assertEq(LPForkNFPM(NFPM).ownerOf(originalId), address(vault), "real enrollment custody missing");
        assertTrue(vault.paused(), "funding auto-activated strategy");
        vm.prank(OWNER);
        vault.resume();
    }

    function _plan(uint8 mode) private view returns (PancakeLPVault.RebalancePlan memory p) {
        p.expectedNonce = vault.operationNonce();
        p.expectedTokenId = originalId;
        p.tickLower = center - width / 2;
        p.tickUpper = center + width / 2;
        p.minLiquidity = 1;
        p.deadline = forkVm.getBlockTimestamp() + 60;
        if (mode != 0) {
            ILPPositionManager.Position memory old = LPForkNFPM(NFPM).positions(originalId);
            (uint160 sqrtPrice,,,,,,) = IPancakeOraclePool(pool).slot0();
            (uint256 amount0, uint256 amount1) = PancakeMath.amountsForLiquidity(
                sqrtPrice,
                PancakeMath.sqrtRatioAtTick(old.tickLower),
                PancakeMath.sqrtRatioAtTick(old.tickUpper),
                old.liquidity
            );
            p.zeroForOne = mode == 1;
            p.swapAmount = uint128((p.zeroForOne ? amount0 : amount1) / 2);
            (, int24 twap,) = PancakeOracle.checkedState(pool, 300, 200, 1e12);
            p.sqrtPriceLimitX96 =
                PancakeMath.sqrtRatioAtTick(twap + (p.zeroForOne ? int24(-100) : int24(100)));
        }
    }

    function _executeAndVerify(PancakeLPVault.RebalancePlan memory p) private {
        forkVm.recordLogs();
        vm.prank(OWNER);
        controller.execute(address(vault), 0, abi.encodeCall(vault.rebalance, (p)));
        uint256 replacement = vault.currentTokenId();
        assertTrue(replacement != originalId && replacement != 0, "NFT was not replaced");
        assertEq(LPForkNFPM(NFPM).ownerOf(replacement), address(vault), "replacement escaped custody");
        ILPPositionManager.Position memory next = LPForkNFPM(NFPM).positions(replacement);
        assertEq(next.liquidity, vault.positionLiquidity(), "stored liquidity differs from real NFT");
        assertTrue(next.liquidity > 0, "no actual liquidity deployed");
        assertEq(
            uint256(int256(next.tickLower) + 887272),
            uint256(int256(p.tickLower) + 887272),
            "wrong lower tick"
        );
        assertEq(
            uint256(int256(next.tickUpper) + 887272),
            uint256(int256(p.tickUpper) + 887272),
            "wrong upper tick"
        );
        vm.expectRevert();
        LPForkNFPM(NFPM).ownerOf(originalId);
        assertEq(vault.operationNonce(), p.expectedNonce + 1, "nonce not advanced exactly once");
        assertTrue(vault.cumulativeLossQuote() <= 1 ether, "unexpected operation loss");
        assertEq(LPForkToken(USDT).allowance(address(vault), NFPM), 0, "USDT mint approval leaked");
        assertEq(LPForkToken(WBNB).allowance(address(vault), NFPM), 0, "WBNB mint approval leaked");
        assertEq(LPForkToken(USDT).allowance(address(vault), ROUTER), 0, "USDT swap approval leaked");
        assertEq(LPForkToken(WBNB).allowance(address(vault), ROUTER), 0, "WBNB swap approval leaked");
        LPForkVm.Log[] memory logs = forkVm.getRecordedLogs();
        bool transition;
        for (uint256 i; i < logs.length; i++) {
            if (
                logs[i].emitter == address(vault)
                    && logs[i].topics[0]
                        == keccak256(
                            "Rebalanced(bytes32,uint256,uint256,uint256,uint128,uint256,uint256,uint256,uint256,uint256)"
                        )
            ) {
                assertFalse(transition, "duplicate transition");
                transition = true;
                assertEq(logs[i].topics[1], vault.policyHash(), "wrong event policy");
                assertEq(uint256(logs[i].topics[2]), p.expectedNonce + 1, "wrong event nonce");
                assertEq(uint256(logs[i].topics[3]), originalId, "wrong event old NFT");
                (uint256 eventId,, uint256 paid, uint256 received,,,) =
                    abi.decode(logs[i].data, (uint256, uint128, uint256, uint256, uint256, uint256, uint256));
                assertEq(eventId, replacement, "wrong event replacement");
                assertTrue(
                    p.swapAmount == 0 ? paid == 0 && received == 0 : paid > 0 && received > 0,
                    "event does not prove expected swap branch"
                );
            }
        }
        assertTrue(transition, "no exact strategy transition event");
    }

    function test_Fork_RealZeroSwapReplacementAndOwnerRecovery() public {
        _seedAndEnroll(0);
        _executeAndVerify(_plan(0));
        uint256 id = vault.currentTokenId();
        vm.prank(OWNER);
        vault.pause();
        vm.warp(uint256(vault.expiresAt()) + 1);
        vm.prank(OWNER);
        vault.withdrawPosition();
        assertEq(LPForkNFPM(NFPM).ownerOf(id), OWNER, "owner NFT recovery failed");
        assertEq(vault.currentTokenId(), 0, "vault not closed");
        assertTrue(vault.paused(), "recovery restarted automation");
    }

    function test_Fork_RealToken0ToToken1SwapAndReplacement() public {
        _seedAndEnroll(1);
        _executeAndVerify(_plan(1));
    }

    function test_Fork_RealToken1ToToken0SwapAndReplacement() public {
        _seedAndEnroll(2);
        _executeAndVerify(_plan(2));
    }
}
