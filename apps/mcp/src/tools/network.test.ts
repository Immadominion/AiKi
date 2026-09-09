import { DELEGATION_TYPES, delegationDomain, guardianFor } from '@aiki/contracts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AikiClient, AikiError } from '../client.js'
import type { Registrar } from '../register.js'
import type { Session } from '../session.js'
import { registerMandateTools } from './mandate.js'
import { registerWalletTools } from './wallet.js'
import { registerWorkTools } from './work.js'

const identityFns = vi.hoisted(() => ({
  loadIdentity: vi.fn(),
  createIdentity: vi.fn(),
  balanceOf: vi.fn(),
}))
vi.mock('../identity.js', () => ({ ...identityFns, keyLocation: '/mocked/key' }))
const owner = `0x${'12'.repeat(20)}` as const
const address = `0x${'34'.repeat(20)}` as const
const manager = `0x${'56'.repeat(20)}` as const
const metadata = (chainId: 56 | 97) => ({
  configured: true,
  chainId,
  network: chainId === 56 ? 'mainnet' : 'testnet',
  audited: false,
  manager,
  guardian: guardianFor(chainId),
})
const signed = vi.fn()
const identity = { source: 'environment', account: { address: owner, signTypedData: signed } }
const caps = { per_action_usdt: 1.25, total_usdt: 5, expires_in_days: 30 }
const requireSession = vi.fn()
const resetSession = vi.fn()
const session = { require: requireSession, reset: resetSession } as unknown as Session
type Call = { path: string; method: string; body?: Record<string, unknown> }
let calls: Call[]
let net: ReturnType<typeof metadata>
let account: unknown
let madeAccount: unknown
let prepared: {
  domain: Record<string, unknown>
  types: unknown
  primaryType: string
  message: Record<string, unknown>
  unsigned: Record<string, unknown>
}
let watch: Record<string, unknown>
let watchError: number | null
let networkResponse: unknown

beforeEach(() => {
  calls = []
  net = metadata(56)
  networkResponse = null
  account = { address, chainId: 56 }
  madeAccount = { address, chainId: 56 }
  prepared = {
    domain: delegationDomain(56, manager),
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    message: { delegator: address },
    unsigned: { delegator: address },
  }
  watch = {
    chainId: 56,
    asset: guardianFor(56).asset,
    status: 'ACTIVE',
    minimumHealthFactor: '1.25',
    remaining: '2500000000000000001',
  }
  watchError = null
  signed.mockReset().mockResolvedValue('0xmock-signature')
  requireSession.mockReset().mockResolvedValue(identity)
  resetSession.mockReset()
  identityFns.loadIdentity.mockReset().mockReturnValue(identity)
  identityFns.createIdentity.mockReset().mockReturnValue(identity)
  identityFns.balanceOf
    .mockReset()
    .mockResolvedValue({ amount: '2', chainId: 56, network: 'mainnet', symbol: 'BNB' })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname
      const method = init.method ?? 'GET'
      calls.push({ path, method, ...(init.body ? { body: JSON.parse(init.body as string) } : {}) })
      let value: unknown
      let status = 200
      if (path === '/v1/execution/network') value = networkResponse ?? net
      else if (path === '/v1/account') value = method === 'GET' ? account : madeAccount
      else if (path === '/v1/mandates/preview')
        value = { tier: 'T0', network: net.network, audited: net.audited, limits: [] }
      else if (path === '/v1/authorizations') value = { id: 'mandate-one' }
      else if (path.endsWith('/delegation'))
        value = method === 'GET' ? prepared : { accepted: true }
      else if (path.endsWith('/watch')) {
        value = watchError
          ? { error: { code: 'WATCH_ERROR', message: 'Watch request failed.' } }
          : watch
        status = watchError ?? 200
      } else if (path.endsWith('/revoke')) value = { ok: true }
      else throw new Error(`Unexpected mocked API path: ${path}`)
      return new Response(JSON.stringify(value), { status })
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

function harness(rpcUrl?: string) {
  const handlers = new Map<string, Parameters<Registrar['registerTool']>[2]>()
  const server: Registrar = {
    registerTool(name, _config, handler) {
      handlers.set(name, handler)
    },
  }
  const client = new AikiClient('https://mocked-api.test')
  registerMandateTools(server, client, session)
  registerWorkTools(server, client, session)
  registerWalletTools(server, client, session, rpcUrl)
  return async (name: string, args: Record<string, unknown> = {}) => {
    const handler = handlers.get(name)
    if (!handler) throw new Error('Unknown test tool.')
    const result = await handler(args as never)
    return result.content.map((item) => item.text).join('\n')
  }
}
const posts = (path: string) => calls.filter((call) => call.method === 'POST' && call.path === path)

it('previews exact mainnet and testnet caps using fresh metadata without a wallet', async () => {
  const call = harness()
  expect(await call('preview_limits', caps)).toContain('BNB mainnet')
  expect(posts('/v1/mandates/preview')[0]?.body?.constraints).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'per_action_cap', value: '1250000000000000000' }),
      expect.objectContaining({ kind: 'contract_allowlist', value: [guardianFor(56).market] }),
    ]),
  )
  net = metadata(97)
  expect(await call('preview_limits', caps)).toContain('BNB testnet')
  expect(posts('/v1/mandates/preview')[1]?.body?.constraints).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'per_action_cap', value: '1250000' })]),
  )
  expect(requireSession).not.toHaveBeenCalled()
  expect(identityFns.loadIdentity).not.toHaveBeenCalled()
  expect(posts('/v1/account')).toEqual([])
})

it('rejects missing or invalid network metadata before creating or signing anything', async () => {
  networkResponse = { configured: false }
  await expect(harness()('create_mandate', caps)).rejects.toThrow('could not be verified')
  expect(requireSession).not.toHaveBeenCalled()
  expect(calls.filter((call) => call.method === 'POST')).toEqual([])
  expect(signed).not.toHaveBeenCalled()
})

it.each([
  { ...caps, total_usdt: 1 },
  { ...caps, per_action_usdt: Number.NaN },
  { ...caps, expires_in_days: 1.5 },
  { ...caps, per_action_usdt: 0.0000001 },
])('validates caps before account deployment, case %#', async (input) => {
  net = metadata(97)
  account = { address: null, chainId: 97 }
  await expect(harness()('create_mandate', input)).rejects.toThrow()
  expect(requireSession).not.toHaveBeenCalled()
  expect(posts('/v1/account')).toEqual([])
  expect(signed).not.toHaveBeenCalled()
})

it('deploys and signs a mainnet mandate with the checked account and domain', async () => {
  account = { address: null, chainId: 56 }
  const output = await harness()('create_mandate', caps)
  expect(output).toContain('Signed for BNB mainnet (56)')
  expect(posts('/v1/account')).toHaveLength(1)
  expect(requireSession).toHaveBeenCalledWith(56)
  expect(signed).toHaveBeenCalledWith(
    expect.objectContaining({
      domain: delegationDomain(56, manager),
      message: expect.objectContaining({ delegator: address }),
    }),
  )
  expect(posts('/v1/authorizations/mandate-one/delegation')).toHaveLength(1)
})

it.each([
  { address, chainId: 97 },
  { address: '0xwrong', chainId: 56 },
  { address: `0x${'00'.repeat(20)}`, chainId: 56 },
  { address },
])('rejects a mismatched or malformed existing account, case %#', async (value) => {
  account = value
  await expect(harness()('create_mandate', caps)).rejects.toThrow('account does not match')
  expect(posts('/v1/account')).toEqual([])
  expect(posts('/v1/authorizations')).toEqual([])
  expect(signed).not.toHaveBeenCalled()
})

it('validates a newly deployed account before creating its authorization', async () => {
  account = { address: null, chainId: 56 }
  madeAccount = { address, chainId: 97 }
  await expect(harness()('create_mandate', caps)).rejects.toThrow('account does not match')
  expect(posts('/v1/authorizations')).toEqual([])
  expect(signed).not.toHaveBeenCalled()
})

it.each(['chain', 'manager', 'delegator', 'unsigned', 'types'])(
  'never signs a mismatched preparation: %s',
  async (kind) => {
    if (kind === 'chain') prepared.domain.chainId = 97
    if (kind === 'manager') prepared.domain.verifyingContract = owner
    if (kind === 'delegator') prepared.message.delegator = owner
    if (kind === 'unsigned') prepared.unsigned.delegator = owner
    if (kind === 'types') prepared.types = {}
    const output = await harness()('create_mandate', caps)
    expect(output).toContain('NOT signed')
    expect(output).toContain('does not match')
    expect(signed).not.toHaveBeenCalled()
    expect(posts('/v1/authorizations/mandate-one/delegation')).toEqual([])
  },
)

it('starts a watch using its checked account chain and canonical guardian contracts', async () => {
  const output = await harness()('watch_position', { job_id: 'one', minimum_health_factor: '1.25' })
  expect(output).toContain('BNB mainnet (56)')
  expect(posts('/v1/jobs/one/watch')[0]?.body).toEqual({
    account: address,
    chainId: 56,
    minimumHealthFactor: '1.25',
    asset: guardianFor(56).asset,
    market: guardianFor(56).market,
  })
  account = { address, chainId: 97 }
  await expect(
    harness()('watch_position', { job_id: 'two', minimum_health_factor: '1.25' }),
  ).rejects.toThrow('account does not match')
  expect(posts('/v1/jobs/two/watch')).toEqual([])
})

it('formats historical watch units from the recorded chain without floating rounding', async () => {
  const call = harness()
  expect(await call('watch_status', { job_id: 'one' })).toContain('2.500000000000000001 USDT')
  watch = { ...watch, chainId: 97, asset: guardianFor(97).asset, remaining: '2500001' }
  const output = await call('watch_status', { job_id: 'one' })
  expect(output).toContain('BNB testnet (97)')
  expect(output).toContain('2.500001 USDT')
})

it('reports only actual 404s as not watching and preserves other failures', async () => {
  const call = harness()
  watchError = 503
  await expect(call('watch_status', { job_id: 'one' })).rejects.toBeInstanceOf(AikiError)
  watchError = 404
  expect(await call('watch_status', { job_id: 'one' })).toContain('Nothing is watching')
  watchError = null
  watch = { ...watch, chainId: undefined }
  await expect(call('watch_status', { job_id: 'one' })).rejects.toThrow('not supported')
})

it('labels an explicit RPC balance by its actual network and the account by its verified execution chain', async () => {
  identityFns.balanceOf.mockResolvedValue({
    amount: '2',
    chainId: 97,
    network: 'testnet',
    symbol: 'tBNB',
  })
  const output = await harness('https://explicit-rpc.test')('whoami')
  expect(identityFns.balanceOf).toHaveBeenCalledWith('https://explicit-rpc.test', owner)
  expect(output).toContain('2 tBNB on BNB testnet (97)')
  expect(output).toContain('mandate execution is on BNB mainnet (56)')
  expect(output).toContain(`${address} (BNB mainnet, chain 56)`)
})

it('derives the default RPC from current execution and keeps key creation free of funding claims', async () => {
  await harness()('whoami')
  expect(identityFns.balanceOf).toHaveBeenCalledWith('https://bsc-dataseed.bnbchain.org', owner)
  identityFns.loadIdentity.mockReturnValue(null)
  const output = await harness()('create_wallet', { confirm: true })
  expect(identityFns.createIdentity).toHaveBeenCalledOnce()
  expect(output).toContain('verify the current execution network')
  expect(output).not.toContain('Send BNB testnet USDT')
  expect(output).not.toContain('only ever be spent inside a mandate')
})

it('does not equate stopping AiKi work with on-chain revocation', async () => {
  const output = await harness()('revoke_mandate', { mandate_id: 'one' })
  expect(output).toContain('stopped inside AiKi')
  expect(output).toContain('separate on-chain action')
})
