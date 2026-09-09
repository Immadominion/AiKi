// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AiKiDelegationManager} from "../src/core/AiKiDelegationManager.sol";
import {AiKiEnforcerRegistry} from "../src/registry/AiKiEnforcerRegistry.sol";
import {ExpiryEnforcer} from "../src/enforcers/ExpiryEnforcer.sol";
import {AllowedTargetsEnforcer} from "../src/enforcers/AllowedTargetsEnforcer.sol";
import {AllowedSelectorsEnforcer} from "../src/enforcers/AllowedSelectorsEnforcer.sol";
import {AssetScopeEnforcer} from "../src/enforcers/AssetScopeEnforcer.sol";
import {PerActionCapEnforcer} from "../src/enforcers/PerActionCapEnforcer.sol";
import {SessionTotalCapEnforcer} from "../src/enforcers/SessionTotalCapEnforcer.sol";

interface VmScript {
    function envUint(string calldata name) external view returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @title Deploy
/// @notice Deploys the mandate suite to an explicitly selected network. The existing pinned
///         suite is on chain97; a mainnet deployment must be separately verified and recorded.
///
/// @dev Deployment ORDER is load-bearing and the constructor arguments encode a cycle that has
///      to be broken in exactly this direction:
///
///        1. Stateless enforcers, including ExpiryEnforcer. They pin nothing, because they
///           write nothing -- an unauthenticated call to a stateless hook cannot poison
///           anything.
///        2. The manager, which pins ExpiryEnforcer as an immutable. Every delegation must
///           carry that enforcer at caveat index 0 or redemption reverts, so an unbounded
///           standing authorization cannot be signed by accident.
///        3. The stateful enforcers, which pin the manager as an immutable so nobody else can
///           reach their counters.
///        4. The registry, which records the whole set. This is what the UI must resolve
///           `enforcedBy` against before it renders a T0 badge.
///
///      BEFORE RUNNING THIS ANYWHERE THAT MATTERS, verify all of the following, because each
///      one is a condition on which the T0 claim depends and none of them is enforced by code:
///        - the deployed bytecode is source-verified on the explorer;
///        - no contract in the set is behind a proxy, has an owner, or has a pause;
///        - the API pins these exact addresses AND their code hashes at startup, the same way
///          it pins the ERC-8183 implementation;
///        - the delegator account grants the agent no execution authority except through this
///          manager. T0 is a property of the ACCOUNT, not of the caveat set: if the agent's key
///          is also an owner or a second executor, the caveats are decoration.
contract Deploy {
    VmScript internal constant vm = VmScript(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external {
        // Refuse the wrong RPC before accessing a signing key or creating a transaction.
        uint256 expectedChainId = vm.envUint("EXPECTED_CHAIN_ID");
        require(expectedChainId == 56 || expectedChainId == 97, "Unsupported deployment network");
        require(block.chainid == expectedChainId, "Deployment RPC network mismatch");
        // No default. If PRIVATE_KEY is unset this reverts, which is the correct behaviour:
        // a deploy script that falls back to a hardcoded key is how test keys reach mainnet.
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        ExpiryEnforcer expiry = new ExpiryEnforcer();
        AllowedTargetsEnforcer targets = new AllowedTargetsEnforcer();
        AllowedSelectorsEnforcer selectors = new AllowedSelectorsEnforcer();
        AssetScopeEnforcer assets = new AssetScopeEnforcer();

        AiKiDelegationManager manager = new AiKiDelegationManager(address(expiry));

        PerActionCapEnforcer perAction = new PerActionCapEnforcer(address(manager));
        SessionTotalCapEnforcer session = new SessionTotalCapEnforcer(address(manager));

        string[] memory names = new string[](6);
        address[] memory addrs = new address[](6);
        names[0] = "ExpiryEnforcer";
        addrs[0] = address(expiry);
        names[1] = "AllowedTargetsEnforcer";
        addrs[1] = address(targets);
        names[2] = "AllowedSelectorsEnforcer";
        addrs[2] = address(selectors);
        names[3] = "AssetScopeEnforcer";
        addrs[3] = address(assets);
        names[4] = "PerActionCapEnforcer";
        addrs[4] = address(perAction);
        names[5] = "SessionTotalCapEnforcer";
        addrs[5] = address(session);

        new AiKiEnforcerRegistry(address(manager), names, addrs);

        vm.stopBroadcast();

        // Deliberately NOT deployed here: AiKiMandateAccount. One account belongs to one user
        // and is deployed per user with that user as `owner` and this manager as its only
        // executor. Deploying a shared one would be a shared custody contract.
    }
}
