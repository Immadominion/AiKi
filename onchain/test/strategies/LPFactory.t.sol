// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Test} from "../base/Test.sol";
import {LPVaultFactory, LPVaultCreationArtifact} from "../../src/strategies/lp/LPVaultFactory.sol";
import {PancakeLPVault} from "../../src/strategies/lp/PancakeLPVault.sol";

/// @notice Offline artifact regressions. Authenticated successful deployment is exercised
/// against the exact reviewed manager codehash in LPFactoryFork.t.sol, not a bypass mock.
contract LPFactoryArtifactTest is Test {
    function testReviewedCreationHashExactlyMatchesCompiledVault() public pure {
        assertEq(
            keccak256(type(PancakeLPVault).creationCode),
            LPVaultCreationArtifact.CODE_HASH,
            "LP artifact changed: review and repin; never accept an arbitrary caller hash"
        );
        assertEq(
            type(PancakeLPVault).creationCode.length,
            LPVaultCreationArtifact.CODE_LENGTH,
            "pinned code length drift"
        );
    }

    function testInitcodeSizesFitWhileEmbeddedVaultFactoryWouldNot() public pure {
        assertTrue(
            type(PancakeLPVault).creationCode.length > 24_576,
            "test premise: vault initcode alone exceeds factory runtime limit"
        );
        // controller + 3 common words + 4 protocol words + 15 LP policy words.
        assertTrue(
            type(PancakeLPVault).creationCode.length + 23 * 32 <= 49_152, "vault initcode exceeds EIP-3860"
        );
        assertTrue(
            type(LPVaultFactory).creationCode.length + 2 * 32 <= 49_152, "factory initcode exceeds EIP-3860"
        );
    }

    function testFactoryRefusesWrongChainAndUnreviewedManager() public {
        vm.chainId(97);
        vm.expectRevert(LPVaultFactory.InvalidFactoryConfiguration.selector);
        new LPVaultFactory(0x625cfdA19d2F4424e546B610B4CeF1F5441F84c9, bytes32(uint256(1)));
        vm.chainId(56);
        vm.expectRevert(LPVaultFactory.InvalidFactoryConfiguration.selector);
        new LPVaultFactory(address(0xBAD), bytes32(uint256(1)));
        vm.expectRevert(LPVaultFactory.InvalidFactoryConfiguration.selector);
        new LPVaultFactory(0x625cfdA19d2F4424e546B610B4CeF1F5441F84c9, bytes32(uint256(1)));
    }
}
