import { afterEach, describe, expect, it, vi } from 'vitest'
import * as guardedNetwork from '../net/guard.js'
import type { ProbeAgentResult } from '../prober/probe.js'
import type { RegistrationResolution } from '../prober/registration.js'
import { REFERENCE_REGISTRY } from './manifest.js'
import {
  FIRST_PARTY_REPORT_OWNER,
  FIRST_PARTY_REPORT_REFRESH,
  firstPartyReportFetch,
  prepareFirstPartyReportRefresh,
} from './refresh-first-party.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture() {
  const registration = (uri: string): RegistrationResolution => {
    const target = FIRST_PARTY_REPORT_REFRESH.find((item) =>
      uri.endsWith(`${item.path}/manifest.json`),
    )
    if (!target) throw new Error('Unexpected report URI')
    return {
      uri,
      status: 'resolved',
      scheme: 'https',
      zeroCost: false,
      fetchedAt: new Date().toISOString(),
      manifest: {
        active: true,
        services: [
          {
            name: 'report',
            endpoint: `https://www.useaiki.xyz${target.path}/agent/${target.agentId}`,
          },
        ],
        registrations: [{ agentId: target.agentId, agentRegistry: REFERENCE_REGISTRY }],
        supportedTrust: [],
      },
    }
  }
  const reader = {
    chainId: vi.fn(async () => 56),
    identity: vi.fn(async (agentId: string) => {
      const target = FIRST_PARTY_REPORT_REFRESH.find((item) => item.agentId === agentId)
      if (!target) throw new Error('Unexpected report identity')
      return {
        owner: FIRST_PARTY_REPORT_OWNER,
        uri: `https://www.useaiki.xyz${target.path}/manifest.json`,
      }
    }),
  }
  const resolve = vi.fn(async (uri: string) => registration(uri))
  const probe = vi.fn(
    async ({ agentId }: { agentId: string }): Promise<ProbeAgentResult> => ({
      agentId,
      probedAt: new Date().toISOString(),
      registrationWasZeroCost: false,
      reciprocal: { verified: true, detail: 'Mocked reciprocal proof.' },
      samples: [],
      verdict: { state: 'LIVE', rule: 'D5', detail: 'Mocked report probe.' },
    }),
  )
  return {
    reader,
    resolve,
    probe,
    run: () => prepareFirstPartyReportRefresh(reader, { resolve, probe }),
  }
}

describe('exact-four first-party report refresh preparation, no live calls', () => {
  it.each([
    ['https://unreviewed.example/report', 'GET'],
    ['https://www.useaiki.xyz/v1/tasks', 'POST'],
    ['https://www.useaiki.xyz/v1/reference/venus/manifest.json', 'POST'],
    ['https://www.useaiki.xyz/v1/reference/venus/manifest.json?redirect=elsewhere', 'GET'],
  ])(
    'refuses an unreviewed destination/method %s %s before network access',
    async (url, method) => {
      const host = vi.spyOn(guardedNetwork, 'assertPublicHost').mockResolvedValue()
      const read = vi.fn()
      vi.stubGlobal('fetch', read)
      await expect(firstPartyReportFetch(url, { method })).rejects.toThrow('not reviewed')
      expect(host).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
    },
  )
  it('rejects redirects instead of following them to another public host', async () => {
    const f = fixture()
    vi.spyOn(guardedNetwork, 'assertPublicHost').mockResolvedValue()
    const read = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.redirect).toBe('error')
      throw new TypeError('Mocked rejected redirect')
    })
    vi.stubGlobal('fetch', read)
    await expect(prepareFirstPartyReportRefresh(f.reader, { probe: f.probe })).rejects.toThrow(
      'registration does not match',
    )
    expect(read).toHaveBeenCalledTimes(1)
    expect(f.probe).not.toHaveBeenCalled()
  })
  it('threads the restricted transport through all real prober variants and reciprocal reads', async () => {
    const f = fixture()
    vi.spyOn(guardedNetwork, 'assertPublicHost').mockResolvedValue()
    const read = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.redirect).toBe('error')
      expect(init.method).toBe('GET')
      throw new TypeError('Mocked rejected redirect')
    })
    vi.stubGlobal('fetch', read)
    await expect(prepareFirstPartyReportRefresh(f.reader, { resolve: f.resolve })).rejects.toThrow(
      'current LIVE reciprocal probe',
    )
    expect(read).toHaveBeenCalledTimes(4)
    expect(read.mock.calls.every(([url]) => url.origin === 'https://www.useaiki.xyz')).toBe(true)
  })
  it('verifies only the four fixed report identities and returns original measurement inputs', async () => {
    const f = fixture(),
      result = await f.run()
    expect(result.map((r) => r.agentId)).toEqual(['315943', '315944', '315945', '315946'])
    expect(f.resolve).toHaveBeenCalledTimes(4)
    expect(f.probe).toHaveBeenCalledTimes(4)
    expect(f.reader.identity).toHaveBeenCalledTimes(8)
    expect(result.every((r) => r.chainId === 56 && r.identityVerified)).toBe(true)
    expect(result[0]?.probe).toBe(await f.probe.mock.results[0]?.value)
  })
  it('refuses a different RPC chain before reading or probing any identity', async () => {
    const f = fixture()
    f.reader.chainId.mockResolvedValue(97)
    await expect(f.run()).rejects.toThrow('BSC mainnet')
    expect(f.reader.identity).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
  })
  it.each([
    'owner',
    'uri',
    'service',
    'claim',
    'reciprocal',
    'stale',
    'wrong-id',
    'not-live',
  ] as const)('refuses %s drift without returning persistable inputs', async (mode) => {
    const f = fixture()
    if (mode === 'owner' || mode === 'uri') {
      const identity = await f.reader.identity('315943')
      f.reader.identity.mockResolvedValue(
        mode === 'owner'
          ? { ...identity, owner: `0x${'ab'.repeat(20)}` }
          : { ...identity, uri: 'https://unreviewed.example/manifest.json' },
      )
    } else if (mode === 'service' || mode === 'claim') {
      const registration = await f.resolve(
        'https://www.useaiki.xyz/v1/reference/venus/manifest.json',
      )
      if (!registration.manifest) throw new Error('Missing mock manifest')
      if (mode === 'service')
        registration.manifest.services[0] = {
          name: 'arbitrary',
          endpoint: 'https://unreviewed.example/paid-task',
        }
      else
        registration.manifest.registrations = [
          { agentId: 'other', agentRegistry: REFERENCE_REGISTRY },
        ]
      f.resolve.mockResolvedValue(registration)
    } else {
      const result = await f.probe({ agentId: '315943' })
      if (mode === 'reciprocal') result.reciprocal = { verified: false, detail: 'Absent' }
      if (mode === 'stale') result.probedAt = new Date(Date.now() - 86_400_001).toISOString()
      if (mode === 'wrong-id') result.agentId = '315999'
      if (mode === 'not-live') result.verdict.state = 'DEGRADED'
      f.probe.mockResolvedValue(result)
    }
    await expect(f.run()).rejects.toThrow(/Report 315943/)
  })
  it('refuses an identity that changes after its probe', async () => {
    const f = fixture(),
      original = await f.reader.identity('315943')
    f.reader.identity
      .mockReset()
      .mockResolvedValueOnce(original)
      .mockResolvedValue({ ...original, owner: `0x${'ab'.repeat(20)}` })
    await expect(f.run()).rejects.toThrow('identity changed during verification')
  })
})
