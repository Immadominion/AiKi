// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../base/Fixture.sol";
import {StrategyVaultBase} from "../../src/strategies/StrategyVaultBase.sol";
import {StrategyToken} from "../../src/strategies/StrategyToken.sol";
import {StrategyBindingEnforcer} from "../../src/strategies/StrategyBindingEnforcer.sol";
import {Caveat, Delegation} from "../../src/core/Types.sol";

contract FoundationVault is StrategyVaultBase {
    uint256 public result;
    bool public failAfterBegin;

    constructor(address controller_, CommonPolicy memory common)
        StrategyVaultBase(controller_, keccak256(abi.encode("foundation", common)), common)
    {}

    function execute(uint256 nonce, uint256 deadline, uint256 amount) external nonReentrant {
        _begin(nonce, deadline);
        require(!failAfterBegin, "test rollback");
        result = amount;
        _finish(keccak256(abi.encode(policyHash, nonce, deadline, amount)));
    }

    function unguarded(uint256 nonce, uint256 deadline) external {
        _begin(nonce, deadline);
    }

    function ownerChange(bool fail) external onlyOwner nonReentrant {
        failAfterBegin = fail;
        _invalidate();
    }

    function recover(address token, uint256 amount) external onlyOwner nonReentrant {
        _invalidate();
        StrategyToken.safeTransfer(token, msg.sender, amount);
    }

    function strategyKind() external pure override returns (bytes32) {
        return keccak256("test-foundation");
    }

    function operationSelector() external pure override returns (bytes4) {
        return this.execute.selector;
    }
}

contract FoundationTokenHarness {
    function transfer(address token, address to, uint256 amount) external {
        StrategyToken.safeTransfer(token, to, amount);
    }

    function approve(address token, address to, uint256 amount) external {
        StrategyToken.approveExact(token, to, amount);
    }

    function balance(address token) external view returns (uint256) {
        return StrategyToken.balance(token, address(this));
    }
}

contract FoundationReturnToken {
    uint256 public mode;
    mapping(address => mapping(address => uint256)) public allowance;

    function setMode(uint256 value) external {
        mode = value;
    }

    function transfer(address, uint256) external view returns (bool) {
        return _result();
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (mode != 4) allowance[msg.sender][spender] = amount;
        return _result();
    }

    function _result() private view returns (bool) {
        uint256 value = mode;
        if (value == 1) return false;
        if (value == 2) assembly { return(0, 0) }
        if (value == 3) assembly {
            mstore(0, 2)
            return(0, 32)
        }
        if (value == 5) revert("test token failure");
        return true;
    }
}

contract StrategyFoundationTest is Fixture {
    FoundationVault internal vault;
    StrategyBindingEnforcer internal binding;

    function setUp() public {
        vm.warp(1000);
        deploySuite();
        vault = new FoundationVault(address(account), common());
        binding = new StrategyBindingEnforcer();
    }

    function common() private view returns (StrategyVaultBase.CommonPolicy memory) {
        return StrategyVaultBase.CommonPolicy(uint64(block.timestamp + 1 days), 60, 120);
    }

    function enable() private {
        vm.prank(owner);
        vault.resume();
    }

    function testInitialPauseAndExplicitOwnerResume() public {
        assertTrue(vault.paused(), "new vault must not run");
        vm.prank(address(account));
        vm.expectRevert(StrategyVaultBase.StrategyPaused.selector);
        vault.execute(0, block.timestamp + 60, 3);
        enable();
        assertFalse(vault.paused(), "owner resumed");
        assertEq(vault.operationNonce(), 1, "resume invalidates old plans");
    }

    function testControllerIsNotAnOwnerEscapeCaller() public {
        vm.prank(address(account));
        vm.expectRevert(StrategyVaultBase.NotStrategyOwner.selector);
        vault.resume();
        vm.prank(agent);
        vm.expectRevert(StrategyVaultBase.NotStrategyOwner.selector);
        vault.ownerChange(true);
    }

    function testOwnerCannotBypassDelegatedOperationChecks() public {
        enable();
        vm.prank(owner);
        vm.expectRevert(StrategyVaultBase.NotStrategyController.selector);
        vault.execute(1, block.timestamp + 60, 3);
    }

    function testExecuteNonceReplayAndCooldown() public {
        enable();
        vm.prank(address(account));
        vault.execute(1, block.timestamp + 60, 3);
        assertEq(vault.result(), 3, "result committed");
        assertEq(vault.operationNonce(), 2, "nonce committed");
        vm.prank(address(account));
        vm.expectRevert(StrategyVaultBase.StaleStrategyNonce.selector);
        vault.execute(1, block.timestamp + 60, 4);
        vm.prank(address(account));
        vm.expectRevert(StrategyVaultBase.StrategyCooldown.selector);
        vault.execute(2, block.timestamp + 60, 4);
        vm.warp(block.timestamp + 60);
        vm.prank(address(account));
        vault.execute(2, block.timestamp + 60, 4);
        assertEq(vault.result(), 4, "cooldown completed");
    }

    function testRevertingOperationRollsBackNonceAndClock() public {
        enable();
        vm.prank(owner);
        vault.ownerChange(true);
        uint256 nonce = vault.operationNonce();
        vm.prank(address(account));
        vm.expectRevert();
        vault.execute(nonce, block.timestamp + 60, 4);
        assertEq(vault.operationNonce(), nonce, "nonce rollback");
        assertEq(vault.lastExecutionAt(), 0, "clock rollback");
        assertEq(vault.result(), 0, "result rollback");
    }

    function testDeadlineAndExpiryBoundaries() public {
        enable();
        vm.prank(address(account));
        vm.expectRevert(StrategyVaultBase.InvalidStrategyDeadline.selector);
        vault.execute(1, block.timestamp - 1, 1);
        vm.prank(address(account));
        vm.expectRevert(StrategyVaultBase.InvalidStrategyDeadline.selector);
        vault.execute(1, block.timestamp + 121, 1);
        vm.warp(vault.expiresAt());
        vm.prank(address(account));
        vm.expectRevert(StrategyVaultBase.StrategyExpired.selector);
        vault.execute(1, block.timestamp, 1);
        vm.prank(owner);
        vault.pause();
        vm.prank(owner);
        vm.expectRevert(StrategyVaultBase.StrategyExpired.selector);
        vault.resume();
    }

    function testPauseInvalidatesPreparedOperations() public {
        enable();
        vm.prank(owner);
        vault.pause();
        vm.prank(owner);
        vault.resume();
        vm.prank(address(account));
        vm.expectRevert(StrategyVaultBase.StaleStrategyNonce.selector);
        vault.execute(1, block.timestamp + 60, 1);
    }

    function testGuardCannotBeForgottenByAnEntrypoint() public {
        enable();
        vm.prank(address(account));
        vm.expectRevert(StrategyVaultBase.MissingStrategyGuard.selector);
        vault.unguarded(1, block.timestamp + 60);
    }

    function testCurrentAccountOwnerRetainsRecoveryAfterExpiry() public {
        token.mint(address(vault), 20);
        vm.prank(owner);
        account.transferOwnership(stranger);
        vm.warp(vault.expiresAt());
        vm.prank(owner);
        vm.expectRevert(StrategyVaultBase.NotStrategyOwner.selector);
        vault.recover(address(token), 20);
        vm.prank(stranger);
        vault.recover(address(token), 20);
        assertEq(token.balanceOf(stranger), 20, "new owner recovered without automation");
    }

    function testConstructorRejectsInvalidControllerAndPolicy() public {
        vm.expectRevert(StrategyVaultBase.InvalidController.selector);
        new FoundationVault(owner, common());
        StrategyVaultBase.CommonPolicy memory bad = common();
        bad.maxDeadlineDelay = 3601;
        vm.expectRevert(StrategyVaultBase.InvalidCommonPolicy.selector);
        new FoundationVault(address(account), bad);
        bad = common();
        bad.expiresAt = uint64(block.timestamp);
        vm.expectRevert(StrategyVaultBase.InvalidCommonPolicy.selector);
        new FoundationVault(address(account), bad);
    }

    function terms() private view returns (bytes memory) {
        return abi.encode(
            address(vault),
            vault.policyHash(),
            address(vault).codehash,
            vault.operationSelector(),
            vault.strategyKind()
        );
    }

    function testBindingChecksExactCodePolicyControllerAndSelector() public view {
        bytes memory callData = abi.encodeCall(vault.execute, (1, block.timestamp + 60, 1));
        binding.beforeHook(
            terms(), "", bytes32(0), execOf(address(vault), 0, callData), bytes32(0), address(account), agent
        );
    }

    function testBindingRejectsEscapeFunctionAndNativeValue() public {
        bytes memory signedTerms = terms();
        vm.expectRevert(StrategyBindingEnforcer.StrategyBindingMismatch.selector);
        binding.beforeHook(
            signedTerms,
            "",
            bytes32(0),
            execOf(address(vault), 0, abi.encodeCall(vault.resume, ())),
            bytes32(0),
            address(account),
            agent
        );
        vm.expectRevert(StrategyBindingEnforcer.StrategyBindingMismatch.selector);
        binding.beforeHook(
            signedTerms,
            "",
            bytes32(0),
            execOf(address(vault), 1, abi.encodeCall(vault.execute, (1, block.timestamp + 60, 1))),
            bytes32(0),
            address(account),
            agent
        );
    }

    function testBindingRejectsDifferentPolicyOwnerAndRuntime() public {
        bytes memory data =
            execOf(address(vault), 0, abi.encodeCall(vault.execute, (1, block.timestamp + 60, 1)));
        bytes memory signedTerms = terms();
        vm.expectRevert(StrategyBindingEnforcer.StrategyBindingMismatch.selector);
        binding.beforeHook(signedTerms, "", bytes32(0), data, bytes32(0), stranger, agent);
        bytes memory wrong = abi.encode(
            address(vault),
            bytes32(uint256(1)),
            address(vault).codehash,
            vault.operationSelector(),
            vault.strategyKind()
        );
        vm.expectRevert(StrategyBindingEnforcer.StrategyBindingMismatch.selector);
        binding.beforeHook(wrong, "", bytes32(0), data, bytes32(0), address(account), agent);
        wrong = abi.encode(
            address(vault),
            vault.policyHash(),
            bytes32(uint256(1)),
            vault.operationSelector(),
            vault.strategyKind()
        );
        vm.expectRevert(StrategyBindingEnforcer.StrategyBindingMismatch.selector);
        binding.beforeHook(wrong, "", bytes32(0), data, bytes32(0), address(account), agent);
    }

    function testBindingRejectsMalformedTermsAndUnsignedArgs() public {
        bytes memory data =
            execOf(address(vault), 0, abi.encodeCall(vault.execute, (1, block.timestamp + 60, 1)));
        bytes memory signedTerms = terms();
        vm.expectRevert(StrategyBindingEnforcer.InvalidStrategyTerms.selector);
        binding.beforeHook(
            bytes.concat(signedTerms, hex"00"), "", bytes32(0), data, bytes32(0), address(account), agent
        );
        vm.expectRevert();
        binding.beforeHook(signedTerms, hex"01", bytes32(0), data, bytes32(0), address(account), agent);
    }

    function testNewBindingWorksThroughExistingSignedManagerAndAccount() public {
        enable();
        Caveat[] memory cs = new Caveat[](2);
        cs[0] = Caveat(address(expiryE), abi.encode(uint256(vault.expiresAt())), "");
        cs[1] = Caveat(address(binding), terms(), "");
        Delegation memory d = baseDelegation(address(account), cs);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);
        bytes[] memory contexts = new bytes[](1);
        contexts[0] = contextOf(d);
        bytes32[] memory modes = new bytes32[](1);
        bytes[] memory executions = new bytes[](1);
        executions[0] = execOf(address(vault), 0, abi.encodeCall(vault.execute, (1, block.timestamp + 60, 7)));
        vm.prank(agent);
        manager.redeemDelegations(contexts, modes, executions);
        assertEq(vault.result(), 7, "unchanged manager routed bounded operation");
        executions[0] = execOf(address(vault), 0, abi.encodeCall(vault.resume, ()));
        vm.prank(agent);
        vm.expectRevert(StrategyBindingEnforcer.StrategyBindingMismatch.selector);
        manager.redeemDelegations(contexts, modes, executions);
    }

    function testTokenFalseMalformedAndEOAReturnsRejected() public {
        FoundationTokenHarness harness = new FoundationTokenHarness();
        FoundationReturnToken bad = new FoundationReturnToken();
        bad.setMode(1);
        vm.expectRevert(StrategyToken.StrategyTokenCallFailed.selector);
        harness.transfer(address(bad), owner, 1);
        bad.setMode(3);
        vm.expectRevert(StrategyToken.StrategyTokenCallFailed.selector);
        harness.transfer(address(bad), owner, 1);
        vm.expectRevert(StrategyToken.InvalidStrategyToken.selector);
        harness.transfer(owner, owner, 1);
        bad.setMode(2);
        harness.transfer(address(bad), owner, 1);
    }

    function testExactAllowanceAndCleanup() public {
        FoundationTokenHarness harness = new FoundationTokenHarness();
        harness.approve(address(token), stranger, 42);
        assertEq(token.allowance(address(harness), stranger), 42, "exact approval");
        harness.approve(address(token), stranger, 7);
        assertEq(token.allowance(address(harness), stranger), 7, "replaced not accumulated");
        harness.approve(address(token), stranger, 0);
        assertEq(token.allowance(address(harness), stranger), 0, "cleared allowance");
        FoundationReturnToken bad = new FoundationReturnToken();
        bad.setMode(4);
        vm.expectRevert(StrategyToken.StrategyApprovalMismatch.selector);
        harness.approve(address(bad), stranger, 42);
    }
}
