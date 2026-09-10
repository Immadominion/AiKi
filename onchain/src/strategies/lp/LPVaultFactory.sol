// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {AiKiMandateAccount} from "../../account/AiKiMandateAccount.sol";
import {StrategyVaultBase} from "../StrategyVaultBase.sol";
import {PancakeLPVault} from "./PancakeLPVault.sol";
import {ILPPool} from "./IPancakeLP.sol";

/// @dev Fixed reviewed Shanghai artifact. A source/compiler change MUST fail the artifact
/// pin regression and receive a fresh review/pin; callers cannot choose a different hash.
library LPVaultCreationArtifact {
    bytes32 internal constant CODE_HASH = 0xc07b021eab142a2e9f31fd976b537a5f007ef2765c192dcdeec50a95b52a070c;
    uint256 internal constant CODE_LENGTH = 26_610;
    bytes32 internal constant KIND = keccak256("AIKI_PANCAKE_LP_V1");
}

/// @notice Owner-created LP vaults for the one reviewed BSC USDT/WBNB 0.05% pool.
/// @dev The 26KB vault initcode cannot be embedded in a deployable EIP-170 factory.
/// Supply the EXACT pinned artifact as calldata; the factory verifies its hash and
/// appends its own typed constructor arguments. No user-supplied protocol addresses,
/// arbitrary initcode, delegatecall, funding, approval, enrollment or resume path.
contract LPVaultFactory {
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
    bytes32 public constant REVIEWED_CREATION_CODE_HASH = LPVaultCreationArtifact.CODE_HASH;
    uint256 public constant REVIEWED_CREATION_CODE_LENGTH = LPVaultCreationArtifact.CODE_LENGTH;

    address public constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address public constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address public constant PANCAKE_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address public constant POSITION_MANAGER = 0x46A15B0b27311cedF172AB29E4f4766fbE7F4364;
    address public constant ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    address public constant POOL = 0x36696169C63e42cd08ce11f5deeBbCeBae652050;
    uint24 public constant POOL_FEE = 500;

    address public immutable manager;
    bytes32 public immutable accountRuntimeHash;
    mapping(address => bool) public isVault;
    mapping(address => bytes32) public registeredRuntimeHash;

    event LPVaultCreated(
        address indexed vault, address indexed controller, bytes32 indexed policyHash, address owner
    );

    constructor(address manager_, bytes32 accountRuntimeHash_) {
        if (
            block.chainid != 56 || manager_ != REVIEWED_MANAGER
                || manager_.codehash != REVIEWED_MANAGER_CODE_HASH || accountRuntimeHash_ == bytes32(0)
        ) {
            revert InvalidFactoryConfiguration();
        }
        AiKiMandateAccount template = new AiKiMandateAccount(address(this), manager_);
        if (address(template).codehash != accountRuntimeHash_) revert InvalidFactoryConfiguration();
        manager = manager_;
        accountRuntimeHash = accountRuntimeHash_;
    }

    function canonicalProtocol() public pure returns (PancakeLPVault.Protocol memory) {
        return PancakeLPVault.Protocol(POSITION_MANAGER, ROUTER, POOL, USDT);
    }

    function expectedPolicyHash(
        address controller,
        StrategyVaultBase.CommonPolicy calldata common,
        PancakeLPVault.LPPolicy calldata policy
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                LPVaultCreationArtifact.KIND, block.chainid, controller, common, canonicalProtocol(), policy
            )
        );
    }

    /// @notice Read-only prediction uses the CURRENT account owner, just like creation.
    function predictForController(
        address controller,
        StrategyVaultBase.CommonPolicy calldata common,
        PancakeLPVault.LPPolicy calldata policy,
        bytes calldata creationCode
    ) external view returns (address) {
        address owner = _reviewedOwner(controller);
        bytes memory initCode = _initCode(controller, common, policy, creationCode);
        return _predict(_salt(owner, controller, common, policy), keccak256(initCode));
    }

    /// @notice Exact-input retry returns the registered vault without changing its state
    /// or emitting a second creation event. Persist the absolute expiry and full policy
    /// when preparing a request: a changed input is intentionally a different deployment.
    function createForController(
        address controller,
        StrategyVaultBase.CommonPolicy calldata common,
        PancakeLPVault.LPPolicy calldata policy,
        bytes calldata creationCode
    ) external returns (PancakeLPVault vault) {
        address owner = _reviewedOwner(controller);
        if (owner != msg.sender || msg.sender == controller) revert NotControllerOwner();
        _reviewedProtocol();
        bytes memory initCode = _initCode(controller, common, policy, creationCode);
        bytes32 salt = _salt(owner, controller, common, policy);
        address predicted = _predict(salt, keccak256(initCode));
        bytes32 expectedPolicy = expectedPolicyHash(controller, common, policy);
        if (predicted.code.length != 0 || isVault[predicted]) {
            if (!isVault[predicted] || predicted.codehash != registeredRuntimeHash[predicted]) {
                revert OccupiedVaultAddress();
            }
            vault = PancakeLPVault(predicted);
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
        vault = PancakeLPVault(created);
        if (
            created != predicted || vault.controller() != controller || vault.policyHash() != expectedPolicy
                || !vault.paused() || vault.operationNonce() != 0 || vault.enrolled()
                || vault.currentTokenId() != 0 || address(vault.positionManager()) != POSITION_MANAGER
                || address(vault.router()) != ROUTER || vault.pool() != POOL || vault.quoteToken() != USDT
                || vault.token0() != USDT || vault.token1() != WBNB || vault.fee() != POOL_FEE
        ) {
            revert InvalidCreatedVault();
        }
        isVault[created] = true;
        registeredRuntimeHash[created] = created.codehash;
        emit LPVaultCreated(created, controller, expectedPolicy, owner);
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
            POOL.code.length == 0 || POSITION_MANAGER.code.length == 0 || ROUTER.code.length == 0
                || ILPPool(POOL).factory() != PANCAKE_FACTORY || ILPPool(POOL).token0() != USDT
                || ILPPool(POOL).token1() != WBNB || ILPPool(POOL).fee() != POOL_FEE
        ) {
            revert UnreviewedProtocol();
        }
    }

    function _initCode(
        address controller,
        StrategyVaultBase.CommonPolicy calldata common,
        PancakeLPVault.LPPolicy calldata policy,
        bytes calldata creationCode
    ) private pure returns (bytes memory) {
        if (
            creationCode.length != REVIEWED_CREATION_CODE_LENGTH
                || keccak256(creationCode) != REVIEWED_CREATION_CODE_HASH
        ) revert UnreviewedCreationCode();
        return bytes.concat(creationCode, abi.encode(controller, common, canonicalProtocol(), policy));
    }

    function _salt(
        address owner,
        address controller,
        StrategyVaultBase.CommonPolicy calldata common,
        PancakeLPVault.LPPolicy calldata policy
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, controller, common, policy, REVIEWED_CREATION_CODE_HASH));
    }

    function _predict(bytes32 salt, bytes32 initCodeHash) private view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))))
        );
    }
}
