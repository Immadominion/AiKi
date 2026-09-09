import { guardianFor } from '@aiki/contracts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AikiClient } from './client.js'
import type { Registrar } from './register.js'
import { Session } from './session.js'
import { registerMandateTools } from './tools/mandate.js'
import { registerWorkTools } from './tools/work.js'

const identityFns = vi.hoisted(() => ({ loadIdentity: vi.fn(), signIn: vi.fn() }))
vi.mock('./identity.js', () => ({ ...identityFns, keyLocation: '/mocked/key' }))
const identity = { account: { address: `0x${'12'.repeat(20)}` }, source: 'environment' }
let chainId: 56 | 97
let metadataReads: number
let unavailable: boolean
let mutations: string[]
beforeEach(() => {
  chainId = 56
  metadataReads = 0
  unavailable = false
  mutations = []
  identityFns.loadIdentity.mockReset().mockReturnValue(identity)
  identityFns.signIn
    .mockReset()
    .mockResolvedValue({ address: identity.account.address, chainId: 56 })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (
        new URL(url).pathname.endsWith('/watch/stop') ||
        new URL(url).pathname.endsWith('/revoke')
      ) {
        mutations.push(new URL(url).pathname)
        return new Response(JSON.stringify({ ok: true }))
      }
      expect(new URL(url).pathname).toBe('/v1/execution/network')
      metadataReads++
      return new Response(
        JSON.stringify(
          unavailable
            ? { configured: false }
            : {
                configured: true,
                chainId,
                network: guardianFor(chainId).network,
                audited: false,
                manager: `0x${'34'.repeat(20)}`,
                guardian: guardianFor(chainId),
              },
        ),
      )
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('reads public metadata before signing in and rechecks it before cached session reuse', async () => {
  const client = new AikiClient('https://mocked-api.test')
  vi.spyOn(client, 'signedIn', 'get').mockReturnValue(true)
  const session = new Session(client, 'aiki.test')
  identityFns.signIn.mockImplementation(async () => {
    expect(metadataReads).toBe(1)
  })
  expect(await session.require(56)).toBe(identity)
  expect(identityFns.signIn).toHaveBeenCalledWith(client, identity, 'aiki.test', 56)
  expect(await session.require(56)).toBe(identity)
  expect(metadataReads).toBe(2)
  expect(identityFns.signIn).toHaveBeenCalledOnce()
})

it('does not reuse a session signed for a different execution network', async () => {
  const client = new AikiClient('https://mocked-api.test')
  vi.spyOn(client, 'signedIn', 'get').mockReturnValue(true)
  const session = new Session(client, 'aiki.test')
  await session.require(56)
  chainId = 97
  await session.require(97)
  expect(identityFns.signIn.mock.calls.map((call) => call[3])).toEqual([56, 97])
})

it('stops an operation if metadata no longer matches its selected network before loading or signing a key', async () => {
  chainId = 97
  const session = new Session(new AikiClient('https://mocked-api.test'), 'aiki.test')
  await expect(session.require(56)).rejects.toThrow('network changed')
  expect(identityFns.loadIdentity).not.toHaveBeenCalled()
  expect(identityFns.signIn).not.toHaveBeenCalled()
})

it('has no testnet fallback when current public metadata is unavailable', async () => {
  unavailable = true
  const session = new Session(new AikiClient('https://mocked-api.test'), 'aiki.test')
  await expect(session.require()).rejects.toThrow('could not be verified')
  expect(identityFns.loadIdentity).not.toHaveBeenCalled()
  expect(identityFns.signIn).not.toHaveBeenCalled()
})

it('keeps stop and revoke available through a valid session during a metadata outage while new execution stays blocked', async () => {
  const client = new AikiClient('https://mocked-api.test')
  vi.spyOn(client, 'signedIn', 'get').mockReturnValue(true)
  const session = new Session(client, 'aiki.test')
  await session.require(56)
  unavailable = true
  const handlers = new Map<string, Parameters<Registrar['registerTool']>[2]>()
  const registrar: Registrar = {
    registerTool(name, _config, handler) {
      handlers.set(name, handler)
    },
  }
  registerMandateTools(registrar, client, session)
  registerWorkTools(registrar, client, session)
  const call = (name: string, args: Record<string, unknown>) => {
    const handler = handlers.get(name)
    if (!handler) throw new Error('Missing test tool.')
    return handler(args as never)
  }
  await call('stop_watching', { job_id: 'one' })
  await call('revoke_mandate', { mandate_id: 'one' })
  expect(mutations).toEqual(['/v1/jobs/one/watch/stop', '/v1/authorizations/one/revoke'])
  expect(metadataReads).toBe(1)
  await expect(
    call('watch_position', { job_id: 'one', minimum_health_factor: '1.25' }),
  ).rejects.toThrow('could not be verified')
  await expect(
    call('create_mandate', { per_action_usdt: 1, total_usdt: 5, expires_in_days: 30 }),
  ).rejects.toThrow('could not be verified')
  expect(mutations).toHaveLength(2)
})
