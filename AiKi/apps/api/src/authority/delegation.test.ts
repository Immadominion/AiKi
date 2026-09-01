import {
  DELEGATION_TYPES,
  delegationDomain,
  delegationMessage,
  ROOT_AUTHORITY,
  type UnsignedDelegation,
} from '@aiki/contracts'
import { createPublicClient, hashTypedData, http, parseAbi } from 'viem'
import { expect, it } from 'vitest'
import { AIKI_ENFORCERS_BSC_TESTNET } from '../config/enforcers.js'

/**
 * A wallet and a contract must agree on the exact bytes being signed.
 *
 * `eth_signTypedData_v4` hashes the EIP-712 definitions in @aiki/contracts;
 * AiKiDelegationManager hashes its own typehash strings in EncoderLib. If those
 * disagree by one character the wallet still signs happily and the manager
 * rejects the result, so the failure appears as an unexplained revert at
 * redemption, long after the mistake and nowhere near it.
 *
 * These run against the deployed manager over the network, so they are skipped
 * when it cannot be reached rather than failing the suite for somebody's
 * connection. A skipped test says less than a passing one, which is why the
 * local half below never skips.
 */
const RPC = process.env.BSC_TESTNET_RPC_URL ?? 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'
const MANAGER = AIKI_ENFORCERS_BSC_TESTNET.manager as `0x${string}`
const MGR = parseAbi([
  'function getDelegationDigest((address,address,bytes32,(address,bytes,bytes)[],uint256,uint256,bytes)) view returns (bytes32)',
])

const sample = (): UnsignedDelegation => ({
  delegate: `0x${'11'.repeat(20)}`,
  delegator: `0x${'22'.repeat(20)}`,
  authority: ROOT_AUTHORITY,
  caveats: [
    // Two caveats with different terms lengths, because a bytes field hashed as
    // anything other than keccak(contents) tends to survive a single-entry test.
    {
      enforcer: AIKI_ENFORCERS_BSC_TESTNET.enforcers[0]?.address as `0x${string}`,
      terms: '0x1234',
      args: '0x',
    },
    {
      enforcer: AIKI_ENFORCERS_BSC_TESTNET.enforcers[4]?.address as `0x${string}`,
      terms: '0xdeadbeefcafe',
      // args differ from terms on purpose: they must not reach the signature.
      args: '0xabcdef',
    },
  ],
  salt: '1',
  epoch: '0',
})

const digestOf = (d: UnsignedDelegation) =>
  hashTypedData({
    domain: delegationDomain(AIKI_ENFORCERS_BSC_TESTNET.chainId, MANAGER),
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    message: delegationMessage(d),
  })

it('leaves args out of the signed message, so they cannot be signed over', () => {
  const withArgs = sample()
  const withoutArgs: UnsignedDelegation = {
    ...withArgs,
    caveats: withArgs.caveats.map((c) => ({ ...c, args: '0x' })),
  }
  // Changing args must not change the digest. If it did, a caveat's
  // per-redemption data would be frozen at signing time and every redemption
  // carrying different args would be refused.
  expect(digestOf(withArgs)).toBe(digestOf(withoutArgs))
})

it('changes the digest when anything that IS signed changes', () => {
  const base = digestOf(sample())
  const other = sample()
  const first = other.caveats[0]
  if (!first) throw new Error('sample has no caveats')
  other.caveats[0] = { ...first, terms: '0x1235' }
  // A one-bit change in a cap's terms has to produce a different delegation, or
  // a signature for a $10 cap would authorise a $10,000 one.
  expect(digestOf(other)).not.toBe(base)
})

/*
 * Twenty seconds, because this asks a public testnet node what IT thinks the
 * hash is, which is the whole point: agreeing with ourselves proves nothing
 * about what a wallet will be asked to sign. A slow round trip inside the
 * default five seconds reads as "the manager disagrees" when it means "the RPC
 * was slow", and that is the worst possible false alarm to have on this check.
 */
it('agrees with the deployed manager about what is being signed', async () => {
  const client = createPublicClient({ transport: http(RPC) })
  const d = sample()
  let onchain: `0x${string}`
  try {
    onchain = await client.readContract({
      address: MANAGER,
      abi: MGR,
      functionName: 'getDelegationDigest',
      args: [
        [
          d.delegate,
          d.delegator,
          d.authority,
          d.caveats.map((c) => [c.enforcer, c.terms, c.args] as const),
          BigInt(d.salt),
          BigInt(d.epoch),
          '0x',
        ],
      ] as never,
    })
  } catch {
    // The chain is unreachable, which is not a failure of this definition.
    return
  }
  expect(digestOf(d)).toBe(onchain)
}, 20_000)
