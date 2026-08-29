import { ROOT_AUTHORITY, type SignedDelegation } from '@aiki/contracts'
import { expect, it } from 'vitest'
import { AIKI_ENFORCERS_BSC_TESTNET } from '../config/enforcers.js'
import { acceptDelegation } from './accept-delegation.js'
import { compileCaveats } from './caveats.js'
import type { ChainReader } from './chain-reader.js'
import type { Constraint } from './policy.js'

const D = AIKI_ENFORCERS_BSC_TESTNET
const OWNER = `0x${'ab'.repeat(20)}` as const
const ACCOUNT = `0x${'cd'.repeat(20)}` as const
const AGENT = `0x${'ef'.repeat(20)}` as const
const TOKEN = '0x55d398326f99059ff775485246999027b3197955'

const constraints = (): Constraint[] => [
  { kind: 'expiry', value: '2030-01-01T00:00:00.000Z', tier: 'T2', label: 'Expires' },
  { kind: 'contract_allowlist', value: [TOKEN], tier: 'T2', label: 'USDT only' },
  { kind: 'selector_allowlist', value: ['0xa9059cbb'], tier: 'T2', label: 'transfer only' },
  { kind: 'asset_scope', value: [TOKEN], tier: 'T2', label: 'USDT' },
  { kind: 'per_action_cap', value: '10000000000000000000', tier: 'T2', label: '10 USDT' },
]

/** A delegation that carries exactly the mandate above. */
const signed = (over: Partial<SignedDelegation> = {}): SignedDelegation => ({
  delegate: AGENT,
  delegator: ACCOUNT,
  authority: ROOT_AUTHORITY,
  caveats: compileCaveats(constraints(), D).caveats,
  salt: '1',
  epoch: '0',
  signature: `0x${'11'.repeat(65)}`,
  ...over,
})

/** Says yes to everything, so each test isolates the one refusal it is about. */
const permissive = (over: Partial<ChainReader> = {}): ChainReader => ({
  ownerOf: async () => OWNER,
  isValidSignature: async () => true,
  ...over,
})

const accept = (delegation: SignedDelegation, chain = permissive(), owner = OWNER) =>
  acceptDelegation({ delegation, constraints: constraints(), owner, deployment: D, chain })

it('accepts a delegation that carries exactly the mandate that was agreed', async () => {
  const result = await accept(signed())
  expect(result.chainId).toBe(D.chainId)
  expect(result.digest).toMatch(/^0x[0-9a-f]{64}$/)
})

it('refuses caveats that are not the ones this mandate compiles to', async () => {
  // The whole product in one test. A caller posts constraints, is shown a
  // mandate, and then posts a signed delegation, and nothing makes those the
  // same object. Somebody could be shown a ten dollar cap and sign a ten
  // thousand dollar one, and every screen would still say ten.
  const tampered = signed()
  const cap = tampered.caveats.at(-1)
  if (!cap) throw new Error('fixture has no caveats')
  tampered.caveats[tampered.caveats.length - 1] = {
    ...cap,
    terms: `${cap.terms.slice(0, -1)}f` as `0x${string}`,
  }
  await expect(accept(tampered)).rejects.toThrow(/does not carry the limits of this mandate/)
})

it('refuses a delegation carrying fewer limits than the mandate', async () => {
  // Dropping a caveat is the cheapest tamper of all: every remaining limit still
  // matches, and the one that was removed simply stops existing.
  const short = signed()
  short.caveats = short.caveats.slice(0, -1)
  await expect(accept(short)).rejects.toThrow(/does not carry the limits of this mandate/)
})

it('refuses an account somebody else owns', async () => {
  // The signature does not establish this. A delegation naming another person's
  // account would otherwise be filed against this mandate and look real until
  // the moment it was redeemed.
  const chain = permissive({ ownerOf: async () => `0x${'99'.repeat(20)}` })
  await expect(accept(signed(), chain)).rejects.toThrow(/belongs to somebody else/)
})

it('refuses an account with no code at all', async () => {
  const chain = permissive({ ownerOf: async () => null })
  await expect(accept(signed(), chain)).rejects.toThrow(/does not exist on this chain/)
})

it('refuses a signature the account itself will not accept', async () => {
  // Asked of the account rather than decided here, because the delegator is a
  // contract and it is the authority on what its owner signed.
  const chain = permissive({ isValidSignature: async () => false })
  await expect(accept(signed(), chain)).rejects.toThrow(/does not accept this signature/)
})

it('refuses a delegation with no signature at all', async () => {
  await expect(
    accept({ ...signed(), signature: undefined as unknown as `0x${string}` }),
  ).rejects.toThrow(/carries no signature/)
})

it('refuses an authority the manager would reject at redemption', async () => {
  // Refused while somebody is watching, rather than as an unexplained revert
  // later.
  await expect(accept(signed({ authority: `0x${'00'.repeat(32)}` }))).rejects.toThrow(
    /root authority/,
  )
})

it('refuses a delegation that names no agent', async () => {
  await expect(accept(signed({ delegate: `0x${'00'.repeat(20)}` }))).rejects.toThrow(
    /must name the agent/,
  )
})

it('checks the caveats before it spends a network call on the account', async () => {
  // Ordering matters for a route anyone can reach: a tampered delegation should
  // cost a comparison, not two RPC round trips.
  let asked = false
  const chain = permissive({
    ownerOf: async () => {
      asked = true
      return OWNER
    },
  })
  const tampered = signed()
  tampered.caveats = []
  await expect(accept(tampered, chain)).rejects.toThrow()
  expect(asked).toBe(false)
})
