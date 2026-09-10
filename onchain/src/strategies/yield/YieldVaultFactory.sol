// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AiKiMandateAccount} from "../../account/AiKiMandateAccount.sol";
import {StrategyVaultBase} from "../StrategyVaultBase.sol";
import {YieldAllocationVault} from "./YieldAllocationVault.sol";

/// @notice Canonical BNB mainnet USDT yield vaults for reviewed AiKi accounts only.
/// @dev Venue addresses are pinned, not caller input. Upstream proxy governance is still
/// a trust boundary; deployment verification and the fresh planner must review implementations.
contract YieldVaultFactory {
    error InvalidFactoryConfiguration();
    error UnreviewedController();
    error NotControllerOwner();

    // AiKi's reviewed deployment manifest, not MetaMask's differently typed manager.
    address public constant REVIEWED_MANAGER = 0x625cfdA19d2F4424e546B610B4CeF1F5441F84c9;
    bytes32 public constant REVIEWED_MANAGER_CODE_HASH =
        0x92a458ba7578f05c7a2bb8b21d40165309b3d10d1c75df5cdf2aec9db7880689;
    address public constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address public constant VENUS_USDT = 0xfD5840Cd36d94D7229439859C0112a4185BC0255;
    address public constant VENUS_COMPTROLLER = 0xfD36E2c2a6789Db23113685031d7F16329158384;
    // https://github.com/aave-dao/aave-address-book/blob/main/src/ts/AaveV3BNB.ts
    address public constant AAVE_POOL = 0x6807dc923806fE8Fd134338EABCA509979a7e0cB;
    address public constant AAVE_PROVIDER = 0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D;
    address public constant AAVE_DATA_PROVIDER = 0xc90Df74A7c16245c5F5C5870327Ceb38Fe5d5328;
    address public constant AAVE_USDT_RECEIPT = 0xa9251ca9DE909CB71783723713B21E4233fbf1B1;

    address public immutable manager;
    bytes32 public immutable accountRuntimeHash;
    mapping(address => bool) public isVault;

    event YieldVaultCreated(
        address indexed vault, address indexed controller, bytes32 indexed policyHash, address owner
    );

    constructor(address manager_, bytes32 accountRuntimeHash_) {
        if (
            block.chainid != 56 || manager_ != REVIEWED_MANAGER
                || manager_.codehash != REVIEWED_MANAGER_CODE_HASH || accountRuntimeHash_ == bytes32(0)
        ) revert InvalidFactoryConfiguration();
        // Solidity forbids type(Account).runtimeCode for a contract with immutables.
        // This unfunded template derives the compiler-exact runtime with the reviewed
        // manager patched by its real constructor. The factory has no account-call escape.
        AiKiMandateAccount template = new AiKiMandateAccount(address(this), manager_);
        if (address(template).codehash != accountRuntimeHash_) revert InvalidFactoryConfiguration();
        manager = manager_;
        accountRuntimeHash = accountRuntimeHash_;
    }

    function canonicalVenues() public pure returns (YieldAllocationVault.Venues memory) {
        return YieldAllocationVault.Venues(
            USDT,
            VENUS_USDT,
            VENUS_COMPTROLLER,
            AAVE_POOL,
            AAVE_PROVIDER,
            AAVE_DATA_PROVIDER,
            AAVE_USDT_RECEIPT
        );
    }

    function createForController(
        address controller,
        StrategyVaultBase.CommonPolicy calldata common,
        YieldAllocationVault.YieldPolicy calldata policy
    ) external returns (YieldAllocationVault vault) {
        if (
            block.chainid != 56 || manager.codehash != REVIEWED_MANAGER_CODE_HASH
                || controller.codehash != accountRuntimeHash
        ) revert UnreviewedController();
        AiKiMandateAccount account = AiKiMandateAccount(payable(controller));
        if (account.DELEGATION_MANAGER() != manager) revert UnreviewedController();
        if (account.owner() != msg.sender || msg.sender == controller) revert NotControllerOwner();
        vault = new YieldAllocationVault(controller, common, canonicalVenues(), policy);
        isVault[address(vault)] = true;
        emit YieldVaultCreated(address(vault), controller, vault.policyHash(), msg.sender);
    }
}
