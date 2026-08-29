import { describe, expect, it } from 'vitest'
import { classify } from '../prober/detect.js'
import { d1Variants } from '../prober/probe.js'
import { referenceBase, referenceManifest } from './manifest.js'

const spec = {
  name: 'Test Agent',
  description: 'Test',
  servicePath: '/v1/reference/test/agent',
  serviceName: 'test-capability',
  iconPath: '/v1/reference/test/icon.svg',
}

describe('first-party registration manifests', () => {
  it('publishes an endpoint AiKi’s own D1 rule can actually vary', () => {
    const manifest = referenceManifest(
      { publicBaseUrl: 'https://api.example', agentId: '315886' },
      spec,
    )
    const endpoint = manifest.services[0]?.endpoint as string
    const variants = d1Variants(endpoint)

    // Three variants is the whole point: with fewer, `classify` refuses to say LIVE
    // and returns DEGRADED / D1-inapplicable no matter how healthy the service is.
    expect(variants.map((v) => v.label)).toEqual(['valid', 'nonsense', 'nonNumeric'])
    expect(variants[1]?.url).toBe('https://api.example/v1/reference/test/agent/999999999')
  })

  it('would be graded LIVE when it answers, and never on status alone', () => {
    const manifest = referenceManifest(
      { publicBaseUrl: 'https://api.example', agentId: '315886' },
      spec,
    )
    const services = manifest.services.map((s) => ({ name: s.name, endpoint: s.endpoint }))
    const sample = (label: 'valid' | 'nonsense' | 'nonNumeric', status: number, hash: string) => ({
      label,
      url: 'https://api.example/x',
      status,
      bodyHash: hash,
      bodyLength: 10,
      contentType: 'application/json',
      latencyMs: 5,
    })

    expect(
      classify({
        services,
        samples: [
          sample('valid', 200, 'a'),
          sample('nonsense', 404, 'b'),
          sample('nonNumeric', 404, 'c'),
        ],
        primaryBody: '{"capability":"test-capability"}',
      }),
    ).toMatchObject({ state: 'LIVE', rule: 'D5' })

    // The control: if the identity check were removed and every id answered the same
    // bytes, our own prober must call our own agent an impostor.
    expect(
      classify({
        services,
        samples: [
          sample('valid', 200, 'a'),
          sample('nonsense', 200, 'a'),
          sample('nonNumeric', 200, 'a'),
        ],
        primaryBody: '{"capability":"test-capability"}',
      }),
    ).toMatchObject({ state: 'IMPOSTOR_STATIC', rule: 'D1' })
  })

  it('refuses an identity it cannot honestly publish', () => {
    expect(referenceBase({ publicBaseUrl: 'http://api.example', agentId: '1' })).toBeNull()
    expect(referenceBase({ publicBaseUrl: 'https://api.example', agentId: 'pending' })).toBeNull()
    expect(referenceBase({ publicBaseUrl: 'not a url', agentId: '1' })).toBeNull()
    expect(referenceBase(undefined)).toBeNull()
    expect(referenceBase({ publicBaseUrl: 'https://api.example/', agentId: '7' })).toBe(
      'https://api.example',
    )
  })
})
