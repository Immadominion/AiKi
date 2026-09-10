// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PancakeMath} from "../../src/strategies/pancake/PancakeMath.sol";
import {IGridRouter} from "../../src/strategies/grid/GridInterfaces.sol";

contract GridMockController {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function changeOwner(address next) external {
        require(msg.sender == owner);
        owner = next;
    }
}

contract GridMockToken {
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public falseTransfer;
    bool public falseApproval;
    bool public rejectCleanup;
    bool public noReturn;
    uint16 public taxBps;
    uint16 public overDebitBps;

    function mint(address who, uint256 amount) external {
        balanceOf[who] += amount;
    }

    function burn(address who, uint256 amount) external {
        balanceOf[who] -= amount;
    }

    function behavior(bool transferFalse, bool approvalFalse, bool cleanupFails, bool optionalReturn)
        external
    {
        falseTransfer = transferFalse;
        falseApproval = approvalFalse;
        rejectCleanup = cleanupFails;
        noReturn = optionalReturn;
    }

    function fees(uint16 tax, uint16 overDebit) external {
        taxBps = tax;
        overDebitBps = overDebit;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (falseApproval || (rejectCleanup && amount == 0 && allowance[msg.sender][spender] > 0)) {
            return false;
        }
        allowance[msg.sender][spender] = amount;
        if (noReturn) assembly { return(0, 0) }
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (falseTransfer) return false;
        _transfer(msg.sender, to, amount);
        if (noReturn) assembly { return(0, 0) }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (falseTransfer) return false;
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        if (noReturn) assembly { return(0, 0) }
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount + amount * overDebitBps / 10_000;
        balanceOf[to] += amount - amount * taxBps / 10_000;
    }
}

contract GridMockDeployer {}

contract GridMockFactory {
    address public immutable poolDeployer;
    address public pool;
    address public token0;
    address public token1;
    uint24 public fee;

    constructor(address deployer_) {
        poolDeployer = deployer_;
    }

    function setPool(address pool_, address a, address b, uint24 fee_) external {
        pool = pool_;
        token0 = a;
        token1 = b;
        fee = fee_;
    }

    function getPool(address a, address b, uint24 f) external view returns (address) {
        return ((a == token0 && b == token1) || (a == token1 && b == token0)) && f == fee ? pool : address(0);
    }
}

contract GridMockPool {
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public constant fee = 500;
    int24 public spot;
    int24 public twap;
    uint128 public liquidity = 1e18;
    uint32 public history = 3600;
    bool public unlocked = true;

    constructor(address factory_, address a, address b) {
        factory = factory_;
        token0 = a;
        token1 = b;
    }

    function setTick(int24 tick) external {
        spot = tick;
        twap = tick;
    }

    function setOracle(int24 spot_, int24 twap_, uint32 history_, uint128 liquidity_, bool unlocked_)
        external
    {
        spot = spot_;
        twap = twap_;
        history = history_;
        liquidity = liquidity_;
        unlocked = unlocked_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint32, bool) {
        return (PancakeMath.sqrtRatioAtTick(spot), spot, 1, 2, 2, 0, unlocked);
    }

    function observations(uint256) external view returns (uint32, int56, uint160, bool) {
        return (uint32(block.timestamp) - history, 0, 0, true);
    }

    function observe(uint32[] calldata ago)
        external
        view
        returns (int56[] memory ticks, uint160[] memory liquidities)
    {
        ticks = new int56[](2);
        liquidities = new uint160[](2);
        ticks[1] = int56(twap) * int56(uint56(ago[0]));
        liquidities[1] = uint160((uint256(ago[0]) << 128) / liquidity);
    }
}

contract GridMockRouter is IGridRouter {
    address public immutable factory;
    address public immutable deployer;
    GridMockPool public immutable pool;
    ExactInputSingleParams private _last;
    uint256 public swaps;
    uint16 public fillBps = 10_000;
    uint16 public outputBps = 10_000;
    bool public lieAboutOutput;
    bool public noOutput;
    bool public ignoreMinimum;
    bool public failSwap;
    bool public attemptReentry;
    bool public reentryRejected;
    bool public movePrice;
    int24 public postTick;

    constructor(address factory_, address deployer_, GridMockPool pool_) {
        factory = factory_;
        deployer = deployer_;
        pool = pool_;
    }

    function configure(uint16 fill, uint16 output, bool lie, bool omit, bool ignore, bool fail) external {
        fillBps = fill;
        outputBps = output;
        lieAboutOutput = lie;
        noOutput = omit;
        ignoreMinimum = ignore;
        failSwap = fail;
    }

    function setReentry(bool value) external {
        attemptReentry = value;
    }

    function setPostTick(int24 value) external {
        movePrice = true;
        postTick = value;
    }

    function lastParams() external view returns (ExactInputSingleParams memory) {
        return _last;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 output) {
        require(!failSwap, "mock swap failure");
        require(
            msg.value == 0 && p.recipient == msg.sender && p.deadline >= block.timestamp, "bad destination"
        );
        require(p.fee == pool.fee(), "bad fee");
        bool sell = p.tokenIn == pool.token0() && p.tokenOut == pool.token1();
        require(sell || (p.tokenIn == pool.token1() && p.tokenOut == pool.token0()), "bad pair");
        uint160 sqrt = PancakeMath.sqrtRatioAtTick(pool.spot());
        require(sell ? p.sqrtPriceLimitX96 < sqrt : p.sqrtPriceLimitX96 > sqrt, "bad limit");
        _last = p;
        swaps++;
        if (attemptReentry) {
            (bool ok,) =
                msg.sender.call(abi.encodeWithSignature("execute(uint256,uint256,uint32)", 0, p.deadline, 0));
            reentryRejected = !ok;
            require(!ok, "reentry allowed");
        }
        uint256 spent = p.amountIn * fillBps / 10_000;
        output = PancakeMath.quoteAtTick(pool.spot(), uint128(spent), p.tokenIn, p.tokenOut);
        output = PancakeMath.mulDiv(output, 1_000_000 - p.fee, 1_000_000);
        output = PancakeMath.mulDiv(output, outputBps, 10_000);
        require(ignoreMinimum || output >= p.amountOutMinimum, "router min output");
        _tokenCall(
            p.tokenIn,
            abi.encodeWithSelector(GridMockToken.transferFrom.selector, msg.sender, address(this), spent)
        );
        if (!noOutput) {
            _tokenCall(
                p.tokenOut, abi.encodeWithSelector(GridMockToken.transfer.selector, p.recipient, output)
            );
        }
        if (movePrice) pool.setTick(postTick);
        if (lieAboutOutput) output++;
    }

    function _tokenCall(address token, bytes memory data) private {
        (bool ok, bytes memory result) = token.call(data);
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "mock token failure");
    }
}
