// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {Test} from "../base/Test.sol";
import {AiKiMandateAccount} from "../../src/account/AiKiMandateAccount.sol";
import {StrategyVaultBase} from "../../src/strategies/StrategyVaultBase.sol";
import {YieldAllocationVault} from "../../src/strategies/yield/YieldAllocationVault.sol";
import {YieldVaultFactory} from "../../src/strategies/yield/YieldVaultFactory.sol";

interface YieldFactoryVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function envOr(string calldata, string calldata) external returns (string memory);
    function envOr(string calldata, uint256) external returns (uint256);
    function skip(bool) external;
    function setEvmVersion(string calldata) external;
    function getBlockTimestamp() external view returns (uint256);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract YieldFactoryForkTest is Test {
    YieldFactoryVm private constant forkVm = YieldFactoryVm(address(vm));
    address private constant OWNER = address(0xA11CE);
    address private constant MANAGER = 0x625cfdA19d2F4424e546B610B4CeF1F5441F84c9;
    YieldVaultFactory private factory;
    AiKiMandateAccount private controller;
    StrategyVaultBase.CommonPolicy private common;
    YieldAllocationVault.YieldPolicy private policy;

    function setUp() public {
        string memory rpc = forkVm.envOr("BSC_FORK_RPC", string(""));
        uint256 blockNumber = forkVm.envOr("BSC_FORK_BLOCK", uint256(0));
        if (bytes(rpc).length == 0 && blockNumber == 0) {
            forkVm.skip(true);
            return;
        }
        require(bytes(rpc).length != 0 && blockNumber != 0, "Set both BSC_FORK_RPC and BSC_FORK_BLOCK");
        vm.createSelectFork(rpc, blockNumber);
        forkVm.setEvmVersion("cancun");
        assertEq(block.chainid, 56, "wrong chain");
        controller = new AiKiMandateAccount(OWNER, MANAGER);
        factory = new YieldVaultFactory(MANAGER, address(controller).codehash);
        common = StrategyVaultBase.CommonPolicy(uint64(forkVm.getBlockTimestamp() + 1 days), 1, 300);
        policy = YieldAllocationVault.YieldPolicy(
            1000 ether, 500 ether, 2000 ether, 100 ether, 800 ether, 800 ether, 0.001 ether, 0.01 ether, 1
        );
    }

    function _create() private returns (YieldAllocationVault) {
        vm.prank(OWNER);
        return factory.createForController(address(controller), common, policy);
    }

    function test_Fork_PredictedCreationEventAndActiveExpiredRetry() public {
        address predicted = factory.predictForController(address(controller), common, policy);
        forkVm.recordLogs();
        YieldAllocationVault vault = _create();
        assertEq(address(vault), predicted, "prediction mismatch");
        assertEq(
            vault.policyHash(),
            factory.expectedPolicyHash(address(controller), common, policy),
            "policy mismatch"
        );
        assertTrue(factory.isVault(predicted), "missing registry");
        assertEq(factory.registeredRuntimeHash(predicted), predicted.codehash, "missing runtime pin");
        YieldFactoryVm.Log[] memory logs = forkVm.getRecordedLogs();
        assertEq(logs.length, 1, "creation event missing/duplicated");
        assertEq(
            logs[0].topics[0], keccak256("YieldVaultCreated(address,address,bytes32,address)"), "wrong event"
        );
        assertEq(logs[0].emitter, address(factory), "wrong emitter");
        assertTrue(vault.paused(), "creation resumed");
        vm.prank(OWNER);
        vault.resume();
        forkVm.recordLogs();
        assertEq(address(_create()), predicted, "retry duplicated");
        assertFalse(vault.paused(), "retry paused");
        assertEq(vault.operationNonce(), 1, "retry reset nonce");
        assertEq(forkVm.getRecordedLogs().length, 0, "retry emitted creation");
        vm.warp(uint256(common.expiresAt) + 1);
        assertEq(address(_create()), predicted, "expired retry duplicated");
        assertTrue(address(factory).code.length <= 24576, "factory runtime too large");
        emit log_named_uint("yield_factory_runtime_bytes", address(factory).code.length);
    }

    function test_Fork_ChangedOwnerAndPolicyHaveDifferentSalts() public {
        address first = address(_create());
        policy.maxPrincipal += 1;
        address second = address(_create());
        assertTrue(first != second, "policy collision");
        vm.prank(OWNER);
        controller.transferOwnership(address(0xB0B));
        vm.expectRevert(YieldVaultFactory.NotControllerOwner.selector);
        _create();
        vm.prank(address(0xB0B));
        address third = address(factory.createForController(address(controller), common, policy));
        assertTrue(third != second, "owner collision");
    }

    function test_Fork_ForeignOccupiedAndChangedRegisteredRuntimeRefuse() public {
        address predicted = factory.predictForController(address(controller), common, policy);
        vm.etch(predicted, hex"00");
        vm.expectRevert(YieldVaultFactory.OccupiedVaultAddress.selector);
        _create();
        assertFalse(factory.isVault(predicted), "registered foreign code");
        vm.etch(predicted, hex"");
        _create();
        vm.etch(predicted, hex"00");
        vm.expectRevert(YieldVaultFactory.OccupiedVaultAddress.selector);
        _create();
    }

    function test_Fork_InvalidPolicyLeavesNoRegistryOrCode() public {
        policy.maxMove = 0;
        address predicted = factory.predictForController(address(controller), common, policy);
        vm.expectRevert(YieldVaultFactory.VaultDeploymentFailed.selector);
        _create();
        assertFalse(factory.isVault(predicted), "registered invalid policy");
        assertEq(predicted.code.length, 0, "invalid constructor left code");
    }
}
