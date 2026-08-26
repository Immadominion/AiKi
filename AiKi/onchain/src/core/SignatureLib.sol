// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271} from "../interfaces/IERC1271.sol";

/// @notice Signature verification across the three account shapes that exist on BNB Chain:
///         a bare EOA, an EIP-7702-delegated EOA, and a genuine contract account.
library SignatureLib {
    error InvalidSignature();
    error InvalidSignatureLength();
    error MalleableSignature();

    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;

    /// @dev secp256k1n / 2. EIP-2 low-s. Without this, a flipped-s copy of a valid signature is
    ///      a second valid signature.
    uint256 internal constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @dev Gas stipend for the ERC-1271 call. Generous enough for a real multisig, bounded so
    ///      a hostile account cannot burn the redeemer's entire gas budget.
    uint256 internal constant ERC1271_GAS = 400_000;

    function check(address signer, bytes32 digest, bytes memory signature) internal view {
        uint256 codeSize = signer.code.length;

        if (codeSize == 0) {
            // Bare EOA. ECDSA only.
            _requireEcdsa(signer, digest, signature);
            return;
        }

        if (codeSize == 23 && _isEip7702Designator(signer)) {
            // An EIP-7702 delegation designator (0xef0100 || implementation). The EOA key is
            // unconditionally this account's ultimate authority -- it can re-delegate at will --
            // so falling back to ECDSA is sound HERE AND ONLY HERE.
            if (_tryErc1271(signer, digest, signature)) return;
            _requireEcdsa(signer, digest, signature);
            return;
        }

        // A genuine contract account. ERC-1271 only, no fallback: an ECDSA fallback would
        // defeat account-level key rotation and revocation.
        if (!_tryErc1271(signer, digest, signature)) revert InvalidSignature();
    }

    function _isEip7702Designator(address account) private view returns (bool) {
        bytes3 prefix;
        assembly {
            let ptr := mload(0x40)
            extcodecopy(account, ptr, 0, 3)
            prefix := mload(ptr)
        }
        return prefix == bytes3(0xef0100);
    }

    /// @dev Bounded staticcall that copies at most 32 bytes of return data, so a return-bomb
    ///      cannot inflate the manager's memory cost, and requires exactly 32 bytes back.
    function _tryErc1271(address signer, bytes32 digest, bytes memory signature) private view returns (bool) {
        bytes memory callData = abi.encodeCall(IERC1271.isValidSignature, (digest, signature));
        bool ok;
        uint256 outSize;
        bytes32 result;
        assembly {
            ok := staticcall(ERC1271_GAS, signer, add(callData, 0x20), mload(callData), 0x00, 0x20)
            outSize := returndatasize()
            result := mload(0x00)
        }
        // Truncation is the point: an ERC-1271 return value is a left-aligned bytes4.
        // forge-lint: disable-next-line(unsafe-typecast)
        return ok && outSize == 32 && bytes4(result) == ERC1271_MAGIC;
    }

    function _requireEcdsa(address signer, bytes32 digest, bytes memory signature) private pure {
        if (recoverStrict(digest, signature) != signer) revert InvalidSignature();
    }

    /// @notice Strict ECDSA recovery: EIP-2 low-s, canonical v, and a non-zero result.
    /// @dev Without the low-s bound a flipped-s copy of a valid signature is a second valid
    ///      signature; without the zero check a malformed signature validates against a zero
    ///      address. Both are trivially reachable because signatures are user-supplied blobs.
    function recoverStrict(bytes32 digest, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignatureLength();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (uint256(s) > HALF_N) revert MalleableSignature();
        if (v != 27 && v != 28) revert InvalidSignature();
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0)) revert InvalidSignature();
        return recovered;
    }
}
