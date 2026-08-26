// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AiKiEnforcerRegistry
/// @notice Constructor-populated, immutable name -> address map of the deployed AiKi enforcers.
///
/// @dev This is the on-chain object `EnforcementInfo.enforcedBy` must resolve against, and the
///      answer to enforcer-address squatting: a user socially engineered into signing a
///      delegation whose "AllowedTargetsEnforcer" is a lookalike address that returns without
///      checking anything holds a mandate that renders as T0 and enforces nothing.
///
///      The UI must refuse to render T0 for a caveat whose enforcer address is not registered
///      here, and the policy compiler must emit enforcer addresses only from this registry.
///
///      There is no setter, no owner and no upgrade path. A new enforcer is a new registry.
contract AiKiEnforcerRegistry {
    error LengthMismatch();
    error ZeroAddress();
    error DuplicateName();

    mapping(bytes32 => address) private _byName;
    mapping(address => string) private _names;
    address[] private _enforcers;

    address public immutable DELEGATION_MANAGER;

    constructor(address delegationManager_, string[] memory names_, address[] memory enforcers_) {
        if (names_.length != enforcers_.length || names_.length == 0) revert LengthMismatch();
        if (delegationManager_ == address(0)) revert ZeroAddress();
        DELEGATION_MANAGER = delegationManager_;

        for (uint256 i; i < names_.length; ++i) {
            if (enforcers_[i] == address(0)) revert ZeroAddress();
            bytes32 key = keccak256(bytes(names_[i]));
            if (_byName[key] != address(0)) revert DuplicateName();
            _byName[key] = enforcers_[i];
            _names[enforcers_[i]] = names_[i];
            _enforcers.push(enforcers_[i]);
        }
    }

    function addressOf(string calldata name) external view returns (address) {
        return _byName[keccak256(bytes(name))];
    }

    function nameOf(address enforcer) external view returns (string memory) {
        return _names[enforcer];
    }

    function isRegistered(address enforcer) external view returns (bool) {
        return bytes(_names[enforcer]).length != 0;
    }

    function all() external view returns (address[] memory) {
        return _enforcers;
    }

    function count() external view returns (uint256) {
        return _enforcers.length;
    }
}
