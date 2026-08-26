// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Caveat, Delegation} from "./Types.sol";

/// @notice EIP-712 hashing for delegations.
/// @dev The signature is NOT in the preimage. If it were, flipping `s` would produce a new
///      delegationHash for the same semantic delegation, and therefore a fresh session-cap
///      counter, and therefore unbounded spend.
library EncoderLib {
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 internal constant CAVEAT_TYPEHASH = keccak256("Caveat(address enforcer,bytes terms)");

    bytes32 internal constant DELEGATION_TYPEHASH = keccak256(
        "Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt,uint256 epoch)Caveat(address enforcer,bytes terms)"
    );

    bytes32 internal constant REVOKE_TYPEHASH =
        keccak256("RevokeDelegation(bytes32 delegationHash,uint256 nonce)");

    function domainSeparator(string memory name, string memory version, address verifyingContract)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                verifyingContract
            )
        );
    }

    function hashCaveats(Caveat[] memory caveats) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](caveats.length);
        for (uint256 i; i < caveats.length; ++i) {
            hashes[i] =
                keccak256(abi.encode(CAVEAT_TYPEHASH, caveats[i].enforcer, keccak256(caveats[i].terms)));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    /// @notice The delegation identity used to key revocation and session-spend state.
    /// @dev EIP-712 hashStruct, domain excluded, so it is reproducible off chain without
    ///      knowing which manager will hold it. Enforcer state is namespaced by manager
    ///      address separately.
    function hashDelegation(Delegation memory d) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DELEGATION_TYPEHASH,
                d.delegate,
                d.delegator,
                d.authority,
                hashCaveats(d.caveats),
                d.salt,
                d.epoch
            )
        );
    }

    function toDigest(bytes32 separator, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", separator, structHash));
    }
}
