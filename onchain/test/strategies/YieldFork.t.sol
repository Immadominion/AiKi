// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "../base/Test.sol";
import {AiKiMandateAccount} from "../../src/account/AiKiMandateAccount.sol";
import {StrategyVaultBase} from "../../src/strategies/StrategyVaultBase.sol";
import {YieldAllocationVault} from "../../src/strategies/yield/YieldAllocationVault.sol";
import {YieldVaultFactory} from "../../src/strategies/yield/YieldVaultFactory.sol";
import {IYieldAToken} from "../../src/strategies/yield/YieldInterfaces.sol";

interface YieldForkVm {
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function envOr(string calldata name, uint256 defaultValue) external returns (uint256);
    function skip(bool skipTest) external;
    function getBlockTimestamp() external view returns (uint256);
    function setEvmVersion(string calldata evm) external;
}

interface YieldForkToken {
    function balanceOf(address who) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract YieldForgedController {
    address public owner;
    address public DELEGATION_MANAGER;

    constructor(address owner_, address manager_) {
        owner = owner_;
        DELEGATION_MANAGER = manager_;
    }
}

/// @notice Opt-in actual protocol interactions on a pinned LOCAL mainnet fork.
/// @dev No keys, broadcasts, latest-block fallback, mock protocol code or live writes.
/// Run with BOTH BSC_FORK_RPC and BSC_FORK_BLOCK. Missing both reports a genuine skip.
contract YieldForkTest is Test {
    address private constant OWNER = address(0xA11CE);
    address private constant MANAGER = 0x625cfdA19d2F4424e546B610B4CeF1F5441F84c9;
    address private constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address private constant VENUS = 0xfD5840Cd36d94D7229439859C0112a4185BC0255;
    address private constant AAVE = 0x6807dc923806fE8Fd134338EABCA509979a7e0cB;
    address private constant RECEIPT = 0xa9251ca9DE909CB71783723713B21E4233fbf1B1;
    // Binance's public hot wallet is used ONLY as a local-fork balance donor.
    address private constant LOCAL_DONOR = 0xF977814e90dA44bFA03b6295A0616a897441aceC;
    YieldForkVm private constant forkVm = YieldForkVm(address(vm));
    AiKiMandateAccount private controller;
    YieldVaultFactory private factory;
    YieldAllocationVault private vault;

    function setUp() public {
        string memory rpc = forkVm.envOr("BSC_FORK_RPC", string(""));
        uint256 forkBlock = forkVm.envOr("BSC_FORK_BLOCK", uint256(0));
        if (bytes(rpc).length == 0 && forkBlock == 0) {
            forkVm.skip(true);
            return;
        }
        require(bytes(rpc).length != 0 && forkBlock != 0, "Set both BSC_FORK_RPC and BSC_FORK_BLOCK");
        vm.createSelectFork(rpc, forkBlock);
        // Execute upstream deployed Cancun bytecode without recompiling AiKi's reviewed
        // Shanghai artifacts. In particular Venus's current interest model uses newer
        // instructions; running it under Shanghai produces NotActivated, not a venue error.
        forkVm.setEvmVersion("cancun");
        assertEq(block.chainid, 56, "not BNB mainnet");
        assertEq(block.number, forkBlock, "fork is not pinned");
        emit log_named_uint("yield_fork_block", forkBlock);
        controller = new AiKiMandateAccount(OWNER, MANAGER);
        factory = new YieldVaultFactory(MANAGER, address(controller).codehash);
        vm.prank(OWNER);
        vault = factory.createForController(address(controller), _common(), _policy());

        // vm.prank changes only Foundry's local EVM sender. It cannot sign or broadcast.
        assertTrue(YieldForkToken(USDT).balanceOf(LOCAL_DONOR) >= 1_000 ether, "local donor lacks USDT");
        vm.prank(LOCAL_DONOR);
        assertTrue(YieldForkToken(USDT).transfer(OWNER, 1_000 ether), "local funding failed");
        vm.prank(OWNER);
        assertTrue(YieldForkToken(USDT).approve(address(vault), 1_000 ether), "funding approval failed");
        vm.prank(OWNER);
        vault.fund(1_000 ether);
        vm.prank(OWNER);
        vault.resume();
    }

    function _common() private view returns (StrategyVaultBase.CommonPolicy memory) {
        return StrategyVaultBase.CommonPolicy(uint64(forkVm.getBlockTimestamp() + 1 days), 1, 300);
    }

    function _policy() private pure returns (YieldAllocationVault.YieldPolicy memory) {
        return YieldAllocationVault.YieldPolicy(
            1_000 ether, 500 ether, 2_000 ether, 100 ether, 800 ether, 800 ether, 0.001 ether, 0.01 ether, 1
        );
    }

    function _move(uint8 source, uint8 destination, uint256 amount) private {
        uint256 nonce = vault.operationNonce();
        vm.warp(forkVm.getBlockTimestamp() + 2);
        uint256 deadline = forkVm.getBlockTimestamp() + 60;
        // Exercise the controller's real owner-call path; delegation integration is tested
        // separately by the binding-enforcer suite. Never impersonate a protocol implementation.
        vm.prank(OWNER);
        controller.execute(
            address(vault),
            0,
            abi.encodeCall(vault.reallocate, (source, destination, amount, 0, nonce, deadline))
        );
        assertEq(YieldForkToken(USDT).allowance(address(vault), VENUS), 0, "Venus approval leaked");
        assertEq(YieldForkToken(USDT).allowance(address(vault), AAVE), 0, "Aave approval leaked");
    }

    function test_Fork_RealMintSupplyRedeemWithdrawBothDirections() public {
        _move(0, 1, 400 ether);
        assertTrue(YieldForkToken(VENUS).balanceOf(address(vault)) > 0, "real Venus mint missing");
        _move(1, 2, 300 ether);
        assertTrue(IYieldAToken(RECEIPT).scaledBalanceOf(address(vault)) > 0, "real Aave supply missing");
        _move(2, 1, 200 ether);
        _move(1, 0, 200 ether);
        _move(2, 0, 50 ether);
        assertTrue(vault.managedIdle() >= 849.999 ether, "unexpected underlying loss");
        assertTrue(vault.cumulativeLoss() <= 0.01 ether, "loss budget bypass");
        assertEq(vault.turnover(), 900 ether, "both-directions turnover wrong");
    }

    function test_Fork_OwnerRecoversRealReceiptTokensAfterPauseAndExpiry() public {
        _move(0, 1, 200 ether);
        _move(0, 2, 200 ether);
        uint256 venusBalance = YieldForkToken(VENUS).balanceOf(address(vault));
        uint256 aaveBalance = YieldForkToken(RECEIPT).balanceOf(address(vault));
        vm.prank(OWNER);
        vault.pause();
        vm.warp(forkVm.getBlockTimestamp() + 2 days);
        vm.prank(OWNER);
        vault.recover(VENUS, venusBalance);
        vm.prank(OWNER);
        vault.recover(RECEIPT, aaveBalance / 2);
        vm.prank(OWNER);
        vault.recover(USDT, 600 ether);
        assertTrue(YieldForkToken(VENUS).balanceOf(OWNER) >= venusBalance, "Venus receipt recovery failed");
        assertTrue(YieldForkToken(RECEIPT).balanceOf(OWNER) > 0, "Aave receipt recovery failed");
        assertEq(vault.managedIdle(), 0, "idle recovery accounting wrong");
        assertTrue(vault.paused(), "recovery resumed automation");
    }

    function test_Fork_FactoryRejectsForgedRuntimeWrongManagerAndForeignOwner() public {
        YieldForgedController forged = new YieldForgedController(OWNER, MANAGER);
        vm.prank(OWNER);
        vm.expectRevert(YieldVaultFactory.UnreviewedController.selector);
        factory.createForController(address(forged), _common(), _policy());
        AiKiMandateAccount wrong = new AiKiMandateAccount(OWNER, address(0xBAD));
        vm.prank(OWNER);
        vm.expectRevert(YieldVaultFactory.UnreviewedController.selector);
        factory.createForController(address(wrong), _common(), _policy());
        vm.prank(address(0xBAD));
        vm.expectRevert(YieldVaultFactory.NotControllerOwner.selector);
        factory.createForController(address(controller), _common(), _policy());
        vm.expectRevert(YieldVaultFactory.InvalidFactoryConfiguration.selector);
        new YieldVaultFactory(MANAGER, address(forged).codehash);
        assertTrue(factory.isVault(address(vault)), "created vault not registered");
        assertEq(vault.underlying(), USDT, "underlying is not canonical");
        assertEq(vault.venus(), VENUS, "Venus is not canonical");
        assertEq(vault.aavePool(), AAVE, "Aave is not canonical");
        vm.prank(OWNER);
        controller.transferOwnership(address(0xB0B));
        vm.prank(OWNER);
        vm.expectRevert(YieldVaultFactory.NotControllerOwner.selector);
        factory.createForController(address(controller), _common(), _policy());
        vm.prank(address(0xB0B));
        YieldAllocationVault second = factory.createForController(address(controller), _common(), _policy());
        assertTrue(factory.isVault(address(second)), "current owner cannot create");
    }
}
