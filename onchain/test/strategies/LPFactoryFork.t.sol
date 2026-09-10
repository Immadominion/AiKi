// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "../base/Test.sol";
import {AiKiMandateAccount} from "../../src/account/AiKiMandateAccount.sol";
import {StrategyVaultBase} from "../../src/strategies/StrategyVaultBase.sol";
import {PancakeLPVault} from "../../src/strategies/lp/PancakeLPVault.sol";
import {LPVaultFactory} from "../../src/strategies/lp/LPVaultFactory.sol";

interface LPFactoryForkVm {
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

contract LPFactoryForgedController {
    address public owner;
    address public DELEGATION_MANAGER;

    constructor(address owner_, address manager_) {
        owner = owner_;
        DELEGATION_MANAGER = manager_;
    }
}

contract LPFactoryWrongPool {
    function factory() external pure returns (address) {
        return 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    }

    function token0() external pure returns (address) {
        return 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    }

    function token1() external pure returns (address) {
        return 0x55d398326f99059fF775485246999027B3197955;
    }

    function fee() external pure returns (uint24) {
        return 500;
    }
}

/// @notice Opt-in LOCAL BSC fork. Positive cases use real canonical Pancake/manager code.
/// Negative cases deliberately corrupt local code to prove fail-closed registration.
/// No keys, broadcasts, funding or live writes. Requires an explicit RPC AND block pin.
contract LPFactoryForkTest is Test {
    address private constant OWNER = address(0xA11CE);
    address private constant NEXT_OWNER = address(0xB0B);
    address private constant MANAGER = 0x625cfdA19d2F4424e546B610B4CeF1F5441F84c9;
    LPFactoryForkVm private constant forkVm = LPFactoryForkVm(address(vm));
    LPVaultFactory private factory;
    AiKiMandateAccount private controller;
    StrategyVaultBase.CommonPolicy private common;
    PancakeLPVault.LPPolicy private policy;

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
        controller = new AiKiMandateAccount(OWNER, MANAGER);
        factory = new LPVaultFactory(MANAGER, address(controller).codehash);
        common = StrategyVaultBase.CommonPolicy(uint64(forkVm.getBlockTimestamp() + 1 days), 60, 120);
        policy = PancakeLPVault.LPPolicy({
            twapWindow: 300,
            maxDeviationTicks: 200,
            minPoolLiquidity: 1e12,
            rangeWidth: 1200,
            maxCenterOffsetTicks: 10,
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
        });
    }

    function _create() private returns (PancakeLPVault vault) {
        bytes memory creationCode = type(PancakeLPVault).creationCode;
        vm.prank(OWNER);
        return factory.createForController(address(controller), common, policy, creationCode);
    }

    function _predict() private view returns (address) {
        return
            factory.predictForController(
                address(controller), common, policy, type(PancakeLPVault).creationCode
            );
    }

    function test_Fork_CreatesPinnedCanonicalPausedVaultAndRegistersExactEvent() public {
        address predicted = _predict();
        forkVm.recordLogs();
        PancakeLPVault vault = _create();
        assertEq(address(vault), predicted, "CREATE2 prediction mismatch");
        assertTrue(factory.isVault(predicted), "vault not registered");
        assertEq(factory.registeredRuntimeHash(predicted), predicted.codehash, "runtime not registered");
        assertEq(vault.controller(), address(controller), "wrong controller");
        assertEq(
            vault.policyHash(),
            factory.expectedPolicyHash(address(controller), common, policy),
            "wrong policy"
        );
        assertEq(address(vault.positionManager()), factory.POSITION_MANAGER(), "wrong NFPM");
        assertEq(address(vault.router()), factory.ROUTER(), "wrong router");
        assertEq(vault.pool(), factory.POOL(), "wrong pool");
        assertEq(vault.token0(), factory.USDT(), "wrong token0");
        assertEq(vault.token1(), factory.WBNB(), "wrong token1");
        assertEq(vault.quoteToken(), factory.USDT(), "wrong quote token");
        assertTrue(vault.paused(), "creation auto-resumed");
        assertEq(vault.operationNonce(), 0, "creation changed nonce");
        assertFalse(vault.enrolled(), "creation enrolled an NFT");
        assertTrue(address(factory).code.length <= 24576, "factory runtime exceeds EIP-170");
        assertTrue(address(vault).code.length <= 24576, "vault runtime exceeds EIP-170");
        LPFactoryForkVm.Log[] memory logs = forkVm.getRecordedLogs();
        assertEq(logs.length, 1, "unexpected creation events");
        assertEq(logs[0].emitter, address(factory), "wrong event emitter");
        assertEq(
            logs[0].topics[0],
            keccak256("LPVaultCreated(address,address,bytes32,address)"),
            "wrong event kind"
        );
        assertEq(address(uint160(uint256(logs[0].topics[1]))), predicted, "wrong event vault");
        assertEq(address(uint160(uint256(logs[0].topics[2]))), address(controller), "wrong event controller");
        assertEq(logs[0].topics[3], vault.policyHash(), "wrong event policy");
        assertEq(abi.decode(logs[0].data, (address)), OWNER, "wrong event owner");
    }

    function test_Fork_ExactRetryReturnsExistingWithoutEventsOrStateReset() public {
        PancakeLPVault first = _create();
        vm.prank(OWNER);
        first.resume();
        uint256 nonce = first.operationNonce();
        forkVm.recordLogs();
        PancakeLPVault retry = _create();
        assertEq(address(first), address(retry), "retry deployed twice");
        assertFalse(retry.paused(), "retry changed pause state");
        assertEq(retry.operationNonce(), nonce, "retry reset nonce");
        assertEq(forkVm.getRecordedLogs().length, 0, "retry emitted false creation event");
        vm.warp(uint256(first.expiresAt()) + 1);
        retry = _create();
        assertEq(address(first), address(retry), "expired retry redeployed");
        assertEq(retry.operationNonce(), nonce, "expired retry changed state");
    }

    function test_Fork_ChangedPolicyAndOwnerHaveDistinctAddresses() public {
        PancakeLPVault first = _create();
        PancakeLPVault.LPPolicy memory changed = policy;
        changed.maxLossQuote = 2 ether;
        vm.prank(OWNER);
        PancakeLPVault second = factory.createForController(
            address(controller), common, changed, type(PancakeLPVault).creationCode
        );
        assertTrue(address(second) != address(first), "changed policy collided");
        vm.prank(OWNER);
        controller.transferOwnership(NEXT_OWNER);
        address predicted = _predict();
        assertTrue(predicted != address(first), "new owner salt collided");
        vm.prank(NEXT_OWNER);
        PancakeLPVault third = factory.createForController(
            address(controller), common, policy, type(PancakeLPVault).creationCode
        );
        assertEq(address(third), predicted, "new owner cannot create");
        vm.expectRevert(LPVaultFactory.NotControllerOwner.selector);
        _create();
    }

    function test_Fork_ArbitraryMutatedAndAppendedInitcodeRejected() public {
        bytes memory payload = hex"60006000f3";
        vm.expectRevert(LPVaultFactory.UnreviewedCreationCode.selector);
        vm.prank(OWNER);
        factory.createForController(address(controller), common, policy, payload);
        payload = type(PancakeLPVault).creationCode;
        payload[0] = bytes1(uint8(payload[0]) ^ 1);
        vm.expectRevert(LPVaultFactory.UnreviewedCreationCode.selector);
        vm.prank(OWNER);
        factory.createForController(address(controller), common, policy, payload);
        payload = bytes.concat(
            type(PancakeLPVault).creationCode,
            abi.encode(PancakeLPVault.Protocol(address(1), address(2), address(3), address(4)))
        );
        vm.expectRevert(LPVaultFactory.UnreviewedCreationCode.selector);
        vm.prank(OWNER);
        factory.createForController(address(controller), common, policy, payload);
    }

    function test_Fork_ForeignOwnerControllerEOAAndForgedRuntimeRejected() public {
        bytes memory creationCode = type(PancakeLPVault).creationCode;
        vm.expectRevert(LPVaultFactory.NotControllerOwner.selector);
        factory.createForController(address(controller), common, policy, creationCode);
        vm.expectRevert(LPVaultFactory.NotControllerOwner.selector);
        vm.prank(address(controller));
        factory.createForController(address(controller), common, policy, creationCode);
        vm.expectRevert(LPVaultFactory.UnreviewedController.selector);
        vm.prank(OWNER);
        factory.createForController(OWNER, common, policy, creationCode);
        LPFactoryForgedController forged = new LPFactoryForgedController(OWNER, MANAGER);
        vm.expectRevert(LPVaultFactory.UnreviewedController.selector);
        vm.prank(OWNER);
        factory.createForController(address(forged), common, policy, creationCode);
        AiKiMandateAccount wrong = new AiKiMandateAccount(OWNER, address(0xBAD));
        vm.expectRevert(LPVaultFactory.UnreviewedController.selector);
        vm.prank(OWNER);
        factory.createForController(address(wrong), common, policy, creationCode);
        vm.expectRevert(LPVaultFactory.InvalidFactoryConfiguration.selector);
        new LPVaultFactory(MANAGER, address(forged).codehash);
    }

    function test_Fork_ForeignOccupantNeverRegisteredOrOverwritten() public {
        address predicted = _predict();
        vm.etch(predicted, hex"60006000fd");
        vm.expectRevert(LPVaultFactory.OccupiedVaultAddress.selector);
        _create();
        assertFalse(factory.isVault(predicted), "foreign occupant registered");
        assertEq(predicted.code, hex"60006000fd", "foreign occupant overwritten");
    }

    function test_Fork_RegisteredRuntimeChangeFailsClosedOnRetry() public {
        PancakeLPVault first = _create();
        vm.etch(address(first), hex"00");
        vm.expectRevert(LPVaultFactory.OccupiedVaultAddress.selector);
        _create();
        vm.etch(address(first), hex"");
        vm.expectRevert(LPVaultFactory.OccupiedVaultAddress.selector);
        _create();
    }

    function test_Fork_InvalidPolicyNeverRegistersOrOccupiesAddress() public {
        policy.minSwapFillBps = 0;
        address predicted = _predict();
        vm.expectRevert(LPVaultFactory.VaultDeploymentFailed.selector);
        _create();
        assertFalse(factory.isVault(predicted), "failed vault registered");
        assertEq(predicted.code.length, 0, "failed creation left code");
    }

    function test_Fork_ProtocolMutationAndManagerMutationFailClosed() public {
        LPFactoryWrongPool wrong = new LPFactoryWrongPool();
        vm.etch(factory.POOL(), address(wrong).code);
        vm.expectRevert(LPVaultFactory.UnreviewedProtocol.selector);
        _create();
        vm.etch(MANAGER, hex"00");
        vm.expectRevert(LPVaultFactory.UnreviewedController.selector);
        _create();
    }
}
