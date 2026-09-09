import {
  DELEGATION_TYPES,
  delegationDomain,
  delegationMessage,
  ROOT_AUTHORITY,
  type SignedDelegation,
} from '@aiki/contracts'
import { type Hex, type PublicClient, recoverAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { expect, it, vi } from 'vitest'
import { AIKI_ENFORCERS_BSC_TESTNET, type EnforcerDeployment } from '../config/enforcers.js'
import type { AuthorizationRecord } from '../jobs/store.js'
import { compileCaveats } from './caveats.js'
import { type Constraint, compilePolicy } from './policy.js'
import { createWatchMandateVerifier } from './watch-readiness.js'

// Public test signer and simulated chain, never a deployment or real wallet.
const owner = privateKeyToAccount(`0x${'0'.repeat(63)}1`)
const account = `0x${'11'.repeat(20)}` as const
const deployment: EnforcerDeployment = {
  ...AIKI_ENFORCERS_BSC_TESTNET,
  chainId: 56,
  network: 'mainnet',
}
const constraints: Constraint[] = [
  { kind: 'expiry', value: '2030-01-01T00:00:00.000Z', tier: 'T2', label: 'Expiry' },
]
async function authorization(manager = deployment.manager): Promise<AuthorizationRecord> {
  const delegation: SignedDelegation = {
    delegate: `0x${'22'.repeat(20)}`,
    delegator: account,
    authority: ROOT_AUTHORITY,
    caveats: compileCaveats(constraints, deployment).caveats,
    salt: '1',
    epoch: '0',
    signature: '0x',
  }
  delegation.signature = await owner.signTypedData({
    domain: delegationDomain(56, manager as Hex),
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    message: delegationMessage(delegation),
  })
  return {
    id: 'auth',
    status: 'active',
    policy: compilePolicy(constraints),
    spent: 0n,
    createdAt: '2026-09-09T00:00:00Z',
    owner: owner.address,
    delegation,
    delegationChainId: 56,
  }
}
function fixture(
  over: {
    manager?: string
    chainId?: number
    epoch?: bigint
    disabled?: boolean
    unavailable?: boolean
  } = {},
) {
  const rpc = {
    getChainId: vi.fn(async () => over.chainId ?? 56),
    readContract: vi.fn(async (args: { functionName: string; args?: [Hex, Hex] }) => {
      if (over.unavailable) throw new Error('https://secret-credential@rpc.example failed')
      switch (args.functionName) {
        case 'DELEGATION_MANAGER':
          return over.manager ?? deployment.manager
        case 'owner':
          return owner.address
        case 'epochOf':
          return over.epoch ?? 0n
        case 'isDisabled':
          return over.disabled ?? false
        case 'isValidSignature': {
          if (!args.args) throw new Error('Signature read needs a digest and signature')
          const recovered = await recoverAddress({ hash: args.args[0], signature: args.args[1] })
          return recovered.toLowerCase() === owner.address.toLowerCase()
            ? '0x1626ba7e'
            : '0xffffffff'
        }
        default:
          throw new Error('Unexpected chain read')
      }
    }),
  }
  return {
    rpc,
    verify: createWatchMandateVerifier(
      { rpcUrl: 'http://127.0.0.1:1', deployment },
      rpc as unknown as PublicClient,
    ),
  }
}

it('revalidates a real test signature using the current mainnet manager domain', async () => {
  const { verify, rpc } = fixture()
  expect(await verify(await authorization())).toEqual({ ready: true })
  expect(rpc.readContract).toHaveBeenCalledWith(
    expect.objectContaining({ functionName: 'isDisabled', address: deployment.manager }),
  )
})

it('rejects an account bound to an older manager before validating its signature', async () => {
  const { verify, rpc } = fixture({ manager: `0x${'99'.repeat(20)}` })
  expect(await verify(await authorization())).toMatchObject({
    ready: false,
    retryable: false,
    reason: expect.stringContaining('different execution manager'),
  })
  expect(rpc.readContract).toHaveBeenCalledTimes(1)
})

it('rejects an older manager signature even when the account points to the current manager', async () => {
  const { verify } = fixture()
  expect(await verify(await authorization(`0x${'99'.repeat(20)}`))).toMatchObject({
    ready: false,
    retryable: false,
    reason: expect.stringContaining('signature'),
  })
})

it('rejects on-chain revocation and changed epochs', async () => {
  const auth = await authorization()
  expect(await fixture({ disabled: true }).verify(auth)).toMatchObject({
    ready: false,
    retryable: false,
    reason: expect.stringContaining('revoked'),
  })
  expect(await fixture({ epoch: 1n }).verify(auth)).toMatchObject({
    ready: false,
    retryable: false,
    reason: expect.stringContaining('invalidated'),
  })
})

it('does not read an execution account through a different network', async () => {
  const { verify, rpc } = fixture({ chainId: 97 })
  expect(await verify(await authorization())).toMatchObject({ ready: false, retryable: false })
  expect(rpc.readContract).not.toHaveBeenCalled()
})

it('treats RPC failure as retryable and never returns a credential-bearing RPC error', async () => {
  const result = await fixture({ unavailable: true }).verify(await authorization())
  expect(result).toMatchObject({ ready: false, retryable: true })
  expect(JSON.stringify(result)).not.toContain('secret-credential')
})

it('rejects expired, revoked, unsigned, ownerless, and changed-policy mandates', async () => {
  const { verify } = fixture()
  const auth = await authorization()
  const unsigned = { ...auth }
  delete unsigned.delegation
  for (const changed of [
    { ...auth, status: 'revoked' as const },
    { ...auth, owner: null },
    unsigned,
    { ...auth, policy: { ...auth.policy, expiresAt: '2020-01-01T00:00:00Z' } },
    { ...auth, policy: { ...auth.policy, constraints: [] } },
  ])
    expect(await verify(changed)).toMatchObject({ ready: false, retryable: false })
})
