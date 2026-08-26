// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "./Test.sol";
import {AiKiDelegationManager} from "../../src/core/AiKiDelegationManager.sol";
import {AiKiEnforcerRegistry} from "../../src/registry/AiKiEnforcerRegistry.sol";
import {AiKiMandateAccount} from "../../src/account/AiKiMandateAccount.sol";
import {AmountSite, Caveat, Constants, Delegation} from "../../src/core/Types.sol";
import {EncoderLib} from "../../src/core/EncoderLib.sol";
import {ExpiryEnforcer} from "../../src/enforcers/ExpiryEnforcer.sol";
import {AllowedTargetsEnforcer} from "../../src/enforcers/AllowedTargetsEnforcer.sol";
import {AllowedSelectorsEnforcer} from "../../src/enforcers/AllowedSelectorsEnforcer.sol";
import {AssetScopeEnforcer} from "../../src/enforcers/AssetScopeEnforcer.sol";
import {PerActionCapEnforcer} from "../../src/enforcers/PerActionCapEnforcer.sol";
import {SessionTotalCapEnforcer} from "../../src/enforcers/SessionTotalCapEnforcer.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Deploys the whole suite in the order the real deployment must use, and provides the
///         encoding helpers the tests share.
abstract contract Fixture is Test {
    // TEST-ONLY SIGNING CONSTANTS. These are literal small integers used with `vm.sign` inside
    // an in-memory EVM. They are not credentials, they control no funds, and nothing in this
    // repository is ever deployed or broadcast.
    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant AGENT_PK = 0xA6E17;
    uint256 internal constant STRANGER_PK = 0xB0B;

    address internal owner;
    address internal agent;
    address internal stranger;
    address internal recipient = address(0xBEEF00);

    bytes4 internal constant TRANSFER_SELECTOR = bytes4(keccak256("transfer(address,uint256)"));

    ExpiryEnforcer internal expiryE;
    AllowedTargetsEnforcer internal targetsE;
    AllowedSelectorsEnforcer internal selectorsE;
    AssetScopeEnforcer internal assetsE;
    PerActionCapEnforcer internal perActionE;
    SessionTotalCapEnforcer internal sessionE;
    AiKiDelegationManager internal manager;
    AiKiEnforcerRegistry internal registry;
    AiKiMandateAccount internal account;
    MockERC20 internal token;

    function deploySuite() internal {
        owner = vm.addr(OWNER_PK);
        agent = vm.addr(AGENT_PK);
        stranger = vm.addr(STRANGER_PK);

        // Deployment order is load-bearing. The manager pins the expiry enforcer (every
        // delegation must carry one at caveat index 0), and the stateful enforcers pin the
        // manager. That breaks the cycle: stateless enforcers first, then the manager, then
        // the stateful enforcers, then the registry.
        expiryE = new ExpiryEnforcer();
        targetsE = new AllowedTargetsEnforcer();
        selectorsE = new AllowedSelectorsEnforcer();
        assetsE = new AssetScopeEnforcer();

        manager = new AiKiDelegationManager(address(expiryE));

        perActionE = new PerActionCapEnforcer(address(manager));
        sessionE = new SessionTotalCapEnforcer(address(manager));

        string[] memory names = new string[](6);
        address[] memory addrs = new address[](6);
        names[0] = "ExpiryEnforcer";
        addrs[0] = address(expiryE);
        names[1] = "AllowedTargetsEnforcer";
        addrs[1] = address(targetsE);
        names[2] = "AllowedSelectorsEnforcer";
        addrs[2] = address(selectorsE);
        names[3] = "AssetScopeEnforcer";
        addrs[3] = address(assetsE);
        names[4] = "PerActionCapEnforcer";
        addrs[4] = address(perActionE);
        names[5] = "SessionTotalCapEnforcer";
        addrs[5] = address(sessionE);
        registry = new AiKiEnforcerRegistry(address(manager), names, addrs);

        account = new AiKiMandateAccount(owner, address(manager));
        token = new MockERC20();
        token.mint(address(account), 1_000_000 ether);

        vm.label(address(manager), "manager");
        vm.label(address(account), "account");
        vm.label(address(token), "token");
    }

    // ---------------------------------------------------------------- encoding helpers

    function execOf(address target, uint256 value, bytes memory callData)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(bytes20(target), bytes32(value), callData);
    }

    function contextOf(Delegation memory d) internal pure returns (bytes memory) {
        Delegation[] memory ds = new Delegation[](1);
        ds[0] = d;
        return abi.encode(ds);
    }

    function digestOf(Delegation memory d) internal view returns (bytes32) {
        return EncoderLib.toDigest(manager.domainSeparator(), EncoderLib.hashDelegation(d));
    }

    function signAs(uint256 pk, Delegation memory d) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digestOf(d));
        return abi.encodePacked(r, s, v);
    }

    function baseDelegation(address delegator, Caveat[] memory caveats)
        internal
        pure
        returns (Delegation memory d)
    {
        d.delegate = address(0); // caller fills in
        d.delegator = delegator;
        d.authority = Constants.ROOT_AUTHORITY;
        d.caveats = caveats;
        d.salt = 1;
        d.epoch = 0;
    }

    function packAddresses(address[] memory xs) internal pure returns (bytes memory out) {
        for (uint256 i; i < xs.length; ++i) {
            out = bytes.concat(out, bytes20(xs[i]));
        }
    }

    function packSelectors(bytes4[] memory xs) internal pure returns (bytes memory out) {
        for (uint256 i; i < xs.length; ++i) {
            out = bytes.concat(out, xs[i]);
        }
    }

    function one(address a) internal pure returns (address[] memory xs) {
        xs = new address[](1);
        xs[0] = a;
    }

    function one(bytes4 a) internal pure returns (bytes4[] memory xs) {
        xs = new bytes4[](1);
        xs[0] = a;
    }

    function siteFor(address target, bytes4 selector, address asset, uint8 argIndex)
        internal
        pure
        returns (AmountSite[] memory sites)
    {
        sites = new AmountSite[](1);
        sites[0] = AmountSite({target: target, selector: selector, asset: asset, argIndex: argIndex});
    }

    function capTerms(address asset, uint256 cap, AmountSite[] memory sites)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(asset, cap, sites);
    }

    function expiryCaveat(uint256 expiresAt) internal view returns (Caveat memory) {
        return Caveat({enforcer: address(expiryE), terms: abi.encode(expiresAt), args: ""});
    }

    // ---------------------------------------------------------------- redemption helpers

    function redeemAs(address who, Delegation memory d, bytes32 mode, bytes memory exec) internal {
        bytes[] memory contexts = new bytes[](1);
        contexts[0] = contextOf(d);
        bytes32[] memory modes = new bytes32[](1);
        modes[0] = mode;
        bytes[] memory execs = new bytes[](1);
        execs[0] = exec;
        vm.prank(who);
        manager.redeemDelegations(contexts, modes, execs);
    }

    function redeem(Delegation memory d, bytes memory exec) internal {
        redeemAs(agent, d, bytes32(0), exec);
    }

    /// @dev Prepares the three redemption arrays so a test can put `vm.expectRevert`
    ///      immediately before the external call, with no cheatcode in between.
    function prep(Delegation memory d, bytes32 mode, bytes memory exec)
        internal
        pure
        returns (bytes[] memory contexts, bytes32[] memory modes, bytes[] memory execs)
    {
        contexts = new bytes[](1);
        contexts[0] = contextOf(d);
        modes = new bytes32[](1);
        modes[0] = mode;
        execs = new bytes[](1);
        execs[0] = exec;
    }

    /// @notice The mandate shape the product actually issues: "this agent may call transfer on
    ///         this token, at most `perCap` per action and `sessionCap` in total, until
    ///         `expiresAt`."
    function standardMandate(uint256 perCap, uint256 sessionCap, uint256 expiresAt)
        internal
        view
        returns (Delegation memory d)
    {
        return mandateFor(address(token), perCap, sessionCap, expiresAt);
    }

    /// @dev The same mandate over an arbitrary token, so a test can hand the account something
    ///      that does not behave like MockERC20.
    function mandateFor(address asset, uint256 perCap, uint256 sessionCap, uint256 expiresAt)
        internal
        view
        returns (Delegation memory d)
    {
        AmountSite[] memory sites = siteFor(asset, TRANSFER_SELECTOR, asset, 1);

        Caveat[] memory caveats = new Caveat[](6);
        caveats[0] = expiryCaveat(expiresAt);
        caveats[1] = Caveat({enforcer: address(targetsE), terms: packAddresses(one(asset)), args: ""});
        caveats[2] =
            Caveat({enforcer: address(selectorsE), terms: packSelectors(one(TRANSFER_SELECTOR)), args: ""});
        caveats[3] = Caveat({enforcer: address(assetsE), terms: abi.encode(one(asset), sites), args: ""});
        caveats[4] = Caveat({enforcer: address(perActionE), terms: capTerms(asset, perCap, sites), args: ""});
        caveats[5] =
            Caveat({enforcer: address(sessionE), terms: capTerms(asset, sessionCap, sites), args: ""});

        d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);
    }

    function transferExec(uint256 amount) internal view returns (bytes memory) {
        return execOf(address(token), 0, abi.encodeWithSelector(TRANSFER_SELECTOR, recipient, amount));
    }

    /// @dev Storage slot of SessionTotalCapEnforcer._spent[manager][hash]. `_spent` is the
    ///      first declared mapping so it occupies slot 0; every test that uses this asserts
    ///      the seeded value back through `spentOf`, so a layout change fails loudly rather
    ///      than silently seeding the wrong slot.
    function sessionSpentSlot(address manager_, bytes32 delegationHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(delegationHash, keccak256(abi.encode(manager_, uint256(0)))));
    }
}
