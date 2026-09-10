// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "../base/Test.sol";
import {AiKiMandateAccount} from "../../src/account/AiKiMandateAccount.sol";
import {StrategyVaultBase} from "../../src/strategies/StrategyVaultBase.sol";
import {GridStrategyVault} from "../../src/strategies/grid/GridStrategyVault.sol";
import {GridVaultFactory} from "../../src/strategies/grid/GridVaultFactory.sol";

interface GridFactoryForkVm {
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

interface GridFactoryForkToken {
    function approve(address spender, uint256 amount) external returns (bool);
    function deposit() external payable;
    function balanceOf(address who) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract GridFactoryForgedController {
    address public owner;
    address public DELEGATION_MANAGER;

    constructor(address owner_, address manager_) {
        owner = owner_;
        DELEGATION_MANAGER = manager_;
    }
}

contract GridFactoryWrongPool {
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

/// @notice Opt-in LOCAL pinned BSC fork. Positive cases use canonical protocol/manager code.
/// Negative cases corrupt local code only to prove fail-closed registration. No keys,
/// broadcast or live writes; both missing env values genuinely skip, one missing fails.
contract GridFactoryForkTest is Test {
    address private constant OWNER = address(0xA11CE);
    address private constant NEXT_OWNER = address(0xB0B);
    address private constant MANAGER = 0x625cfdA19d2F4424e546B610B4CeF1F5441F84c9;
    GridFactoryForkVm private constant forkVm = GridFactoryForkVm(address(vm));
    GridVaultFactory private factory;
    AiKiMandateAccount private controller;
    StrategyVaultBase.CommonPolicy private common;
    GridStrategyVault.GridPolicy private policy;
    GridStrategyVault.RungPolicy[] private rungs;

    function setUp() public {
        string memory rpc = forkVm.envOr("BSC_FORK_RPC", string(""));
        uint256 forkBlock = forkVm.envOr("BSC_FORK_BLOCK", uint256(0));
        if (bytes(rpc).length == 0 && forkBlock == 0) {
            forkVm.skip(true);
            return;
        }
        require(bytes(rpc).length != 0 && forkBlock != 0, "Set both BSC_FORK_RPC and BSC_FORK_BLOCK");
        vm.createSelectFork(rpc, forkBlock);
        // Fork execution only; compilation stays pinned to Shanghai.
        forkVm.setEvmVersion("cancun");
        assertEq(block.chainid, 56, "not BNB mainnet");
        assertEq(block.number, forkBlock, "fork must be pinned");
        controller = new AiKiMandateAccount(OWNER, MANAGER);
        factory = new GridVaultFactory(MANAGER, address(controller).codehash);
        common = StrategyVaultBase.CommonPolicy(uint64(forkVm.getBlockTimestamp() + 1 days), 60, 120);
        policy = GridStrategyVault.GridPolicy({
            tickLower: -100000,
            tickUpper: 100000,
            maxInput0: 100 ether,
            maxInput1: 1 ether,
            fundingCap0: 1000 ether,
            fundingCap1: 10 ether,
            turnoverCap0: 10000 ether,
            turnoverCap1: 100 ether,
            twapWindow: 60,
            maxDeviationTicks: 500,
            minLiquidity: 1,
            maxSlippageBps: 5,
            minFillBps: 5000,
            minCycleGainBps: 1,
            hysteresisTicks: 5
        });
        rungs.push(GridStrategyVault.RungPolicy(-68000, -67000, 100 ether, 1 ether, false));
        rungs.push(GridStrategyVault.RungPolicy(-66000, -65000, 50 ether, 0.5 ether, true));
    }

    function _create() private returns (GridStrategyVault) {
        bytes memory code = type(GridStrategyVault).creationCode;
        vm.prank(OWNER);
        return factory.createForController(address(controller), common, policy, rungs, code);
    }

    function _predict() private view returns (address) {
        return factory.predictForController(
            address(controller), common, policy, rungs, type(GridStrategyVault).creationCode
        );
    }

    function test_Fork_CreatesCanonicalPausedUnfundedRungsAndExactEvent() public {
        address predicted = _predict();
        forkVm.recordLogs();
        GridStrategyVault vault = _create();
        assertEq(address(vault), predicted, "CREATE2 prediction mismatch");
        assertTrue(factory.isVault(predicted), "vault not registered");
        assertEq(factory.registeredRuntimeHash(predicted), predicted.codehash, "runtime not registered");
        assertEq(factory.manager(), MANAGER, "wrong manager");
        assertEq(factory.accountRuntimeHash(), address(controller).codehash, "wrong account runtime");
        assertEq(vault.controller(), address(controller), "wrong controller");
        assertEq(
            vault.policyHash(),
            factory.expectedPolicyHash(address(controller), common, policy, rungs),
            "wrong policy hash"
        );
        assertEq(vault.router(), factory.ROUTER(), "wrong router");
        assertEq(vault.factory(), factory.PANCAKE_FACTORY(), "wrong pool factory");
        assertEq(vault.pool(), factory.POOL(), "wrong pool");
        assertEq(vault.token0(), factory.USDT(), "wrong token0");
        assertEq(vault.token1(), factory.WBNB(), "wrong token1");
        assertEq(vault.fee(), 500, "wrong fee");
        assertTrue(vault.paused(), "creation resumed");
        assertFalse(vault.initialized(), "creation initialized");
        assertEq(vault.operationNonce(), 0, "creation changed nonce");
        assertEq(vault.rungCount(), 2, "rungs missing");
        assertEq(
            vault.funded0() + vault.funded1() + vault.allocated0() + vault.allocated1(), 0, "creation funded"
        );
        assertEq(vault.turnover0() + vault.turnover1(), 0, "creation traded");
        for (uint32 i; i < 2; ++i) {
            GridStrategyVault.RungState memory state = vault.rungState(i);
            assertEq(state.inventory0 + state.inventory1 + state.cycle, 0, "nonempty new rung");
            assertEq(state.nextSell, rungs[i].initialSell, "wrong initial phase");
            assertFalse(state.armed, "creation armed rung");
            assertEq(
                keccak256(abi.encode(vault.rungPolicy(i))),
                keccak256(abi.encode(rungs[i])),
                "rung policy mismatch"
            );
        }
        assertEq(
            GridFactoryForkToken(factory.USDT()).allowance(predicted, factory.ROUTER()),
            0,
            "USDT approval on create"
        );
        assertEq(
            GridFactoryForkToken(factory.WBNB()).allowance(predicted, factory.ROUTER()),
            0,
            "WBNB approval on create"
        );
        assertTrue(address(factory).code.length <= 24576, "factory exceeds EIP-170");
        assertTrue(predicted.code.length <= 24576, "vault exceeds EIP-170");
        GridFactoryForkVm.Log[] memory logs = forkVm.getRecordedLogs();
        assertEq(logs.length, 1, "unexpected creation events");
        assertEq(logs[0].emitter, address(factory), "wrong emitter");
        assertEq(
            logs[0].topics[0],
            keccak256("GridVaultCreated(address,address,bytes32,address)"),
            "wrong event kind"
        );
        assertEq(address(uint160(uint256(logs[0].topics[1]))), predicted, "wrong event vault");
        assertEq(address(uint160(uint256(logs[0].topics[2]))), address(controller), "wrong event controller");
        assertEq(logs[0].topics[3], vault.policyHash(), "wrong event policy");
        assertEq(abi.decode(logs[0].data, (address)), OWNER, "wrong event owner");
        emit log_named_uint("grid_factory_runtime_bytes", address(factory).code.length);
        emit log_named_uint("grid_vault_runtime_bytes", predicted.code.length);
    }

    function test_Fork_ExactRetryPreservesFundedActiveStateAndExpiredRetry() public {
        GridStrategyVault first = _create();
        vm.deal(OWNER, 1 ether);
        vm.startPrank(OWNER);
        GridFactoryForkToken(factory.WBNB()).deposit{value: 1 ether}();
        assertTrue(
            GridFactoryForkToken(factory.WBNB()).approve(address(first), 1 ether),
            "local funding approval failed"
        );
        first.fund(0, 0, 1 ether);
        first.resume();
        uint256 nonce = first.operationNonce();
        controller.execute(
            address(first),
            0,
            abi.encodeCall(first.execute, (nonce, forkVm.getBlockTimestamp() + 60, uint32(0)))
        );
        vm.stopPrank();
        nonce = first.operationNonce();
        bytes32 beforeRung = keccak256(abi.encode(first.rungState(0)));
        forkVm.recordLogs();
        GridStrategyVault retry = _create();
        assertEq(address(retry), address(first), "retry deployed twice");
        assertFalse(retry.paused(), "retry paused active vault");
        assertTrue(retry.initialized(), "retry reset observation");
        assertEq(retry.operationNonce(), nonce, "retry reset nonce");
        assertEq(keccak256(abi.encode(retry.rungState(0))), beforeRung, "retry reset rung");
        assertEq(retry.funded1(), 1 ether, "retry reset lifetime funding");
        assertEq(retry.allocated1(), 1 ether, "retry reset inventory");
        assertEq(forkVm.getRecordedLogs().length, 0, "retry emitted false creation event");
        vm.warp(uint256(first.expiresAt()) + 1);
        retry = _create();
        assertEq(address(retry), address(first), "expired retry redeployed");
        assertEq(retry.operationNonce(), nonce, "expired retry reset state");
    }

    function test_Fork_ChangedCommonPolicyRungAndGridPolicyGetDistinctAddresses() public {
        address first = address(_create());
        common.minInterval += 1;
        address second = address(_create());
        assertTrue(first != second, "common policy collided");
        rungs[0].lot0 -= 1;
        address third = address(_create());
        assertTrue(third != second && third != first, "rung policy collided");
        policy.fundingCap0 += 1;
        address fourth = address(_create());
        assertTrue(fourth != third && fourth != second && fourth != first, "grid policy collided");
    }

    function test_Fork_OwnerTransferChangesSaltAndAuthorityIncludingOldRetry() public {
        GridStrategyVault first = _create();
        vm.prank(OWNER);
        controller.transferOwnership(NEXT_OWNER);
        address predicted = _predict();
        assertTrue(predicted != address(first), "new owner salt collided");
        vm.expectRevert(GridVaultFactory.NotControllerOwner.selector);
        _create();
        bytes memory code = type(GridStrategyVault).creationCode;
        vm.prank(NEXT_OWNER);
        GridStrategyVault next = factory.createForController(address(controller), common, policy, rungs, code);
        assertEq(address(next), predicted, "new owner cannot create");
        vm.expectRevert(StrategyVaultBase.NotStrategyOwner.selector);
        vm.prank(OWNER);
        first.resume();
        vm.prank(NEXT_OWNER);
        first.resume();
        assertFalse(first.paused(), "current owner cannot control old vault");
    }

    function test_Fork_ArbitraryMutatedAndAppendedCreationBytesRejected() public {
        bytes memory payload = hex"60006000f3";
        vm.expectRevert(GridVaultFactory.UnreviewedCreationCode.selector);
        vm.prank(OWNER);
        factory.createForController(address(controller), common, policy, rungs, payload);
        payload = type(GridStrategyVault).creationCode;
        payload[0] = bytes1(uint8(payload[0]) ^ 1);
        vm.expectRevert(GridVaultFactory.UnreviewedCreationCode.selector);
        vm.prank(OWNER);
        factory.createForController(address(controller), common, policy, rungs, payload);
        payload = bytes.concat(
            type(GridStrategyVault).creationCode,
            abi.encode(GridStrategyVault.Protocol(address(1), address(2), address(3), address(4), address(5)))
        );
        vm.expectRevert(GridVaultFactory.UnreviewedCreationCode.selector);
        vm.prank(OWNER);
        factory.createForController(address(controller), common, policy, rungs, payload);
    }

    function test_Fork_ForeignOwnerControllerEOAAndForgedRuntimeRejected() public {
        bytes memory code = type(GridStrategyVault).creationCode;
        vm.expectRevert(GridVaultFactory.NotControllerOwner.selector);
        factory.createForController(address(controller), common, policy, rungs, code);
        vm.expectRevert(GridVaultFactory.NotControllerOwner.selector);
        vm.prank(address(controller));
        factory.createForController(address(controller), common, policy, rungs, code);
        vm.expectRevert(GridVaultFactory.UnreviewedController.selector);
        vm.prank(OWNER);
        factory.createForController(OWNER, common, policy, rungs, code);
        GridFactoryForgedController forged = new GridFactoryForgedController(OWNER, MANAGER);
        vm.expectRevert(GridVaultFactory.UnreviewedController.selector);
        vm.prank(OWNER);
        factory.createForController(address(forged), common, policy, rungs, code);
        AiKiMandateAccount wrong = new AiKiMandateAccount(OWNER, address(0xBAD));
        vm.expectRevert(GridVaultFactory.UnreviewedController.selector);
        vm.prank(OWNER);
        factory.createForController(address(wrong), common, policy, rungs, code);
        vm.expectRevert(GridVaultFactory.InvalidFactoryConfiguration.selector);
        new GridVaultFactory(MANAGER, address(forged).codehash);
    }

    function test_Fork_ForeignOccupantNeverRegisteredOrOverwritten() public {
        address predicted = _predict();
        vm.etch(predicted, hex"60006000fd");
        vm.expectRevert(GridVaultFactory.OccupiedVaultAddress.selector);
        _create();
        assertFalse(factory.isVault(predicted), "foreign occupant registered");
        assertEq(predicted.code, hex"60006000fd", "foreign occupant overwritten");
    }

    function test_Fork_RegisteredRuntimeChangedOrMissingRejectsRetry() public {
        address first = address(_create());
        vm.etch(first, hex"00");
        vm.expectRevert(GridVaultFactory.OccupiedVaultAddress.selector);
        _create();
        vm.etch(first, hex"");
        vm.expectRevert(GridVaultFactory.OccupiedVaultAddress.selector);
        _create();
    }

    function test_Fork_InvalidRungOrPolicyNeverRegistersOrLeavesCode() public {
        rungs[0].lot0 = 0;
        address predicted = _predict();
        vm.expectRevert(GridVaultFactory.VaultDeploymentFailed.selector);
        _create();
        assertFalse(factory.isVault(predicted), "invalid rung registered");
        assertEq(predicted.code.length, 0, "invalid rung left code");
        rungs[0].lot0 = 100 ether;
        policy.minFillBps = 0;
        predicted = _predict();
        vm.expectRevert(GridVaultFactory.VaultDeploymentFailed.selector);
        _create();
        assertFalse(factory.isVault(predicted), "invalid policy registered");
        assertEq(predicted.code.length, 0, "invalid policy left code");
    }

    function test_Fork_ProtocolAndManagerMutationFailClosed() public {
        GridFactoryWrongPool wrong = new GridFactoryWrongPool();
        vm.etch(factory.POOL(), address(wrong).code);
        vm.expectRevert(GridVaultFactory.UnreviewedProtocol.selector);
        _create();
        vm.etch(MANAGER, hex"00");
        vm.expectRevert(GridVaultFactory.UnreviewedController.selector);
        _create();
    }

    function test_Fork_NetworkChangeFailsClosedForCreateAndPredict() public {
        vm.chainId(97);
        vm.expectRevert(GridVaultFactory.UnreviewedController.selector);
        _create();
        vm.expectRevert(GridVaultFactory.UnreviewedController.selector);
        factory.predictForController(
            address(controller), common, policy, rungs, type(GridStrategyVault).creationCode
        );
    }

    function test_Fork_MaximumRungsFitsAndOversizedRungsFailAtomically() public {
        delete rungs;
        for (int24 i; i < 32; ++i) {
            rungs.push(
                GridStrategyVault.RungPolicy(-80000 + i * 1000, -79500 + i * 1000, 1 ether, 0.01 ether, false)
            );
        }
        GridStrategyVault maximum = _create();
        assertEq(maximum.rungCount(), 32, "maximum rungs missing");
        rungs.push(GridStrategyVault.RungPolicy(-47000, -46500, 1 ether, 0.01 ether, false));
        address predicted = _predict();
        vm.expectRevert(GridVaultFactory.VaultDeploymentFailed.selector);
        _create();
        assertFalse(factory.isVault(predicted), "oversized policy registered");
        assertEq(predicted.code.length, 0, "oversized constructor left code");
    }
}
