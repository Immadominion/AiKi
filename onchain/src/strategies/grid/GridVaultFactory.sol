// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {AiKiMandateAccount} from "../../account/AiKiMandateAccount.sol";
import {StrategyVaultBase} from "../StrategyVaultBase.sol";
import {GridStrategyVault} from "./GridStrategyVault.sol";
import {IGridPool, IGridFactory, IGridRouter} from "./GridInterfaces.sol";

/// @dev Fixed reviewed Shanghai artifact. Source/compiler drift MUST fail the artifact
/// regression and be reviewed before repinning; callers cannot supply their own hash.
library GridVaultCreationArtifact {
    bytes32 internal constant CODE_HASH = 0x732e4c7e16c8696808c2d4206011d7d80e634d4a7731672827aa2810022f936f;
    uint256 internal constant CODE_LENGTH = 24_858;
}

/// @notice Owner-created fixed-pool grids for canonical BSC USDT/WBNB 0.05%.
/// @dev Vault initcode alone exceeds the EIP-170 factory runtime limit. Callers supply
/// EXACT pinned creation bytes; this factory appends all typed arguments itself.
/// No caller-selected protocol addresses, arbitrary initcode, funding, approvals or resume.
contract GridVaultFactory {
    error InvalidFactoryConfiguration();
    error UnreviewedController();
    error NotControllerOwner();
    error UnreviewedCreationCode();
    error UnreviewedProtocol();
    error OccupiedVaultAddress();
    error VaultDeploymentFailed();
    error InvalidCreatedVault();

    address public constant REVIEWED_MANAGER = 0x625cfdA19d2F4424e546B610B4CeF1F5441F84c9;
    bytes32 public constant REVIEWED_MANAGER_CODE_HASH =
        0x92a458ba7578f05c7a2bb8b21d40165309b3d10d1c75df5cdf2aec9db7880689;
    bytes32 public constant REVIEWED_CREATION_CODE_HASH = GridVaultCreationArtifact.CODE_HASH;
    uint256 public constant REVIEWED_CREATION_CODE_LENGTH = GridVaultCreationArtifact.CODE_LENGTH;
    address public constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address public constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address public constant PANCAKE_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address public constant ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    address public constant POOL = 0x36696169C63e42cd08ce11f5deeBbCeBae652050;
    uint24 public constant POOL_FEE = 500;

    address public immutable manager;
    bytes32 public immutable accountRuntimeHash;
    mapping(address => bool) public isVault;
    mapping(address => bytes32) public registeredRuntimeHash;

    event GridVaultCreated(
        address indexed vault, address indexed controller, bytes32 indexed policyHash, address owner
    );

    constructor(address manager_, bytes32 accountRuntimeHash_) {
        if (
            block.chainid != 56 || manager_ != REVIEWED_MANAGER
                || manager_.codehash != REVIEWED_MANAGER_CODE_HASH || accountRuntimeHash_ == bytes32(0)
        ) revert InvalidFactoryConfiguration();
        // Runtime includes the immutable manager. The owner is storage, not an immutable,
        // so this authenticates any current-owner account with the exact reviewed runtime.
        AiKiMandateAccount template = new AiKiMandateAccount(address(this), manager_);
        if (address(template).codehash != accountRuntimeHash_) revert InvalidFactoryConfiguration();
        manager = manager_;
        accountRuntimeHash = accountRuntimeHash_;
    }

    function canonicalProtocol() public pure returns (GridStrategyVault.Protocol memory) {
        return GridStrategyVault.Protocol(ROUTER, PANCAKE_FACTORY, POOL, USDT, WBNB);
    }

    function expectedPolicyHash(
        address controller,
        StrategyVaultBase.CommonPolicy calldata common,
        GridStrategyVault.GridPolicy calldata policy,
        GridStrategyVault.RungPolicy[] calldata rungs
    ) public view returns (bytes32) {
        // Match the vault's STRING domain tag, including the dynamic ABI encoding.
        return keccak256(
            abi.encode(
                "AIKI_PANCAKE_GRID_V1", block.chainid, controller, common, canonicalProtocol(), policy, rungs
            )
        );
    }

    /// @notice Prediction uses the CURRENT owner. Persist absolute expiry and every rung
    /// with the request; changed inputs deliberately identify a different deployment.
    function predictForController(
        address controller,
        StrategyVaultBase.CommonPolicy calldata common,
        GridStrategyVault.GridPolicy calldata policy,
        GridStrategyVault.RungPolicy[] calldata rungs,
        bytes calldata creationCode
    ) external view returns (address) {
        address owner = _reviewedOwner(controller);
        bytes memory initCode = _initCode(controller, common, policy, rungs, creationCode);
        return _predict(_salt(owner, controller, common, policy, rungs), keccak256(initCode));
    }

    /// @notice Exact retry returns an existing registered vault without resetting any
    /// funding, inventory, arming, nonce, pause or cycle state, and without a duplicate event.
    function createForController(
        address controller,
        StrategyVaultBase.CommonPolicy calldata common,
        GridStrategyVault.GridPolicy calldata policy,
        GridStrategyVault.RungPolicy[] calldata rungs,
        bytes calldata creationCode
    ) external returns (GridStrategyVault vault) {
        address owner = _reviewedOwner(controller);
        if (msg.sender != owner || msg.sender == controller) revert NotControllerOwner();
        _reviewedProtocol();
        bytes memory initCode = _initCode(controller, common, policy, rungs, creationCode);
        bytes32 salt = _salt(owner, controller, common, policy, rungs);
        address predicted = _predict(salt, keccak256(initCode));
        bytes32 expectedPolicy = expectedPolicyHash(controller, common, policy, rungs);
        if (predicted.code.length != 0 || isVault[predicted]) {
            if (!isVault[predicted] || predicted.codehash != registeredRuntimeHash[predicted]) {
                revert OccupiedVaultAddress();
            }
            vault = GridStrategyVault(predicted);
            if (vault.controller() != controller || vault.policyHash() != expectedPolicy) {
                revert OccupiedVaultAddress();
            }
            return vault;
        }
        address created;
        assembly ("memory-safe") {
            created := create2(0, add(initCode, 32), mload(initCode), salt)
        }
        if (created == address(0)) revert VaultDeploymentFailed();
        vault = GridStrategyVault(created);
        if (
            created != predicted || vault.controller() != controller || vault.policyHash() != expectedPolicy
                || !vault.paused() || vault.operationNonce() != 0 || vault.initialized()
                || vault.allocated0() != 0 || vault.allocated1() != 0 || vault.funded0() != 0
                || vault.funded1() != 0 || vault.turnover0() != 0 || vault.turnover1() != 0
                || vault.router() != ROUTER || vault.factory() != PANCAKE_FACTORY || vault.pool() != POOL
                || vault.token0() != USDT || vault.token1() != WBNB || vault.fee() != POOL_FEE
                || vault.deploymentChainId() != 56 || vault.rungCount() != rungs.length
        ) revert InvalidCreatedVault();
        isVault[created] = true;
        registeredRuntimeHash[created] = created.codehash;
        emit GridVaultCreated(created, controller, expectedPolicy, owner);
    }

    function _reviewedOwner(address controller) private view returns (address owner) {
        if (
            block.chainid != 56 || manager.codehash != REVIEWED_MANAGER_CODE_HASH
                || controller.codehash != accountRuntimeHash
        ) revert UnreviewedController();
        AiKiMandateAccount account = AiKiMandateAccount(payable(controller));
        if (account.DELEGATION_MANAGER() != manager) revert UnreviewedController();
        owner = account.owner();
        if (owner == address(0) || owner == controller) revert UnreviewedController();
    }

    function _reviewedProtocol() private view {
        if (
            POOL.code.length == 0 || ROUTER.code.length == 0 || PANCAKE_FACTORY.code.length == 0
                || USDT.code.length == 0 || WBNB.code.length == 0
                || IGridPool(POOL).factory() != PANCAKE_FACTORY || IGridPool(POOL).token0() != USDT
                || IGridPool(POOL).token1() != WBNB || IGridPool(POOL).fee() != POOL_FEE
                || IGridFactory(PANCAKE_FACTORY).getPool(USDT, WBNB, POOL_FEE) != POOL
                || IGridRouter(ROUTER).factory() != PANCAKE_FACTORY
                || IGridRouter(ROUTER).deployer() != IGridFactory(PANCAKE_FACTORY).poolDeployer()
        ) revert UnreviewedProtocol();
    }

    function _initCode(
        address controller,
        StrategyVaultBase.CommonPolicy calldata common,
        GridStrategyVault.GridPolicy calldata policy,
        GridStrategyVault.RungPolicy[] calldata rungs,
        bytes calldata creationCode
    ) private pure returns (bytes memory) {
        if (
            creationCode.length != REVIEWED_CREATION_CODE_LENGTH
                || keccak256(creationCode) != REVIEWED_CREATION_CODE_HASH
        ) revert UnreviewedCreationCode();
        return bytes.concat(creationCode, abi.encode(controller, common, canonicalProtocol(), policy, rungs));
    }

    function _salt(
        address owner,
        address controller,
        StrategyVaultBase.CommonPolicy calldata common,
        GridStrategyVault.GridPolicy calldata policy,
        GridStrategyVault.RungPolicy[] calldata rungs
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, controller, common, policy, rungs, REVIEWED_CREATION_CODE_HASH));
    }

    function _predict(bytes32 salt, bytes32 initCodeHash) private view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))))
        );
    }
}
