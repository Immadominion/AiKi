// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "./base/Test.sol";
import {AiKiMandateAccount} from "../src/account/AiKiMandateAccount.sol";
import {AmountSite} from "../src/core/Types.sol";
import {PolicyDenied, Rules, Reasons} from "../src/core/Errors.sol";
import {SessionTotalCapEnforcer} from "../src/enforcers/SessionTotalCapEnforcer.sol";
import {PerActionCapEnforcer} from "../src/enforcers/PerActionCapEnforcer.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev MetaMask's Delegation struct, which is NOT this repository's. Theirs has no `epoch`
///      field; ours adds one for bulk revocation. Signing our shape for their manager would
///      produce a hash it never computes, so the test declares theirs explicitly.
struct MMCaveat {
    address enforcer;
    bytes terms;
    bytes args;
}

struct MMDelegation {
    address delegate;
    address delegator;
    bytes32 authority;
    MMCaveat[] caveats;
    uint256 salt;
    bytes signature;
}

interface IRealDelegationManager {
    function getDelegationHash(MMDelegation calldata delegation) external pure returns (bytes32);
    function getDomainHash() external view returns (bytes32);
    function paused() external view returns (bool);
    function redeemDelegations(
        bytes[] calldata permissionContexts,
        bytes32[] calldata modes,
        bytes[] calldata executionCallDatas
    ) external;
}

/// @notice The claim this whole directory exists to support, tested against the real thing.
///
/// @dev AiKi does not ask anyone to trust a DelegationManager we wrote. MetaMask's is already
///      deployed on BNB Chain and audited, and these enforcers are built to plug into it. That
///      is a claim about a contract we do not control, so it is worth nothing until a
///      redemption actually lands through it. This test forks BSC mainnet at a pinned block
///      and redeems through the deployed manager at 0xdb9B...7dB3.
///
///      Two things it caught that reading bytecode did not: the manager calls `beforeAllHook`
///      and `afterAllHook` as well as the per-execution pair, so enforcers that implement only
///      two of the four are not merely incomplete but unusable; and the delegator account must
///      answer ERC-1271 for its own delegation, because the delegator here is a contract.
contract ForkRealManagerTest is Test {
    address internal constant REAL_MANAGER = 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3;
    bytes4 internal constant TRANSFER_SELECTOR = bytes4(keccak256("transfer(address,uint256)"));
    uint256 internal constant FORK_BLOCK = 118_000_000;

    uint256 internal constant OWNER_PK = 0xA11CE;
    address internal owner;
    address internal agent = address(0xA6E7);
    address internal recipient = address(0x4EC1);

    IRealDelegationManager internal manager = IRealDelegationManager(REAL_MANAGER);
    AiKiMandateAccount internal account;
    SessionTotalCapEnforcer internal sessionE;
    PerActionCapEnforcer internal perActionE;
    MockERC20 internal token;

    function setUp() public {
        vm.createSelectFork("bsc", FORK_BLOCK);
        owner = vm.addr(OWNER_PK);

        // Every one of these is pinned to the REAL manager, so `onlyManager` and the account's
        // executor check can only be satisfied by the deployed contract.
        account = new AiKiMandateAccount(owner, REAL_MANAGER);
        sessionE = new SessionTotalCapEnforcer(REAL_MANAGER);
        perActionE = new PerActionCapEnforcer(REAL_MANAGER);
        token = new MockERC20();
        token.mint(address(account), 1_000 ether);
    }

    function test_TheDeployedManagerIsStillWhatWeThinkItIs() public {
        uint256 size;
        address m = REAL_MANAGER;
        assembly {
            size := extcodesize(m)
        }
        assertTrue(size > 10_000, "no manager code at the pinned block");
        assertFalse(manager.paused(), "manager is paused");
        assertEq(
            manager.getDomainHash(),
            0xaff42a06a1e0b97e017b6cdff8ac6536a5ee4b3841e82ca7f7a90ebfac849735,
            "domain changed: a redeployment would invalidate every signed mandate"
        );
    }

    function test_RedeemsThroughTheRealManager_AndTheCapHolds() public {
        MMDelegation memory d = mandate(200 ether, 500 ether);

        // ALLOW: 150 is inside both caps, and the tokens must actually move.
        uint256 before = token.balanceOf(address(account));
        redeem(d, 150 ether);
        assertEq(token.balanceOf(recipient), 150 ether, "recipient was not paid");
        assertEq(token.balanceOf(address(account)), before - 150 ether, "account was not debited");

        // ALLOW again, twice: 450 of the 500 session cap, each well under the 200 per-action
        // cap so the per-action rule cannot be what answers.
        redeem(d, 150 ether);
        redeem(d, 150 ether);
        assertEq(token.balanceOf(recipient), 450 ether, "later redemptions did not land");

        // DENY: 150 more reaches 600 against a 500 session cap, while staying under the
        // per-action cap. Named, not bare: a bare expectRevert passes on any revert, including
        // one meaning the test is malformed. This asserts the refusal is OUR enforcer's,
        // carrying the same rule and reason strings evaluatePolicy emits off chain, unchanged
        // by passing through a manager we did not write.
        uint256 heldBefore = token.balanceOf(address(account));
        vm.expectRevert(
            abi.encodeWithSelector(PolicyDenied.selector, Rules.SESSION_TOTAL_CAP, Reasons.OVER_SESSION_CAP)
        );
        redeem(d, 150 ether);
        assertEq(token.balanceOf(address(account)), heldBefore, "denied redemption still moved value");
        assertEq(token.balanceOf(recipient), 450 ether, "recipient gained on a denied redemption");

        // And the cap is the reason: 50 fits under the remaining 50 and is allowed.
        redeem(d, 50 ether);
        assertEq(token.balanceOf(recipient), 500 ether, "the cap, not the call, was the problem");
    }

    function test_PerActionCapIsEnforcedByTheRealManagerToo() public {
        MMDelegation memory d = mandate(100 ether, 500 ether);
        // 150 is inside the session cap but over the 100 per-action cap.
        vm.expectRevert(
            abi.encodeWithSelector(PolicyDenied.selector, Rules.PER_ACTION_CAP, Reasons.OVER_PER_ACTION_CAP)
        );
        redeem(d, 150 ether);
        assertEq(token.balanceOf(recipient), 0, "per-action cap did not hold");
        redeem(d, 100 ether);
        assertEq(token.balanceOf(recipient), 100 ether, "exactly at the cap must be allowed");
    }

    // --------------------------------------------------------------------- helpers

    function mandate(uint256 perCap, uint256 sessionCap) internal view returns (MMDelegation memory d) {
        AmountSite[] memory sites = new AmountSite[](1);
        sites[0] = AmountSite({
            target: address(token),
            selector: TRANSFER_SELECTOR,
            asset: address(token),
            argIndex: 1
        });

        MMCaveat[] memory caveats = new MMCaveat[](2);
        caveats[0] =
            MMCaveat({enforcer: address(perActionE), terms: abi.encode(address(token), perCap, sites), args: ""});
        caveats[1] =
            MMCaveat({enforcer: address(sessionE), terms: abi.encode(address(token), sessionCap, sites), args: ""});

        d = MMDelegation({
            delegate: agent,
            delegator: address(account),
            authority: bytes32(type(uint256).max),
            caveats: caveats,
            salt: 0,
            signature: ""
        });

        // The manager computes both halves of the digest itself, so nothing here depends on
        // this test having guessed a typehash correctly.
        bytes32 digest = keccak256(
            abi.encodePacked(hex"1901", manager.getDomainHash(), manager.getDelegationHash(d))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digest);
        d.signature = abi.encodePacked(r, s, v);
    }

    function redeem(MMDelegation memory d, uint256 amount) internal {
        MMDelegation[] memory ds = new MMDelegation[](1);
        ds[0] = d;

        bytes[] memory contexts = new bytes[](1);
        contexts[0] = abi.encode(ds);
        bytes32[] memory modes = new bytes32[](1);
        modes[0] = bytes32(0);
        bytes[] memory execs = new bytes[](1);
        execs[0] = abi.encodePacked(
            address(token), uint256(0), abi.encodeWithSelector(TRANSFER_SELECTOR, recipient, amount)
        );

        vm.prank(agent);
        manager.redeemDelegations(contexts, modes, execs);
    }
}
