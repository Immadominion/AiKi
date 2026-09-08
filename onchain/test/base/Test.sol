// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "./Vm.sol";

/// @notice Minimal test base. No forge-std; this repository vendors nothing.
/// @dev Assertions delegate to Foundry's assertion CHEATCODES, which revert on failure. An
///      earlier version of this file recorded failures in a `failed()` flag the way old DSTest
///      did; modern Foundry does not read it, so every assertion silently passed. It was caught
///      by mutating `amount > cap` to `amount >= cap` in PerActionCapEnforcer and watching the
///      parity suite stay green. A harness that cannot fail proves nothing, so that mutation is
///      worth re-running whenever this file changes.
abstract contract Test {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event log(string);
    event log_named_string(string key, string val);
    event log_named_uint(string key, uint256 val);
    event log_named_address(string key, address val);
    event log_named_bytes32(string key, bytes32 val);
    event log_named_bytes(string key, bytes val);

    function assertTrue(bool condition, string memory err) internal pure {
        vm.assertTrue(condition, err);
    }

    function assertFalse(bool condition, string memory err) internal pure {
        vm.assertFalse(condition, err);
    }

    function assertEq(uint256 a, uint256 b, string memory err) internal pure {
        vm.assertEq(a, b, err);
    }

    function assertEq(address a, address b, string memory err) internal pure {
        vm.assertEq(a, b, err);
    }

    function assertEq(bytes32 a, bytes32 b, string memory err) internal pure {
        vm.assertEq(a, b, err);
    }

    function assertEq(bool a, bool b, string memory err) internal pure {
        vm.assertEq(a, b, err);
    }

    function assertEq(string memory a, string memory b, string memory err) internal pure {
        vm.assertEq(a, b, err);
    }

    function assertEq(bytes memory a, bytes memory b, string memory err) internal pure {
        vm.assertEq(a, b, err);
    }

    /// @dev `vm.parseBytes32` requires a full 32-byte word, so a canonical 4-byte selector
    ///      string has to be parsed here. Accepts exactly "0x" + 8 hex digits, which is the
    ///      only selector form the policy compiler may emit.
    function parseSelector(string memory hexStr) internal pure returns (bytes4) {
        bytes memory b = bytes(hexStr);
        require(b.length == 10 && b[0] == "0" && b[1] == "x", "selector must be 0x + 8 hex digits");
        uint32 acc;
        for (uint256 i = 2; i < 10; ++i) {
            acc = (acc << 4) | uint32(_nibble(uint8(b[i])));
        }
        return bytes4(acc);
    }

    function _nibble(uint8 c) private pure returns (uint8) {
        if (c >= 48 && c <= 57) return c - 48; // 0-9
        if (c >= 97 && c <= 102) return c - 87; // a-f
        if (c >= 65 && c <= 70) return c - 55; // A-F
        revert("not a hex digit");
    }
}
