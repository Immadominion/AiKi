// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./base/Fixture.sol";
import {Caveat, Delegation} from "../src/core/Types.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice The other half of the product's central claim, checked rather than assumed.
///
/// @dev AiKi tells a person that the limit they set is the limit the chain refuses to exceed.
///      That sentence spans two languages. `compileCaveats` produces caveat terms in
///      TypeScript; these enforcers read those terms in Solidity. Nothing made the two agree,
///      and a terms encoding that is subtly wrong does not fail loudly. It produces a mandate
///      that either reverts everything, or -- far worse -- enforces nothing while rendering in
///      the UI as enforced. The second failure is invisible from both sides.
///
///      So the bytes replayed here are not transcribed. `tools/gen-caveat-vectors.mjs` imports
///      the real compiler and records exactly what it emits, and this test hands those bytes to
///      the real enforcers and asserts the verdict the compiler promised. Either side moving
///      turns this red.
///
///      Enforcer ADDRESSES are substituted, because where a contract landed is not what is
///      under test. The token is placed at the address the corpus embeds in its cap terms,
///      since a cap denominated in an asset the enforcer cannot find is a different test.
contract CaveatParityTest is Fixture {
    string internal json;
    uint256 internal constant NOW = 1_900_000_000;

    function setUp() public {
        json = vm.readFile("./test/vectors/caveat-vectors.json");
    }

    function test_EveryCompiledMandateEnforcesWhatItPromised() public {
        uint256 count = vm.parseJsonUint(json, ".count");
        assertTrue(count > 0, "corpus is empty");
        for (uint256 i; i < count; ++i) {
            _runRow(i);
        }
    }

    /// @notice Guards the corpus: a suite that refused everything would pass an all-deny corpus.
    function test_CorpusExercisesBothVerdicts() public {
        uint256 count = vm.parseJsonUint(json, ".count");
        uint256 allows;
        uint256 denies;
        for (uint256 i; i < count; ++i) {
            string memory p = string.concat(".rows[", vm.toString(i), "]");
            uint256 actions = vm.parseJsonUint(json, string.concat(p, ".actionCount"));
            for (uint256 j; j < actions; ++j) {
                if (
                    vm.parseJsonBool(
                        json, string.concat(p, ".actions[", vm.toString(j), "].allow")
                    )
                ) allows++;
                else denies++;
            }
        }
        emit log_named_uint("actions expecting allow", allows);
        emit log_named_uint("actions expecting deny ", denies);
        assertTrue(allows > 0, "corpus never exercises the allow path");
        assertTrue(denies > 0, "corpus never exercises the deny path");
    }

    function _runRow(uint256 i) internal {
        string memory p = string.concat(".rows[", vm.toString(i), "]");
        string memory name = vm.parseJsonString(json, string.concat(p, ".name"));

        // A fresh suite per row: session caps are stateful and must not leak between cases.
        deploySuite();
        vm.warp(NOW);

        address asset = vm.parseAddress(vm.parseJsonString(json, string.concat(p, ".asset")));
        address target = vm.parseAddress(vm.parseJsonString(json, string.concat(p, ".target")));

        // The cap terms name this asset, so a token has to exist there.
        vm.etch(asset, address(token).code);
        MockERC20(asset).mint(address(account), 1_000_000 ether);

        Delegation memory d = _delegationFrom(p);

        uint256 actions = vm.parseJsonUint(json, string.concat(p, ".actionCount"));
        for (uint256 j; j < actions; ++j) {
            string memory a = string.concat(p, ".actions[", vm.toString(j), "]");
            bytes4 selector = parseSelector(vm.parseJsonString(json, string.concat(a, ".selector")));
            uint256 amount = vm.parseUint(vm.parseJsonString(json, string.concat(a, ".amount")));
            bool expectAllow = vm.parseJsonBool(json, string.concat(a, ".allow"));
            // `approve` authorises a spend without moving anything, so the cap
            // enforcers have no realised amount to reconcile and the declared one
            // is all that stands between the cap and an unlimited approval.
            bool moves = vm.parseJsonBool(json, string.concat(a, ".moves"));

            uint256 before = MockERC20(asset).balanceOf(address(account));
            bool landed = _tryRedeem(d, target, selector, amount);
            uint256 afterBalance = MockERC20(asset).balanceOf(address(account));

            string memory where = string.concat(name, " :: action ", vm.toString(j));
            assertEq(landed, expectAllow, string.concat("verdict disagrees with the compiler: ", where));
            // A refusal that still moved value would be the worst possible outcome: the
            // mandate would read as enforced and the money would be gone anyway.
            if (!expectAllow || !moves) {
                assertEq(afterBalance, before, string.concat("value moved when it should not have: ", where));
            } else {
                assertEq(before - afterBalance, amount, string.concat("allowed but moved the wrong amount: ", where));
            }
        }
    }

    function _delegationFrom(string memory p) internal view returns (Delegation memory d) {
        uint256 n = vm.parseJsonUint(json, string.concat(p, ".caveatCount"));
        Caveat[] memory caveats = new Caveat[](n);
        for (uint256 k; k < n; ++k) {
            string memory c = string.concat(p, ".caveats[", vm.toString(k), "]");
            caveats[k] = Caveat({
                enforcer: _enforcerNamed(vm.parseJsonString(json, string.concat(c, ".enforcer"))),
                terms: parseBytes(vm.parseJsonString(json, string.concat(c, ".terms"))),
                args: ""
            });
        }
        d = baseDelegation(address(account), caveats);
        d.delegate = agent;
        d.signature = signAs(OWNER_PK, d);
    }

    /// @dev Names, not addresses: the corpus is about terms, and every deployment lands
    ///      its enforcers somewhere different.
    function _enforcerNamed(string memory name) internal view returns (address) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256("ExpiryEnforcer")) return address(expiryE);
        if (h == keccak256("AllowedTargetsEnforcer")) return address(targetsE);
        if (h == keccak256("AllowedSelectorsEnforcer")) return address(selectorsE);
        if (h == keccak256("AssetScopeEnforcer")) return address(assetsE);
        if (h == keccak256("PerActionCapEnforcer")) return address(perActionE);
        if (h == keccak256("SessionTotalCapEnforcer")) return address(sessionE);
        revert(string.concat("corpus names an enforcer this suite does not deploy: ", name));
    }

    function _tryRedeem(Delegation memory d, address target, bytes4 selector, uint256 amount)
        internal
        returns (bool landed)
    {
        bytes memory exec =
            execOf(target, 0, abi.encodeWithSelector(selector, recipient, amount));
        bytes[] memory contexts = new bytes[](1);
        contexts[0] = contextOf(d);
        bytes32[] memory modes = new bytes32[](1);
        modes[0] = bytes32(0);
        bytes[] memory execs = new bytes[](1);
        execs[0] = exec;

        vm.prank(agent);
        try manager.redeemDelegations(contexts, modes, execs) {
            return true;
        } catch {
            return false;
        }
    }

    /// @dev "0xabcd" to bytes. The corpus carries terms as hex strings because the JSON
    ///      cheatcodes this repository declares read strings, not bytes.
    function parseBytes(string memory hexStr) internal pure returns (bytes memory out) {
        bytes memory s = bytes(hexStr);
        require(s.length >= 2 && s[0] == "0" && (s[1] == "x" || s[1] == "X"), "not 0x-prefixed");
        uint256 n = (s.length - 2) / 2;
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = bytes1((_hexNibble(uint8(s[2 + i * 2])) << 4) | _hexNibble(uint8(s[3 + i * 2])));
        }
    }

    function _hexNibble(uint8 c) private pure returns (uint8) {
        if (c >= 48 && c <= 57) return c - 48;
        if (c >= 97 && c <= 102) return c - 87;
        if (c >= 65 && c <= 70) return c - 55;
        revert("not hex");
    }
}
