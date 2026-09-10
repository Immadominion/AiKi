// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {PancakeMath} from "../../src/strategies/pancake/PancakeMath.sol";
import {ILPPositionManager, ILPRouter} from "../../src/strategies/lp/IPancakeLP.sol";

contract LPControllerMock {
    address public owner;

    constructor(address initialOwner) {
        owner = initialOwner;
    }

    function changeOwner(address next) external {
        owner = next;
    }
}

contract LPTokenMock {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failTransfer;
    bool public failApproval;
    bool public tax;

    function configure(bool transferFail, bool approvalFail, bool transferTax) external {
        failTransfer = transferFail;
        failApproval = approvalFail;
        tax = transferTax;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function burn(address from, uint256 amount) external {
        balanceOf[from] -= amount;
    }

    function approve(address to, uint256 amount) external returns (bool) {
        if (failApproval) return false;
        allowance[msg.sender][to] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfer) return false;
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failTransfer) return false;
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += tax && amount > 0 ? amount - 1 : amount;
    }
}

contract LPPoolMock {
    address public factory;
    address public token0;
    address public token1;
    uint24 public constant fee = 500;
    int24 public constant tickSpacing = 10;
    int24 public tick;
    int24 public meanTick;
    int56 public cumulativeRemainder;
    uint128 public liquidity = 1e24;
    uint128 public harmonicLiquidity = 1e24;
    uint32 public age = 3600;
    bool public unlocked = true;
    bool public initialized = true;
    bool public observeFails;
    bool public malformed;
    uint160 public sqrtOverride;
    int56 public tickCumulativeStart;
    uint160 public liquidityCumulativeStart;

    constructor(address a, address b) {
        token0 = a;
        token1 = b;
    }

    function setFactory(address f) external {
        factory = f;
    }

    function setTick(int24 next) external {
        tick = next;
    }

    function setMean(int24 next, int56 remainder) external {
        meanTick = next;
        cumulativeRemainder = remainder;
    }

    function setLiquidity(uint128 next) external {
        liquidity = next;
    }

    function setOracle(uint32 nextAge, bool nextInitialized, bool fails, bool badArrays) external {
        age = nextAge;
        initialized = nextInitialized;
        observeFails = fails;
        malformed = badArrays;
    }

    function setSqrt(uint160 sqrt) external {
        sqrtOverride = sqrt;
    }

    function setCumulativeStarts(int56 t, uint160 l) external {
        tickCumulativeStart = t;
        liquidityCumulativeStart = l;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint32, bool) {
        return
            (sqrtOverride == 0 ? PancakeMath.sqrtRatioAtTick(tick) : sqrtOverride, tick, 0, 1, 1, 0, unlocked);
    }

    function observations(uint256) external view returns (uint32, int56, uint160, bool) {
        return (uint32(block.timestamp) - age, 0, 0, initialized);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory ticks, uint160[] memory secondsPerLiquidity)
    {
        require(!observeFails, "OLD");
        uint256 length = malformed ? 1 : 2;
        ticks = new int56[](length);
        secondsPerLiquidity = new uint160[](length);
        if (length == 2) {
            ticks[0] = tickCumulativeStart;
            secondsPerLiquidity[0] = liquidityCumulativeStart;
            unchecked {
                ticks[1] = tickCumulativeStart + int56(meanTick) * int56(uint56(secondsAgos[0]))
                    + cumulativeRemainder;
                secondsPerLiquidity[1] =
                    liquidityCumulativeStart + uint160((uint256(secondsAgos[0]) << 128) / harmonicLiquidity);
            }
        }
    }
}

contract LPFactoryMock {
    address public immutable pool;
    address public immutable poolDeployer;

    constructor(address p) {
        pool = p;
        poolDeployer = p;
    }

    function getPool(address a, address b, uint24 f) external view returns (address) {
        LPPoolMock p = LPPoolMock(pool);
        return a == p.token0() && b == p.token1() && f == p.fee() ? pool : address(0);
    }
}

interface ILPNFTReceiverMock {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}

contract LPManagerMock is ILPPositionManager {
    address public immutable factory;
    address public immutable deployer;
    LPPoolMock public immutable pool;
    mapping(uint256 => Position) private data;
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    uint256 public nextId = 1;
    uint8 public failStage;
    bool public badRecipient;
    uint16 public burnHaircutBps;
    uint128 public collectShortfall;
    uint128 public afterRemoveLiquidity;
    address public reentryTarget;
    bytes public reentryData;

    constructor(address f, address p) {
        factory = f;
        deployer = p;
        pool = LPPoolMock(p);
    }

    function setFailure(uint8 stage) external {
        failStage = stage;
    }

    function setBadRecipient(bool b) external {
        badRecipient = b;
    }

    function setBurnHaircut(uint16 haircutBps) external {
        burnHaircutBps = haircutBps;
    }

    function setCollectShortfall(uint128 amount) external {
        collectShortfall = amount;
    }

    function setAfterRemoveLiquidity(uint128 l) external {
        afterRemoveLiquidity = l;
    }

    function setReentry(address target, bytes calldata callData) external {
        reentryTarget = target;
        reentryData = callData;
    }

    function positions(uint256 id) external view returns (Position memory) {
        require(ownerOf[id] != address(0));
        return data[id];
    }

    function seed(address owner, int24 lower, int24 upper, uint128 l, uint128 fees0, uint128 fees1)
        external
        returns (uint256 id)
    {
        id = nextId++;
        data[id] = Position(
            0, address(0), pool.token0(), pool.token1(), pool.fee(), lower, upper, l, 0, 0, fees0, fees1
        );
        ownerOf[id] = owner;
        (uint256 a, uint256 b) = _amounts(lower, upper, l);
        LPTokenMock(pool.token0()).mint(address(this), a + fees0);
        LPTokenMock(pool.token1()).mint(address(this), b + fees1);
    }

    function approve(address operator, uint256 id) external {
        require(msg.sender == ownerOf[id]);
        getApproved[id] = operator;
    }

    function increaseUnsolicited(uint256 id) external {
        data[id].liquidity++;
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(failStage != 5, "transfer failure");
        require(
            ownerOf[id] == from && (msg.sender == from || getApproved[id] == msg.sender), "NFT permission"
        );
        ownerOf[id] = to;
        getApproved[id] = address(0);
        if (to.code.length != 0) {
            require(ILPNFTReceiverMock(to).onERC721Received(msg.sender, from, id, "") == 0x150b7a02);
        }
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata p)
        external
        payable
        returns (uint256 a, uint256 b)
    {
        require(failStage != 1, "decrease failure");
        require(ownerOf[p.tokenId] == msg.sender && block.timestamp <= p.deadline);
        Position storage position = data[p.tokenId];
        require(position.liquidity >= p.liquidity && p.liquidity > 0);
        (a, b) = _amounts(position.tickLower, position.tickUpper, p.liquidity);
        a = PancakeMath.mulDiv(a, 10_000 - burnHaircutBps, 10_000);
        b = PancakeMath.mulDiv(b, 10_000 - burnHaircutBps, 10_000);
        require(a >= p.amount0Min && b >= p.amount1Min, "burn slippage");
        position.liquidity -= p.liquidity;
        position.tokensOwed0 += uint128(a);
        position.tokensOwed1 += uint128(b);
        if (afterRemoveLiquidity != 0) pool.setLiquidity(afterRemoveLiquidity);
        if (reentryTarget != address(0)) {
            (bool ok,) = reentryTarget.call(reentryData);
            require(ok, "reentry rejected");
        }
    }

    function collect(CollectParams calldata p) external payable returns (uint256 a, uint256 b) {
        require(failStage != 2, "collect failure");
        require(ownerOf[p.tokenId] == msg.sender && p.recipient == msg.sender);
        Position storage position = data[p.tokenId];
        a = position.tokensOwed0;
        b = position.tokensOwed1;
        a -= collectShortfall;
        b -= collectShortfall;
        position.tokensOwed0 = 0;
        position.tokensOwed1 = 0;
        require(LPTokenMock(pool.token0()).transfer(p.recipient, a));
        require(LPTokenMock(pool.token1()).transfer(p.recipient, b));
    }

    function mint(MintParams calldata p)
        external
        payable
        returns (uint256 id, uint128 l, uint256 a, uint256 b)
    {
        require(failStage != 3, "mint failure");
        require(
            p.token0 == pool.token0() && p.token1 == pool.token1() && p.fee == pool.fee()
                && p.recipient == msg.sender && block.timestamp <= p.deadline
        );
        l = PancakeMath.liquidityForAmounts(
            PancakeMath.sqrtRatioAtTick(pool.tick()),
            PancakeMath.sqrtRatioAtTick(p.tickLower),
            PancakeMath.sqrtRatioAtTick(p.tickUpper),
            p.amount0Desired,
            p.amount1Desired
        );
        (a, b) = _amounts(p.tickLower, p.tickUpper, l);
        require(a >= p.amount0Min && b >= p.amount1Min, "mint slippage");
        require(LPTokenMock(p.token0).transferFrom(msg.sender, address(this), a));
        require(LPTokenMock(p.token1).transferFrom(msg.sender, address(this), b));
        id = nextId++;
        data[id] = Position(0, address(0), p.token0, p.token1, p.fee, p.tickLower, p.tickUpper, l, 0, 0, 0, 0);
        ownerOf[id] = badRecipient ? address(0xBAD) : p.recipient;
    }

    function burn(uint256 id) external payable {
        require(failStage != 4, "burn failure");
        require(
            ownerOf[id] == msg.sender && data[id].liquidity == 0 && data[id].tokensOwed0 == 0
                && data[id].tokensOwed1 == 0
        );
        delete ownerOf[id];
        delete data[id];
    }

    function _amounts(int24 lower, int24 upper, uint128 l) private view returns (uint256, uint256) {
        return PancakeMath.amountsForLiquidity(
            PancakeMath.sqrtRatioAtTick(pool.tick()),
            PancakeMath.sqrtRatioAtTick(lower),
            PancakeMath.sqrtRatioAtTick(upper),
            l
        );
    }
}

contract LPRouterMock is ILPRouter {
    address public immutable factory;
    address public immutable deployer;
    uint16 public fillBps = 10_000;
    uint16 public outputBps = 10_000;
    bool public fail;
    bool public badReport;
    bool public movePrice;
    int24 public nextTick;

    constructor(address f, address p) {
        factory = f;
        deployer = p;
    }

    function configure(uint16 fill, uint16 output, bool failure) external {
        fillBps = fill;
        outputBps = output;
        fail = failure;
    }

    function setBadReport() external {
        badReport = true;
    }

    function setNextTick(int24 t) external {
        movePrice = true;
        nextTick = t;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 output) {
        require(!fail, "swap failure");
        require(p.recipient == msg.sender && p.deadline >= block.timestamp && p.sqrtPriceLimitX96 != 0);
        uint256 input = PancakeMath.mulDiv(p.amountIn, fillBps, 10_000);
        output = PancakeMath.mulDiv(input, outputBps, 10_000);
        require(output >= p.amountOutMinimum, "swap slippage");
        require(LPTokenMock(p.tokenIn).transferFrom(msg.sender, address(this), input));
        require(LPTokenMock(p.tokenOut).transfer(msg.sender, output));
        if (movePrice) LPPoolMock(deployer).setTick(nextTick);
        if (badReport) output++;
    }
}
