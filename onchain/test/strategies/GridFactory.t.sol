// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "../base/Test.sol";
import {GridVaultFactory, GridVaultCreationArtifact} from "../../src/strategies/grid/GridVaultFactory.sol";
import {GridStrategyVault} from "../../src/strategies/grid/GridStrategyVault.sol";

/// @notice Network-free artifact regressions. Positive authentication is exercised against
/// real reviewed manager runtime in GridFactoryFork.t.sol, never a codehash-bypass mock.
contract GridFactoryArtifactTest is Test {
    function testReviewedCreationHashExactlyMatchesCompiledVault() public pure {
        assertEq(
            keccak256(type(GridStrategyVault).creationCode),
            GridVaultCreationArtifact.CODE_HASH,
            "Grid artifact changed: review and repin; never accept a caller-selected hash"
        );
        assertEq(
            type(GridStrategyVault).creationCode.length,
            GridVaultCreationArtifact.CODE_LENGTH,
            "pinned artifact length drift"
        );
    }

    function testInitcodeSizesFitWhileEmbeddedFactoryWouldNot() public pure {
        assertTrue(
            type(GridStrategyVault).creationCode.length > 24_576,
            "test premise: vault initcode alone exceeds factory runtime limit"
        );
        // controller + common(3) + protocol(5) + policy(15) + rung offset(1)
        // + rung count(1) + 32 maximum rungs of five static words each.
        assertTrue(
            type(GridStrategyVault).creationCode.length + (26 + 32 * 5) * 32 <= 49_152,
            "maximum-rung initcode exceeds EIP-3860"
        );
        assertTrue(
            type(GridVaultFactory).creationCode.length + 64 <= 49_152, "factory initcode exceeds EIP-3860"
        );
    }

    function testFactoryRefusesWrongChainAndUnreviewedManager() public {
        vm.chainId(97);
        vm.expectRevert(GridVaultFactory.InvalidFactoryConfiguration.selector);
        new GridVaultFactory(0x625cfdA19d2F4424e546B610B4CeF1F5441F84c9, bytes32(uint256(1)));
        vm.chainId(56);
        vm.expectRevert(GridVaultFactory.InvalidFactoryConfiguration.selector);
        new GridVaultFactory(address(0xBAD), bytes32(uint256(1)));
        vm.expectRevert(GridVaultFactory.InvalidFactoryConfiguration.selector);
        new GridVaultFactory(0x625cfdA19d2F4424e546B610B4CeF1F5441F84c9, bytes32(uint256(1)));
    }
}
