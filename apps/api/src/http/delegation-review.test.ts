import { randomUUID } from 'node:crypto'
import { ROOT_AUTHORITY, type SignedDelegation } from '@aiki/contracts'
import { createPublicClient, custom } from 'viem'
import { bsc, bscTestnet } from 'viem/chains'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryAccountStore } from '../accounts/store.js'
import { InMemoryNonceStore } from '../auth/nonce-store.js'
import { SessionSigner } from '../auth/session.js'
import { compileCaveats } from '../authority/caveats.js'
import { type Constraint, compilePolicy } from '../authority/policy.js'
import { AIKI_ENFORCERS_BSC_TESTNET, type EnforcerDeployment } from '../config/enforcers.js'
import { JobService } from '../jobs/service.js'
import { type AuthorizationStatus, InMemoryJobStore } from '../jobs/store.js'
import { createApiServer } from './server.js'

const NOW = Date.parse('2026-09-09T15:00:00.000Z')
const OWNER = `0x${'ab'.repeat(20)}` as const
const STRANGER = `0x${'98'.repeat(20)}` as const
const ACCOUNT = `0x${'cd'.repeat(20)}` as const
const OTHER_ACCOUNT = `0x${'76'.repeat(20)}` as const
const EXECUTOR = `0x${'ef'.repeat(20)}` as const
// Public, invalid signature fixture. No wallet or signing key is used.
const SIGNATURE = `0x${'12'.repeat(65)}` as const
const signer = new SessionSigner('delegation-review-local-test-session-secret')
const apps: ReturnType<typeof createApiServer>[] = []
const network = vi.fn(async () => {
  throw new Error('Delegation review must not make network calls.')
})

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  network.mockClear()
  vi.stubGlobal('fetch', network)
})

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function harness(
  options: { chainId?: 56 | 97; status?: AuthorizationStatus; expiresAt?: string } = {},
) {
  const chainId = options.chainId ?? 56
  // Fixture addresses are used only to compile typed data; no deployed code is queried.
  const deployment: EnforcerDeployment = {
    ...AIKI_ENFORCERS_BSC_TESTNET,
    chainId,
    network: chainId === 56 ? 'mainnet' : 'testnet',
  }
  const constraints: Constraint[] = [
    {
      kind: 'expiry',
      value: options.expiresAt ?? '2030-01-01T00:00:00.000Z',
      tier: 'T2',
      label: 'Owner-only expiry',
    },
    { kind: 'contract_allowlist', value: [ACCOUNT], tier: 'T2', label: 'Approved target' },
    { kind: 'selector_allowlist', value: ['0xa9059cbb'], tier: 'T2', label: 'Transfer' },
    { kind: 'asset_scope', value: [ACCOUNT], tier: 'T2', label: 'Approved asset' },
    { kind: 'per_action_cap', value: '1000000000000000000', tier: 'T2', label: 'Per action' },
    { kind: 'session_total_cap', value: '5000000000000000000', tier: 'T2', label: 'Lifetime' },
  ]
  const store = new InMemoryJobStore()
  const jobs = new JobService(store)
  const authorization = await store.createAuthorization({
    id: randomUUID(),
    policy: compilePolicy(constraints),
    status: options.status ?? 'active',
    spent: 0n,
    createdAt: new Date(NOW).toISOString(),
    owner: OWNER,
  })
  const accounts = new InMemoryAccountStore()
  const chain = {
    ownerOf: vi.fn(async () => OWNER),
    isValidSignature: vi.fn(async () => true),
  }
  const deploy = vi.fn(async () => {
    throw new Error('Review must not deploy an account.')
  })
  const app = createApiServer({
    observations: () => [],
    jobs,
    enforcers: deployment,
    agentSessionKey: EXECUTOR,
    chain,
    accounts: { store: accounts, deployer: { deploy } },
    auth: {
      signer,
      nonces: new InMemoryNonceStore(),
      domain: 'aiki.test',
      secureCookies: false,
      client: createPublicClient({
        chain: chainId === 56 ? bsc : bscTestnet,
        transport: custom({ request: network }),
      }),
    },
  })
  apps.push(app)
  const read = (address: string | null = OWNER, delegator = ACCOUNT as string) =>
    app.inject({
      method: 'GET',
      url: `/v1/authorizations/${authorization.id}/delegation?delegator=${delegator}`,
      ...(address ? { headers: { cookie: `aiki_session=${signer.issue(address, chainId)}` } } : {}),
    })
  const observeWrites = () => [
    vi.spyOn(store, 'createAuthorization'),
    vi.spyOn(store, 'revokeAuthorization'),
    vi.spyOn(store, 'attachDelegation'),
    vi.spyOn(store, 'releaseSpend'),
    vi.spyOn(store, 'createJob'),
    vi.spyOn(store, 'beginExecution'),
    vi.spyOn(accounts, 'claim'),
    vi.spyOn(accounts, 'beginDeployment'),
    deploy,
  ]
  const expectNoChainReads = () => {
    expect(chain.ownerOf).not.toHaveBeenCalled()
    expect(chain.isValidSignature).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  }
  return { app, store, jobs, authorization, deployment, read, observeWrites, expectNoChainReads }
}

describe.each([56, 97] as const)('delegation review metadata on chain %i', (chainId) => {
  it('returns the stored authorization with unchanged typed data and no mutations', async () => {
    const h = await harness({ chainId })
    const before = structuredClone(await h.jobs.getAuthorization(h.authorization.id))
    const writes = h.observeWrites()
    const response = await h.read()
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('no-store')
    const body = response.json()
    expect(body.authorization).toEqual({
      id: before.id,
      owner: OWNER,
      status: 'active',
      policyHash: before.policy.hash,
      constraints: before.policy.constraints,
      delegator: null,
      delegationChainId: null,
      signedAt: null,
    })
    const caveats = compileCaveats(before.policy.constraints, h.deployment).caveats
    expect(body.domain).toMatchObject({
      name: 'AiKi Delegation',
      chainId,
      verifyingContract: h.deployment.manager,
    })
    expect(body.primaryType).toBe('Delegation')
    expect(body.types.Delegation).toBeInstanceOf(Array)
    expect(body.message).toEqual({
      delegate: EXECUTOR,
      delegator: ACCOUNT,
      authority: ROOT_AUTHORITY,
      caveats: caveats.map(({ enforcer, terms }) => ({ enforcer, terms })),
      salt: '1',
      epoch: '0',
    })
    expect(body.unsigned).toEqual({ ...body.message, caveats })
    expect(body.limits).toHaveLength(before.policy.constraints.length)
    expect(await h.jobs.getAuthorization(before.id)).toEqual(before)
    for (const write of writes) expect(write).not.toHaveBeenCalled()
    h.expectNoChainReads()
  })

  it('returns signed readback from storage without returning or replacing its signature', async () => {
    const h = await harness({ chainId })
    const delegation: SignedDelegation = {
      delegate: EXECUTOR,
      delegator: ACCOUNT,
      authority: ROOT_AUTHORITY,
      caveats: compileCaveats(h.authorization.policy.constraints, h.deployment).caveats,
      salt: '1',
      epoch: '0',
      signature: SIGNATURE,
    }
    const signedAt = '2026-09-09T14:00:00.000Z'
    await h.store.attachDelegation(h.authorization.id, delegation, ACCOUNT, chainId, signedAt)
    const before = structuredClone(await h.jobs.getAuthorization(h.authorization.id))
    const writes = h.observeWrites()
    // A new query account must not masquerade as the one already authorized.
    const response = await h.read(OWNER, OTHER_ACCOUNT)
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('no-store')
    const body = response.json()
    expect(body.authorization).toEqual({
      id: before.id,
      owner: OWNER,
      status: 'active',
      policyHash: before.policy.hash,
      constraints: before.policy.constraints,
      delegator: ACCOUNT,
      delegationChainId: chainId,
      signedAt,
    })
    expect(body.unsigned.delegator).toBe(OTHER_ACCOUNT)
    expect(body.unsigned.signature).toBeUndefined()
    expect(body.authorization.signature).toBeUndefined()
    expect(body.authorization.delegation).toBeUndefined()
    expect(response.body).not.toContain(SIGNATURE)
    expect(await h.jobs.getAuthorization(before.id)).toEqual(before)
    for (const write of writes) expect(write).not.toHaveBeenCalled()
    h.expectNoChainReads()
  })
})

it.each(['revoked', 'expired', 'pending'] as const)(
  'permits owned %s authorization readback without reactivating it',
  async (status) => {
    const h = await harness({ status })
    const before = structuredClone(await h.jobs.getAuthorization(h.authorization.id))
    const response = await h.read()
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.json().authorization.status).toBe(status)
    expect(await h.jobs.getAuthorization(before.id)).toEqual(before)
    h.expectNoChainReads()
  },
)

it.each([-1, 0, 1])(
  'computes expiry at now plus %i ms without changing stored status',
  async (offset) => {
    const h = await harness({ expiresAt: new Date(NOW + offset).toISOString() })
    const before = structuredClone(await h.jobs.getAuthorization(h.authorization.id))
    const response = await h.read()
    expect(response.statusCode).toBe(200)
    expect(response.json().authorization.status).toBe(offset <= 0 ? 'expired' : 'active')
    expect(response.json().authorization.constraints).toEqual(before.policy.constraints)
    expect((await h.jobs.getAuthorization(before.id)).status).toBe('active')
    expect(await h.jobs.getAuthorization(before.id)).toEqual(before)
    h.expectNoChainReads()
  },
)

it.each(['active', 'revoked', 'expired'] as const)(
  'does not expose another owner’s %s authorization or allow unauthenticated review',
  async (status) => {
    const h = await harness({ status })
    const before = structuredClone(await h.jobs.getAuthorization(h.authorization.id))
    const writes = h.observeWrites()
    for (const [address, expectedStatus] of [
      [STRANGER, 404],
      [null, 401],
    ] as const) {
      const response = await h.read(address)
      expect(response.statusCode).toBe(expectedStatus)
      expect(response.json().authorization).toBeUndefined()
      expect(response.body).not.toContain(before.policy.hash)
      expect(response.body).not.toContain('Owner-only expiry')
      expect(response.body).not.toContain(ACCOUNT)
    }
    expect(await h.jobs.getAuthorization(before.id)).toEqual(before)
    for (const write of writes) expect(write).not.toHaveBeenCalled()
    h.expectNoChainReads()
  },
)
