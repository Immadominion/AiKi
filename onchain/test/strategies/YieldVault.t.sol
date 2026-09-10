// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "../base/Test.sol";
import {StrategyVaultBase} from "../../src/strategies/StrategyVaultBase.sol";
import {YieldAllocationVault} from "../../src/strategies/yield/YieldAllocationVault.sol";

interface YieldVmClock {
    function getBlockTimestamp() external view returns (uint256);
}

contract YieldMockController {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function setOwner(address owner_) external {
        owner = owner_;
    }
}

contract YieldMockToken {
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) internal _balances;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public falseApprove;
    bool public falseTransfer;
    uint256 public transferFee;
    address public callback;
    bytes public callbackData;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function balanceOf(address who) external view virtual returns (uint256) {
        return _balances[who];
    }

    function setDecimals(uint8 value) external {
        decimals = value;
    }

    function setFalseApprove(bool value) external {
        falseApprove = value;
    }

    function setFalseTransfer(bool value) external {
        falseTransfer = value;
    }

    function setFee(uint256 value) external {
        transferFee = value;
    }

    function setCallback(address target, bytes calldata data) external {
        callback = target;
        callbackData = data;
    }

    function mint(address to, uint256 amount) public {
        _balances[to] += amount;
        totalSupply += amount;
    }

    function burn(address from, uint256 amount) public {
        _balances[from] -= amount;
        totalSupply -= amount;
    }

    function approve(address to, uint256 amount) external returns (bool) {
        if (falseApprove) return false;
        allowance[msg.sender][to] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (falseTransfer) return false;
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        if (callback != address(0)) {
            (bool ok, bytes memory reason) = callback.call(callbackData);
            if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
        }
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        _balances[from] -= amount;
        _balances[to] += amount - transferFee;
        totalSupply -= transferFee;
    }
}

contract YieldMockComptroller {
    bool public protocolPaused;
    bool public listed = true;
    mapping(uint8 => bool) public action;
    uint256 public cap = 1_000_000 ether;

    function setGlobalPause(bool value) external {
        protocolPaused = value;
    }

    function setListed(bool value) external {
        listed = value;
    }

    function setAction(uint8 which, bool value) external {
        action[which] = value;
    }

    function setCap(uint256 value) external {
        cap = value;
    }

    function actionPaused(address, uint8 which) external view returns (bool) {
        return action[which];
    }

    function supplyCaps(address) external view returns (uint256) {
        return cap;
    }

    function markets(address) external view returns (bool, uint256, bool, uint256, uint256, uint96, bool) {
        return (listed, 0, false, 0, 0, 0, false);
    }
}

contract YieldMockVenus is YieldMockToken {
    address public underlying;
    address public comptroller;
    uint256 public rate = 2e26;
    uint256 public mintCode;
    uint256 public redeemCode;
    uint256 public mintBps = 10_000;
    uint256 public redeemBps = 10_000;
    bool public failPricing;
    bool public paddedBalance;

    function setPaddedBalance(bool value) external {
        paddedBalance = value;
    }

    function balanceOf(address who) external view override returns (uint256 value) {
        value = _balances[who];
        if (paddedBalance) {
            assembly ("memory-safe") {
                let p := mload(0x40)
                mstore(p, value)
                mstore(add(p, 32), 0)
                mstore(add(p, 64), 0)
                return(p, 96)
            }
        }
    }

    constructor(address token, address comp) YieldMockToken(8) {
        underlying = token;
        comptroller = comp;
    }

    function setUnderlying(address token) external {
        underlying = token;
    }

    function setRate(uint256 value) external {
        rate = value;
    }

    function setFailPricing(bool value) external {
        failPricing = value;
    }

    function setCodes(uint256 supplyCode, uint256 withdrawalCode) external {
        mintCode = supplyCode;
        redeemCode = withdrawalCode;
    }

    function setBps(uint256 supplyBps, uint256 withdrawalBps) external {
        mintBps = supplyBps;
        redeemBps = withdrawalBps;
    }

    function exchangeRateCurrent() external view returns (uint256) {
        require(!failPricing, "no oracle");
        return rate;
    }

    function getCash() external view returns (uint256) {
        return YieldMockToken(underlying).balanceOf(address(this));
    }

    function mint(uint256 assets) external returns (uint256) {
        if (mintCode != 0) return mintCode;
        require(YieldMockToken(underlying).transferFrom(msg.sender, address(this), assets));
        mint(msg.sender, assets * 1e18 / rate * mintBps / 10_000);
        return 0;
    }

    function redeemUnderlying(uint256 assets) external returns (uint256) {
        if (redeemCode != 0) return redeemCode;
        burn(msg.sender, (assets * 1e18 + rate - 1) / rate);
        require(YieldMockToken(underlying).transfer(msg.sender, assets * redeemBps / 10_000));
        return 0;
    }
}

contract YieldMockAToken {
    uint8 public constant decimals = 18;
    address public UNDERLYING_ASSET_ADDRESS;
    address public POOL;
    uint256 public index = 1e27;
    uint256 public scaledSupply;
    mapping(address => uint256) public scaledBalanceOf;

    constructor(address token) {
        UNDERLYING_ASSET_ADDRESS = token;
    }

    function setPool(address pool) external {
        POOL = pool;
    }

    function setIndex(uint256 value) external {
        index = value;
    }

    function balanceOf(address who) external view returns (uint256) {
        return scaledBalanceOf[who] * index / 1e27;
    }

    function totalSupply() external view returns (uint256) {
        return scaledSupply * index / 1e27;
    }

    function mintScaled(address who, uint256 amount) external {
        scaledBalanceOf[who] += amount;
        scaledSupply += amount;
    }

    function burnScaled(address who, uint256 amount) external {
        scaledBalanceOf[who] -= amount;
        scaledSupply -= amount;
    }

    function pay(address to, uint256 amount) external {
        require(msg.sender == POOL);
        require(YieldMockToken(UNDERLYING_ASSET_ADDRESS).transfer(to, amount));
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 scaled = amount * 1e27 / index;
        scaledBalanceOf[msg.sender] -= scaled;
        scaledBalanceOf[to] += scaled;
        return true;
    }
}

contract YieldMockProvider {
    address public pool;

    function setPool(address value) external {
        pool = value;
    }

    function getPool() external view returns (address) {
        return pool;
    }
}

contract YieldMockAave {
    address public ADDRESSES_PROVIDER;
    YieldMockAToken public receipt;
    uint128 public available = type(uint128).max;
    uint256 public supplyBps = 10_000;
    uint256 public indexAfterSupply;
    uint256 public withdrawBps = 10_000;
    bool public failSupply;
    bool public wrongReturn;

    constructor(address provider, YieldMockAToken token) {
        ADDRESSES_PROVIDER = provider;
        receipt = token;
    }

    function setAvailable(uint128 value) external {
        available = value;
    }

    function setSupplyBps(uint256 value) external {
        supplyBps = value;
    }

    function setIndexAfterSupply(uint256 value) external {
        indexAfterSupply = value;
    }

    function setWithdrawBps(uint256 value) external {
        withdrawBps = value;
    }

    function setWrongReturn(bool value) external {
        wrongReturn = value;
    }

    function setFailSupply(bool value) external {
        failSupply = value;
    }

    function getReserveNormalizedIncome(address) external view returns (uint256) {
        return receipt.index();
    }

    function getVirtualUnderlyingBalance(address) external view returns (uint128) {
        return available;
    }

    function supply(address asset, uint256 amount, address beneficiary, uint16) external {
        require(!failSupply, "supply failed");
        require(YieldMockToken(asset).transferFrom(msg.sender, address(receipt), amount));
        receipt.mintScaled(beneficiary, amount * 1e27 / receipt.index() * supplyBps / 10_000);
        if (indexAfterSupply != 0) receipt.setIndex(indexAfterSupply);
    }

    function withdraw(address, uint256 amount, address to) external returns (uint256) {
        receipt.burnScaled(msg.sender, (amount * 1e27 + receipt.index() - 1) / receipt.index());
        receipt.pay(to, amount * withdrawBps / 10_000);
        return wrongReturn ? amount - 1 : amount;
    }
}

contract YieldMockData {
    address public ADDRESSES_PROVIDER;
    address public receipt;
    bool public active = true;
    bool public frozen;
    bool public paused;
    uint256 public cap = 1_000_000;

    constructor(address provider, address receipt_) {
        ADDRESSES_PROVIDER = provider;
        receipt = receipt_;
    }

    function setReceipt(address value) external {
        receipt = value;
    }

    function setFlags(bool a, bool f, bool p) external {
        active = a;
        frozen = f;
        paused = p;
    }

    function setCap(uint256 value) external {
        cap = value;
    }

    function getReserveTokensAddresses(address) external view returns (address, address, address) {
        return (receipt, address(0), address(0));
    }

    function getReserveConfigurationData(address)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, bool, bool, bool, bool, bool)
    {
        return (18, 0, 0, 0, 0, true, false, false, active, frozen);
    }

    function getPaused(address) external view returns (bool) {
        return paused;
    }

    function getReserveCaps(address) external view returns (uint256, uint256) {
        return (0, cap);
    }
}

contract YieldVaultTest is Test {
    // Solidity assumes block.timestamp is constant within a transaction. Read the
    // cheatcode clock explicitly around repeated warps in these multi-operation tests.
    function _now() private view returns (uint256) {
        return YieldVmClock(address(vm)).getBlockTimestamp();
    }
    address private constant OWNER = address(0xA11CE);
    YieldMockController private controller;
    YieldMockToken private usdt;
    YieldMockComptroller private comp;
    YieldMockVenus private venus;
    YieldMockAToken private aToken;
    YieldMockProvider private provider;
    YieldMockAave private pool;
    YieldMockData private data;
    YieldAllocationVault private vault;

    function setUp() public {
        vm.chainId(56);
        vm.warp(1_000_000);
        controller = new YieldMockController(OWNER);
        usdt = new YieldMockToken(18);
        comp = new YieldMockComptroller();
        venus = new YieldMockVenus(address(usdt), address(comp));
        aToken = new YieldMockAToken(address(usdt));
        provider = new YieldMockProvider();
        pool = new YieldMockAave(address(provider), aToken);
        aToken.setPool(address(pool));
        provider.setPool(address(pool));
        data = new YieldMockData(address(provider), address(aToken));
        vault = _deploy(_policy());
        usdt.mint(OWNER, 10_000 ether);
        vm.prank(OWNER);
        usdt.approve(address(vault), type(uint256).max);
        vm.prank(OWNER);
        vault.fund(1_000 ether);
        vm.prank(OWNER);
        vault.resume();
    }

    function _policy() private pure returns (YieldAllocationVault.YieldPolicy memory) {
        return YieldAllocationVault.YieldPolicy({
            maxPrincipal: 1_000 ether,
            maxMove: 500 ether,
            maxTurnover: 2_000 ether,
            minIdle: 100 ether,
            maxVenusExposure: 800 ether,
            maxAaveExposure: 800 ether,
            maxLossPerMove: 1 ether,
            maxCumulativeLoss: 2 ether,
            maxLossBps: 100
        });
    }

    function _deploy(YieldAllocationVault.YieldPolicy memory policy) private returns (YieldAllocationVault) {
        return new YieldAllocationVault(
            address(controller),
            StrategyVaultBase.CommonPolicy(uint64(_now() + 1 days), 60, 300),
            YieldAllocationVault.Venues(
                address(usdt),
                address(venus),
                address(comp),
                address(pool),
                address(provider),
                address(data),
                address(aToken)
            ),
            policy
        );
    }

    function _move(uint8 from, uint8 to, uint256 amount) private {
        uint256 nonce = vault.operationNonce();
        vm.warp(_now() + 60);
        vm.prank(address(controller));
        vault.reallocate(from, to, amount, 0, nonce, _now() + 60);
    }

    function _expectMoveRevert(uint8 from, uint8 to, uint256 amount, bytes4 reason) private {
        uint256 nonce = vault.operationNonce();
        vm.warp(_now() + 60);
        vm.prank(address(controller));
        vm.expectRevert(reason);
        vault.reallocate(from, to, amount, 0, nonce, _now() + 60);
        assertEq(vault.operationNonce(), nonce, "failed operation consumed nonce");
    }

    function test_BothDirectionsAndIdleExitConserveUnderlying() public {
        _move(0, 1, 500 ether);
        assertEq(vault.managedVenusShares(), 2_500_000_000_000, "vUSDT decimals");
        _move(1, 2, 400 ether);
        assertEq(vault.managedAaveScaled(), 400 ether, "Aave receipt missing");
        _move(2, 1, 200 ether);
        _move(1, 0, 300 ether);
        _move(2, 0, 200 ether);
        assertEq(vault.managedIdle(), 1_000 ether, "principal not returned");
        assertEq(vault.managedVenusShares(), 0, "Venus remainder");
        assertEq(vault.managedAaveScaled(), 0, "Aave remainder");
        assertEq(vault.turnover(), 1_100 ether, "withdraw counted as allocation");
        assertEq(vault.cumulativeLoss(), 0, "phantom loss");
        assertEq(usdt.allowance(address(vault), address(venus)), 0, "Venus allowance leaked");
        assertEq(usdt.allowance(address(vault), address(pool)), 0, "Aave allowance leaked");
    }

    function test_LegacyVenusPaddedBalanceReturnWorksWithoutWeakeningOtherTokens() public {
        venus.setPaddedBalance(true);
        _move(0, 1, 100 ether);
        _move(1, 0, 50 ether);
        uint256 shares = vault.managedVenusShares();
        vm.prank(OWNER);
        vault.recover(address(venus), shares);
        assertEq(venus.balanceOf(OWNER), shares, "padded Venus recovery failed");
    }

    function test_AaveIndexedReceiptsAndVenusAccrual() public {
        aToken.setIndex(2e27);
        _move(0, 2, 400 ether);
        assertEq(vault.managedAaveScaled(), 200 ether, "index ignored");
        aToken.setIndex(25e26);
        usdt.mint(address(aToken), 100 ether);
        _move(2, 0, 500 ether);
        assertEq(vault.managedIdle(), 1_100 ether, "Aave interest lost");
        _move(0, 1, 400 ether);
        venus.setRate(25e25);
        usdt.mint(address(venus), 100 ether);
        _move(1, 0, 500 ether);
        assertEq(vault.managedIdle(), 1_200 ether, "Venus interest lost");
        assertEq(vault.fundedPrincipal(), 1_000 ether, "yield became funding");
    }

    function test_AtomicDestinationFailureRestoresSourceAndNonce() public {
        _move(0, 1, 500 ether);
        pool.setFailSupply(true);
        uint256 shares = vault.managedVenusShares();
        uint256 nonce = vault.operationNonce();
        vm.warp(_now() + 60);
        vm.prank(address(controller));
        vm.expectRevert();
        vault.reallocate(1, 2, 300 ether, 0, nonce, _now() + 60);
        assertEq(vault.managedVenusShares(), shares, "source accounting changed");
        assertEq(venus.balanceOf(address(vault)), shares, "source receipt burned");
        assertEq(usdt.balanceOf(address(vault)), 500 ether, "partial withdrawal remained");
        assertEq(vault.operationNonce(), nonce, "nonce advanced");
        assertEq(vault.turnover(), 500 ether, "failed turnover persisted");
        assertEq(usdt.allowance(address(vault), address(pool)), 0, "approval persisted");
    }

    function test_VenusNonzeroMintAndRedeemFailClosed() public {
        venus.setCodes(7, 0);
        uint256 nonce = vault.operationNonce();
        vm.prank(address(controller));
        vm.expectRevert(abi.encodeWithSelector(YieldAllocationVault.VenusFailure.selector, 7));
        vault.reallocate(0, 1, 100 ether, 0, nonce, _now() + 60);
        venus.setCodes(0, 0);
        _move(0, 1, 100 ether);
        venus.setCodes(0, 9);
        nonce = vault.operationNonce();
        vm.warp(_now() + 60);
        vm.prank(address(controller));
        vm.expectRevert(abi.encodeWithSelector(YieldAllocationVault.VenusFailure.selector, 9));
        vault.reallocate(1, 0, 100 ether, 0, nonce, _now() + 60);
        assertEq(vault.managedIdle(), 900 ether, "failed redeem paid idle");
    }

    function test_ZeroMinCannotBypassLossProtection() public {
        pool.setSupplyBps(9_000);
        _expectMoveRevert(0, 2, 100 ether, YieldAllocationVault.ExecutionLossExceeded.selector);
        assertEq(vault.managedIdle(), 1_000 ether, "loss did not revert transfer");
        assertEq(aToken.scaledBalanceOf(address(vault)), 0, "bad receipt persisted");
    }

    function test_RateDropInsideOperationCannotHideBehindOldValuation() public {
        aToken.setIndex(2e27);
        pool.setIndexAfterSupply(1e27);
        _expectMoveRevert(0, 2, 100 ether, YieldAllocationVault.ExecutionLossExceeded.selector);
        assertEq(aToken.index(), 2e27, "rate mutation was not reverted");
    }

    function test_RateGainInsideOperationCannotHideReceiptUnderpayment() public {
        pool.setSupplyBps(9_000);
        pool.setIndexAfterSupply(2e27);
        _expectMoveRevert(0, 2, 100 ether, YieldAllocationVault.ExecutionLossExceeded.selector);
    }

    function test_IndexedReceiptOwnerRecoveryToleratesOneWeiRounding() public {
        aToken.setIndex(12e26);
        _move(0, 2, 120 ether);
        uint256 beforeScaled = vault.managedAaveScaled();
        vm.prank(OWNER);
        vault.recover(address(aToken), 1 ether + 1);
        uint256 removed = beforeScaled - vault.managedAaveScaled();
        assertTrue(removed > 0, "scaled recovery not tracked");
        assertEq(aToken.scaledBalanceOf(address(vault)), vault.managedAaveScaled(), "recovery accounting");
        assertTrue(vault.paused(), "receipt recovery failed to pause");
    }

    function test_PartialIdleExitImprovesAnUnderfundedReserve() public {
        _move(0, 1, 500 ether);
        vm.prank(OWNER);
        vault.recover(address(usdt), 500 ether);
        vm.prank(OWNER);
        vault.resume();
        _move(1, 0, 50 ether);
        assertEq(vault.managedIdle(), 50 ether, "reserve restoration was blocked");
        _expectMoveRevert(1, 2, 50 ether, YieldAllocationVault.IdleReserveViolated.selector);
    }

    function test_AgentMinimumCanTightenButNotRelaxPolicy() public {
        _move(0, 1, 100 ether);
        venus.setBps(10_000, 9_950);
        uint256 nonce = vault.operationNonce();
        vm.warp(_now() + 60);
        vm.prank(address(controller));
        vm.expectRevert(YieldAllocationVault.BalanceMismatch.selector);
        vault.reallocate(1, 0, 100 ether, 100 ether, nonce, _now() + 60);
        _move(1, 0, 100 ether);
        assertEq(vault.cumulativeLoss(), 0.5 ether, "redemption fee unaccounted");
        assertEq(vault.managedIdle(), 999.5 ether, "redemption fee assets wrong");
    }

    function test_FundingAloneRemainsPausedAndInvalidatesNonce() public {
        YieldAllocationVault empty = _deploy(_policy());
        vm.prank(OWNER);
        usdt.approve(address(empty), 100 ether);
        vm.prank(OWNER);
        empty.fund(100 ether);
        assertTrue(empty.paused(), "funding activated automation");
        assertEq(empty.operationNonce(), 1, "funding did not invalidate");
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.StrategyPaused.selector);
        empty.reallocate(0, 2, 1 ether, 0, 1, _now() + 60);
    }

    function test_PolicyHashBindsCommonLimitsAndVenueIdentities() public {
        YieldAllocationVault.YieldPolicy memory policy = _policy();
        policy.maxTurnover += 1;
        YieldAllocationVault changed = _deploy(policy);
        assertTrue(changed.policyHash() != vault.policyHash(), "yield limits not bound");
        changed = new YieldAllocationVault(
            address(controller),
            StrategyVaultBase.CommonPolicy(uint64(_now() + 1 days), 61, 300),
            YieldAllocationVault.Venues(
                address(usdt),
                address(venus),
                address(comp),
                address(pool),
                address(provider),
                address(data),
                address(aToken)
            ),
            _policy()
        );
        assertTrue(changed.policyHash() != vault.policyHash(), "common policy not bound");
        assertEq(bytes32(vault.operationSelector()), bytes32(vault.reallocate.selector), "operation selector");
    }

    function testFuzz_RoundTripConservesAndNeverReplenishesTurnover(uint96 rawAmount) public {
        uint256 amount = (uint256(rawAmount) % 500 + 1) * 1 ether;
        _move(0, 1, amount);
        _move(1, 2, amount);
        _move(2, 0, amount);
        assertEq(vault.managedIdle(), 1_000 ether, "round trip lost principal");
        assertEq(vault.turnover(), amount * 2, "turnover was reset");
        assertEq(vault.fundedPrincipal(), 1_000 ether, "funding authority changed");
    }

    function test_LossBpsAndCumulativeLossAreSeparate() public {
        pool.setSupplyBps(9_900);
        _move(0, 2, 100 ether);
        assertEq(vault.cumulativeLoss(), 1 ether, "loss not counted");
        _move(0, 2, 100 ether);
        _expectMoveRevert(0, 2, 100 ether, YieldAllocationVault.ExecutionLossExceeded.selector);
        assertEq(vault.cumulativeLoss(), 2 ether, "failed loss persisted");
        pool.setSupplyBps(9_800);
        _expectMoveRevert(0, 2, 1 ether, YieldAllocationVault.ExecutionLossExceeded.selector);
    }

    function test_DonationsCannotExpandPrincipalOrHideLoss() public {
        usdt.mint(address(vault), 10_000 ether);
        venus.mint(address(vault), 10_000_000_000_000);
        aToken.mintScaled(address(vault), 10_000 ether);
        usdt.mint(address(aToken), 10_000 ether);
        assertEq(vault.managedIdle(), 1_000 ether, "donation became allocation");
        pool.setSupplyBps(9_000);
        _expectMoveRevert(0, 2, 100 ether, YieldAllocationVault.ExecutionLossExceeded.selector);
        pool.setSupplyBps(10_000);
        _move(0, 1, 500 ether);
        _expectMoveRevert(0, 2, 500 ether, YieldAllocationVault.IdleReserveViolated.selector);
        _expectMoveRevert(2, 0, 100 ether, YieldAllocationVault.BalanceMismatch.selector);
        vm.prank(OWNER);
        vm.expectRevert(YieldAllocationVault.PrincipalExceeded.selector);
        vault.fund(1);
    }

    function test_ExposureAndPerMoveLimits() public {
        _expectMoveRevert(0, 1, 501 ether, YieldAllocationVault.InvalidMove.selector);
        _move(0, 1, 500 ether);
        _expectMoveRevert(0, 1, 400 ether, YieldAllocationVault.ExposureExceeded.selector);
        venus.setRate(4e26);
        usdt.mint(address(venus), 500 ether);
        _move(1, 0, 500 ether);
        assertEq(vault.managedIdle(), 1_000 ether, "overexposure blocked risk reduction");
    }

    function test_TurnoverExhaustionDoesNotBlockIdleExit() public {
        _move(0, 1, 500 ether);
        _move(1, 2, 500 ether);
        _move(2, 1, 500 ether);
        _move(1, 2, 500 ether);
        _expectMoveRevert(2, 1, 500 ether, YieldAllocationVault.TurnoverExceeded.selector);
        _move(2, 0, 500 ether);
        assertEq(vault.managedIdle(), 1_000 ether, "turnover locked exit");
    }

    function test_VenusRetirementPauseAndZeroCapRejectSupply() public {
        comp.setListed(false);
        _expectMoveRevert(0, 1, 100 ether, YieldAllocationVault.VenueUnavailable.selector);
        comp.setListed(true);
        comp.setGlobalPause(true);
        _expectMoveRevert(0, 1, 100 ether, YieldAllocationVault.VenueUnavailable.selector);
        comp.setGlobalPause(false);
        comp.setAction(0, true);
        _expectMoveRevert(0, 1, 100 ether, YieldAllocationVault.VenueUnavailable.selector);
        comp.setAction(0, false);
        comp.setCap(0);
        _expectMoveRevert(0, 1, 100 ether, YieldAllocationVault.VenueUnavailable.selector);
    }

    function test_AaveZeroCapUnlimitedButPauseAndFrozenBlockSupply() public {
        data.setCap(0);
        _move(0, 2, 100 ether);
        data.setFlags(true, true, false);
        _expectMoveRevert(0, 2, 100 ether, YieldAllocationVault.VenueUnavailable.selector);
        _move(2, 0, 100 ether);
        data.setFlags(true, false, true);
        _expectMoveRevert(0, 2, 100 ether, YieldAllocationVault.VenueUnavailable.selector);
        data.setFlags(false, false, false);
        _expectMoveRevert(0, 2, 100 ether, YieldAllocationVault.VenueUnavailable.selector);
    }

    function test_AaveVirtualCashAndActualWithdrawalAreChecked() public {
        _move(0, 2, 100 ether);
        pool.setAvailable(uint128(50 ether));
        _expectMoveRevert(2, 0, 100 ether, YieldAllocationVault.VenueUnavailable.selector);
        pool.setAvailable(type(uint128).max);
        pool.setWrongReturn(true);
        _expectMoveRevert(2, 0, 100 ether, YieldAllocationVault.BalanceMismatch.selector);
        pool.setWrongReturn(false);
        pool.setWithdrawBps(9_000);
        _expectMoveRevert(2, 0, 100 ether, YieldAllocationVault.BalanceMismatch.selector);
        assertEq(vault.managedAaveScaled(), 100 ether, "bad withdrawal burned receipt");
    }

    function test_RuntimeIdentityChangeStopsAllocation() public {
        provider.setPool(address(0xBAD));
        _expectMoveRevert(0, 2, 100 ether, YieldAllocationVault.InvalidVenue.selector);
        provider.setPool(address(pool));
        data.setReceipt(address(venus));
        _expectMoveRevert(0, 2, 100 ether, YieldAllocationVault.InvalidVenue.selector);
    }

    function test_ConstructorRejectsWrongChainDecimalsAndPolicy() public {
        vm.chainId(97);
        vm.expectRevert(YieldAllocationVault.InvalidYieldPolicy.selector);
        _deploy(_policy());
        vm.chainId(56);
        usdt.setDecimals(6);
        vm.expectRevert(YieldAllocationVault.InvalidVenue.selector);
        _deploy(_policy());
        usdt.setDecimals(18);
        YieldAllocationVault.YieldPolicy memory policy = _policy();
        policy.maxLossBps = 10_000;
        vm.expectRevert(YieldAllocationVault.InvalidYieldPolicy.selector);
        _deploy(policy);
    }

    function test_OnlyControllerOperatesAndCannotUseOwnerEscape() public {
        uint256 nonce = vault.operationNonce();
        vm.prank(OWNER);
        vm.expectRevert(StrategyVaultBase.NotStrategyController.selector);
        vault.reallocate(0, 1, 1 ether, 0, nonce, _now() + 60);
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.NotStrategyOwner.selector);
        vault.recover(address(usdt), 1 ether);
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.NotStrategyOwner.selector);
        vault.fund(1 ether);
    }

    function test_OwnerRecoveryWorksWithBrokenProtocolAndAfterExpiry() public {
        _move(0, 1, 500 ether);
        venus.setFailPricing(true);
        vm.warp(_now() + 2 days);
        uint256 shares = vault.managedVenusShares();
        vm.prank(OWNER);
        vault.recover(address(venus), shares);
        vm.prank(OWNER);
        vault.recover(address(usdt), 500 ether);
        assertEq(venus.balanceOf(OWNER), shares, "owner did not receive receipt");
        assertEq(vault.managedVenusShares(), 0, "receipt accounting remained");
        assertTrue(vault.paused(), "recovery did not pause");
        assertEq(vault.fundedPrincipal(), 1_000 ether, "recovery replenished authority");
    }

    function test_CurrentOwnerReplacesOldOwner() public {
        controller.setOwner(address(0xB0B));
        vm.prank(OWNER);
        vm.expectRevert(StrategyVaultBase.NotStrategyOwner.selector);
        vault.recover(address(usdt), 100 ether);
        vm.prank(address(0xB0B));
        vault.recover(address(usdt), 100 ether);
        assertEq(usdt.balanceOf(address(0xB0B)), 100 ether, "new owner cannot recover");
    }

    function test_NonceReplayCooldownAndBoundedDeadline() public {
        uint256 nonce = vault.operationNonce();
        _move(0, 1, 100 ether);
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.StaleStrategyNonce.selector);
        vault.reallocate(0, 1, 100 ether, 0, nonce, _now() + 60);
        nonce = vault.operationNonce();
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.StrategyCooldown.selector);
        vault.reallocate(0, 1, 100 ether, 0, nonce, _now() + 60);
        vm.warp(_now() + 60);
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.InvalidStrategyDeadline.selector);
        vault.reallocate(0, 1, 100 ether, 0, nonce, _now() + 301);
        vm.prank(OWNER);
        vault.recover(address(usdt), 1 ether);
        vm.prank(OWNER);
        vault.resume();
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.StaleStrategyNonce.selector);
        vault.reallocate(0, 1, 100 ether, 0, nonce, _now() + 60);
    }

    function test_FalseApprovalAndReentrancyRollback() public {
        usdt.setFalseApprove(true);
        uint256 nonce = vault.operationNonce();
        vm.prank(address(controller));
        vm.expectRevert();
        vault.reallocate(0, 1, 100 ether, 0, nonce, _now() + 60);
        usdt.setFalseApprove(false);
        usdt.setCallback(
            address(vault), abi.encodeCall(vault.reallocate, (0, 2, 1 ether, 0, nonce + 1, _now() + 60))
        );
        vm.prank(address(controller));
        vm.expectRevert(StrategyVaultBase.StrategyReentrancy.selector);
        vault.reallocate(0, 1, 100 ether, 0, nonce, _now() + 60);
        assertEq(vault.operationNonce(), nonce, "reentry consumed nonce");
        assertEq(usdt.balanceOf(address(vault)), 1_000 ether, "reentry moved funds");
        assertEq(usdt.allowance(address(vault), address(venus)), 0, "reentry left approval");
    }

    function test_ExplicitFundingRejectsTransferFee() public {
        YieldAllocationVault empty = _deploy(_policy());
        vm.prank(OWNER);
        usdt.approve(address(empty), 100 ether);
        usdt.setFee(1);
        vm.prank(OWNER);
        vm.expectRevert(YieldAllocationVault.BalanceMismatch.selector);
        empty.fund(100 ether);
        assertEq(empty.fundedPrincipal(), 0, "fee funding recorded");
        assertEq(usdt.balanceOf(address(empty)), 0, "fee transfer persisted");
    }
}
