// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "../base/Test.sol";
import {AiKiMandateAccount} from "../../src/account/AiKiMandateAccount.sol";
import {StrategyVaultBase} from "../../src/strategies/StrategyVaultBase.sol";
import {GridStrategyVault} from "../../src/strategies/grid/GridStrategyVault.sol";
import {IGridFactory, IGridRouter} from "../../src/strategies/grid/GridInterfaces.sol";
import {PancakeMath} from "../../src/strategies/pancake/PancakeMath.sol";
import {PancakeOracle} from "../../src/strategies/pancake/PancakeOracle.sol";

interface GridForkVm {
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function envOr(string calldata name, uint256 defaultValue) external returns (uint256);
    function skip(bool skipTest) external;
    function getBlockTimestamp() external view returns (uint256);
    function setEvmVersion(string calldata evm) external;
}

interface GridForkToken {
    function balanceOf(address who) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function deposit() external payable;
}

interface GridForkPool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint32, bool);
}

/// @notice Opt-in real Pancake V3 swaps in a pinned LOCAL BNB mainnet fork.
/// @dev Both BSC_FORK_RPC and BSC_FORK_BLOCK are required. Both missing -> genuine skip;
/// exactly one missing -> failure. No signing keys, broadcasts, mocked pool/token code,
/// storage edits, synthetic oracle ticks or latest-block fallback.
/// Pool movements below are real router swaps by a LOCAL fixture trader, not vault authority.
contract GridForkTest is Test {
    address private constant OWNER = address(0xA11CE);
    address private constant LOCAL_TRADER = address(0xB0B);
    address private constant LOCAL_DONOR = 0xF977814e90dA44bFA03b6295A0616a897441aceC;
    address private constant MANAGER = 0x625cfdA19d2F4424e546B610B4CeF1F5441F84c9;
    bytes32 private constant MANAGER_HASH =
        0x92a458ba7578f05c7a2bb8b21d40165309b3d10d1c75df5cdf2aec9db7880689;
    address private constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address private constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    // Original V3 contracts, per https://developer.pancakeswap.finance/contracts/v3/addresses
    address private constant FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address private constant ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    // Independently resolved from FACTORY.getPool(USDT,WBNB,500) at block 121004566.
    address private constant POOL = 0x36696169C63e42cd08ce11f5deeBbCeBae652050;
    GridForkVm private constant forkVm = GridForkVm(address(vm));
    AiKiMandateAccount private controller;
    GridStrategyVault private vault;
    int24 private initialTick;
    uint128 private quoteLot;

    function setUp() public {
        string memory rpc = forkVm.envOr("BSC_FORK_RPC", string(""));
        uint256 forkBlock = forkVm.envOr("BSC_FORK_BLOCK", uint256(0));
        if (bytes(rpc).length == 0 && forkBlock == 0) {
            forkVm.skip(true);
            return;
        }
        require(bytes(rpc).length != 0 && forkBlock != 0, "Set both BSC_FORK_RPC and BSC_FORK_BLOCK");
        vm.createSelectFork(rpc, forkBlock);
        // Fork execution may encounter Cancun upstream bytecode. This does NOT change
        // foundry.toml or AiKi's pinned Shanghai compilation/deployment artifacts.
        forkVm.setEvmVersion("cancun");
        assertEq(block.chainid, 56, "not BNB mainnet");
        assertEq(block.number, forkBlock, "fork is not pinned");
        assertEq(MANAGER.codehash, MANAGER_HASH, "unreviewed account manager");
        assertEq(IGridFactory(FACTORY).getPool(USDT, WBNB, 500), POOL, "wrong canonical pool");
        emit log_named_uint("grid_fork_block", forkBlock);
        emit log_named_address("grid_fork_pool", POOL);
        (, initialTick,,,,,) = GridForkPool(POOL).slot0();
        uint256 quoted = PancakeMath.quoteAtTick(initialTick, 100 ether, USDT, WBNB);
        require(quoted > 0 && quoted < type(uint128).max, "unusable quote lot");
        quoteLot = uint128(quoted);
        // Require real retained history now, before creating/funding the local strategy.
        PancakeOracle.checkedState(POOL, 60, 500, 1);
        controller = new AiKiMandateAccount(OWNER, MANAGER);
        GridStrategyVault.RungPolicy[] memory rungs = new GridStrategyVault.RungPolicy[](1);
        rungs[0] =
            GridStrategyVault.RungPolicy(initialTick - 40, initialTick + 40, 100 ether, quoteLot, false);
        vault = new GridStrategyVault(
            address(controller),
            StrategyVaultBase.CommonPolicy(uint64(forkVm.getBlockTimestamp() + 1 days), 1, 120),
            GridStrategyVault.Protocol(ROUTER, FACTORY, POOL, USDT, WBNB),
            GridStrategyVault.GridPolicy({
                tickLower: initialTick - 500,
                tickUpper: initialTick + 500,
                maxInput0: 100 ether,
                maxInput1: quoteLot,
                fundingCap0: 1_000 ether,
                fundingCap1: uint256(quoteLot) * 10,
                turnoverCap0: 1_000 ether,
                turnoverCap1: uint256(quoteLot) * 10,
                twapWindow: 60,
                maxDeviationTicks: 500,
                minLiquidity: 1,
                maxSlippageBps: 5,
                minFillBps: 5_000,
                minCycleGainBps: 1,
                hysteresisTicks: 5
            }),
            rungs
        );
        // Impersonation is local EVM fixture setup only; no signed or broadcast transfer.
        assertTrue(GridForkToken(USDT).balanceOf(LOCAL_DONOR) >= 2_001_000 ether, "local donor lacks USDT");
        vm.prank(LOCAL_DONOR);
        assertTrue(GridForkToken(USDT).transfer(OWNER, 1_000 ether), "owner USDT funding failed");
        vm.prank(LOCAL_DONOR);
        assertTrue(GridForkToken(USDT).transfer(LOCAL_TRADER, 2_000_000 ether), "fixture USDT funding failed");
        vm.deal(OWNER, uint256(quoteLot) * 10);
        vm.prank(OWNER);
        GridForkToken(WBNB).deposit{value: uint256(quoteLot) * 10}();
        vm.deal(LOCAL_TRADER, 5_000 ether);
        vm.prank(LOCAL_TRADER);
        GridForkToken(WBNB).deposit{value: 5_000 ether}();
        vm.startPrank(OWNER);
        assertTrue(GridForkToken(USDT).approve(address(vault), 1_000 ether), "USDT funding approval failed");
        assertTrue(
            GridForkToken(WBNB).approve(address(vault), uint256(quoteLot) * 10),
            "WBNB funding approval failed"
        );
        vault.fund(0, 1_000 ether, uint256(quoteLot) * 10);
        vault.resume();
        vm.stopPrank();
    }

    function _pass() private returns (bool filled) {
        uint256 nonce = vault.operationNonce();
        vm.warp(forkVm.getBlockTimestamp() + 2);
        uint256 deadline = forkVm.getBlockTimestamp() + 60;
        vm.prank(OWNER);
        bytes memory result = controller.execute(
            address(vault), 0, abi.encodeCall(vault.execute, (nonce, deadline, uint32(0)))
        );
        filled = abi.decode(result, (bool));
        assertEq(GridForkToken(USDT).allowance(address(vault), ROUTER), 0, "USDT router approval leaked");
        assertEq(GridForkToken(WBNB).allowance(address(vault), ROUTER), 0, "WBNB router approval leaked");
    }

    /// @dev Drive actual local-fork pool crossings without mutating any pool storage/code.
    function _shiftTo(int24 target) private {
        (, int24 beforeTick,,,,,) = GridForkPool(POOL).slot0();
        bool zeroForOne = target < beforeTick;
        address input = zeroForOne ? USDT : WBNB;
        address output = zeroForOne ? WBNB : USDT;
        uint256 amount = GridForkToken(input).balanceOf(LOCAL_TRADER);
        vm.warp(forkVm.getBlockTimestamp() + 2);
        vm.startPrank(LOCAL_TRADER);
        assertTrue(GridForkToken(input).approve(ROUTER, amount), "fixture swap approval failed");
        uint256 received = IGridRouter(ROUTER)
            .exactInputSingle(
                IGridRouter.ExactInputSingleParams({
                tokenIn: input,
                tokenOut: output,
                fee: 500,
                recipient: LOCAL_TRADER,
                deadline: forkVm.getBlockTimestamp() + 60,
                amountIn: amount,
                amountOutMinimum: 1,
                sqrtPriceLimitX96: PancakeMath.sqrtRatioAtTick(target)
            })
            );
        assertTrue(GridForkToken(input).approve(ROUTER, 0), "fixture approval cleanup failed");
        vm.stopPrank();
        assertTrue(received > 0, "fixture price-moving swap absent");
        (uint160 sqrtAfter,,,,,,) = GridForkPool(POOL).slot0();
        assertEq(sqrtAfter, PancakeMath.sqrtRatioAtTick(target), "fixture did not reach target price");
    }

    function _inventoryMatches() private view {
        GridStrategyVault.RungState memory r = vault.rungState(0);
        assertEq(r.inventory0, vault.allocated0(), "USDT lot accounting mismatch");
        assertEq(r.inventory1, vault.allocated1(), "WBNB lot accounting mismatch");
        assertEq(r.inventory0, GridForkToken(USDT).balanceOf(address(vault)), "USDT custody mismatch");
        assertEq(r.inventory1, GridForkToken(WBNB).balanceOf(address(vault)), "WBNB custody mismatch");
        assertEq(GridForkToken(USDT).balanceOf(address(controller)), 0, "output escaped to controller");
        assertEq(GridForkToken(WBNB).balanceOf(address(controller)), 0, "output escaped to controller");
    }

    function test_Fork_RealBothDirectionFillsAndPersistentCycle() public {
        assertFalse(_pass(), "activation traded historical crossing");
        uint256 quoteBefore = vault.allocated1();
        uint256 baseBefore = vault.allocated0();
        _shiftTo(initialTick - 50);
        assertTrue(_pass(), "real WBNB-to-USDT buy missing");
        assertTrue(vault.allocated0() > baseBefore && vault.allocated1() < quoteBefore, "buy deltas wrong");
        emit log_named_uint("grid_buy_WBNB_input", quoteBefore - vault.allocated1());
        emit log_named_uint("grid_buy_USDT_output", vault.allocated0() - baseBefore);
        assertEq(vault.turnover1(), quoteBefore - vault.allocated1(), "actual quote turnover wrong");
        assertTrue(vault.rungState(0).nextSell, "buy was not persisted");
        _inventoryMatches();
        assertFalse(_pass(), "same-price replay traded again");
        _shiftTo(initialTick + 50);
        quoteBefore = vault.allocated1();
        baseBefore = vault.allocated0();
        assertTrue(_pass(), "real USDT-to-WBNB sell missing");
        assertTrue(vault.allocated0() < baseBefore && vault.allocated1() > quoteBefore, "sell deltas wrong");
        emit log_named_uint("grid_sell_USDT_input", baseBefore - vault.allocated0());
        emit log_named_uint("grid_sell_WBNB_output", vault.allocated1() - quoteBefore);
        assertEq(vault.turnover0(), baseBefore - vault.allocated0(), "actual base turnover wrong");
        assertEq(vault.rungState(0).cycle, 1, "round-trip cycle not persisted");
        _inventoryMatches();
        assertFalse(_pass(), "same-price post-cycle replay traded");
    }

    function test_Fork_NoHistoricalCatchupAndOwnerRecoveryAfterExpiry() public {
        _shiftTo(initialTick - 50);
        assertFalse(_pass(), "initial below-grid observation traded");
        assertFalse(_pass(), "unarmed historical crossing traded");
        vm.prank(OWNER);
        vault.pause();
        vm.warp(uint256(vault.expiresAt()) + 1);
        uint256 base = vault.allocated0();
        uint256 quote = vault.allocated1();
        vm.prank(OWNER);
        vault.withdraw(0, base, quote, OWNER);
        assertEq(vault.allocated0(), 0, "expired base recovery failed");
        assertEq(vault.allocated1(), 0, "expired quote recovery failed");
        assertEq(GridForkToken(USDT).balanceOf(OWNER), base, "owner did not receive USDT");
        assertEq(GridForkToken(WBNB).balanceOf(OWNER), quote, "owner did not receive WBNB");
        assertTrue(vault.paused(), "recovery restarted strategy");
    }

    function test_Fork_OwnerWithdrawalInvalidatesAlreadyArmedOperation() public {
        assertFalse(_pass(), "baseline unexpectedly filled");
        uint256 nonce = vault.operationNonce();
        vm.prank(OWNER);
        vault.withdraw(0, 1 ether, 0, OWNER);
        _shiftTo(initialTick - 50);
        vm.warp(forkVm.getBlockTimestamp() + 2);
        uint256 deadline = forkVm.getBlockTimestamp() + 60;
        vm.prank(OWNER);
        vm.expectRevert(StrategyVaultBase.StaleStrategyNonce.selector);
        controller.execute(address(vault), 0, abi.encodeCall(vault.execute, (nonce, deadline, uint32(0))));
        assertFalse(_pass(), "owner edit did not force fresh baseline");
        assertEq(vault.turnover0(), 0, "base spent on stale operation");
        assertEq(vault.turnover1(), 0, "quote spent on stale operation");
        _inventoryMatches();
    }
}
