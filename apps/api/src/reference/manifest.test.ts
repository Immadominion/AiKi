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

  /*
   * The whole hire path in one assertion.
   *
   * These three steps are owned by three different files, and for as long as the
   * middle one dropped `pricing` the outer two agreed with each other and were
   * both wrong: every agent on the chain quoted AGENT_HAS_NO_PUBLISHED_PRICE,
   * and no registration file anywhere could have fixed it. Testing the round
   * trip is the only thing that would have caught that, because each half is
   * correct on its own.
   */
  it('publishes a price that survives resolution and can be quoted', async () => {
    const manifest = referenceManifest(
      { publicBaseUrl: 'https://api.example', agentId: '315886' },
      spec,
    )
    // 0.1 of the settlement asset, which carries eighteen decimals on BNB Chain.
    expect(manifest.pricing).toEqual({ amount: '100000000000000000', asset: 'U' })

    const { parseManifest } = await import('../prober/registration.js')
    const resolved = parseManifest(JSON.stringify(manifest))
    expect(resolved.status).toBe('resolved')
    expect(resolved.manifest?.pricing?.amount).toBe('100000000000000000')

    const { publishedPrice } = await import('../settlement/published-price.js')
    const priced = publishedPrice('315886', [
      {
        id: 'x',
        subject: { type: 'agent', chainId: 56, registry: '0xr', agentId: '315886' },
        predicate: 'erc8004.registration_resolution',
        value: { manifest: resolved.manifest },
        validAt: '2026-09-01T00:00:00.000Z',
        observedAt: '2026-09-01T00:00:00.000Z',
        recordedAt: '2026-09-01T00:00:00.000Z',
        source: 'test',
        method: 'test',
        evidenceClass: 'B',
        dedupeKey: 'x',
      },
    ])
    expect(priced).toBe(100_000_000_000_000_000n)
  })

  it('drops a price it cannot authorise a payment against', async () => {
    const { parseManifest } = await import('../prober/registration.js')
    const base = referenceManifest(
      { publicBaseUrl: 'https://api.example', agentId: '315886' },
      spec,
    )
    const withPricing = (pricing: unknown) =>
      parseManifest(JSON.stringify({ ...base, pricing })).manifest?.pricing

    // A fraction, a negative, a word and a bare object are all unpayable. None
    // may be rounded, coerced or defaulted into a number somebody could sign.
    expect(withPricing({ amount: '0.1', asset: 'U' })).toBeUndefined()
    expect(withPricing({ amount: -5, asset: 'U' })).toBeUndefined()
    expect(withPricing({ amount: 'free' })).toBeUndefined()
    expect(withPricing({ asset: 'U' })).toBeUndefined()
    expect(withPricing('cheap')).toBeUndefined()
    // Zero is a real, stated price and must survive: free is not the same as unpriced.
    expect(withPricing({ amount: 0, asset: 'U' })).toEqual({ amount: '0', asset: 'U' })
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
