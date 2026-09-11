import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenDestinationError } from '../net/guard.js'
import { REGISTRATION_TYPE, resolveRegistration } from './registration.js'

function data(value: unknown): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(value)).toString('base64')}`
}
const valid = {
  type: REGISTRATION_TYPE,
  name: 'Guardian',
  description: 'Protects a Venus lending position.',
  image: 'https://agent.example/icon.png',
  registrations: [{ agentId: 42, agentRegistry: 'eip155:56:0x8004' }],
  services: [{ name: 'APEX', endpoint: 'https://agent.example/apex/', transport: 'http' }],
  supportedTrust: ['reputation'],
}
const cid = `bafy${'a'.repeat(55)}`
const ipfsUri = `ipfs://${cid}/registration.json`
const gatewayUrl = (host: string) => `https://${host}/ipfs/${cid}/registration.json`

afterEach(() => vi.useRealTimers())

describe('resolveRegistration', () => {
  it('resolves a data URI but marks it as zero-cost rather than availability evidence', async () => {
    const result = await resolveRegistration(data(valid))
    expect(result).toMatchObject({ scheme: 'data', status: 'resolved', zeroCost: true })
    expect(result.manifest?.services).toHaveLength(1)
  })
  it('rejects a registration-v1 document missing required identity fields', async () => {
    const result = await resolveRegistration(data({ type: REGISTRATION_TYPE, name: 'Incomplete' }))
    expect(result.status).toBe('invalid')
    expect(result.detail).toContain('missing')
  })
  it('does not treat a self-declared registration as identity proof', async () => {
    const result = await resolveRegistration(data(valid))
    expect(result.manifest?.registrations[0]).toEqual({
      agentId: '42',
      agentRegistry: 'eip155:56:0x8004',
    })
  })

  it('uses the public ipfs://CID/path format without changing the registered URI', async () => {
    const read = vi.fn(async (_url: string | URL, _init?: RequestInit) => Response.json(valid))
    const result = await resolveRegistration(ipfsUri, undefined, read)
    expect(result).toMatchObject({ uri: ipfsUri, scheme: 'ipfs', status: 'resolved' })
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]?.[0]).toBe(gatewayUrl('ipfs.io'))
  })

  it('falls back only once after gateway 429, preserving the exact CID and path', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(Response.json(valid))
    const result = await resolveRegistration(ipfsUri, undefined, read)
    expect(result).toMatchObject({
      uri: ipfsUri,
      status: 'resolved',
      detail: expect.stringContaining('dweb.link'),
    })
    expect(read.mock.calls.map(([url]) => url)).toEqual([
      gatewayUrl('ipfs.io'),
      gatewayUrl('dweb.link'),
    ])
  })

  it.each(['120', new Date(Date.now() + 120_000).toUTCString()])(
    'respects gateway Retry-After %s without retrying the throttled host',
    async (retryAfter) => {
      vi.useFakeTimers()
      const read = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 429, headers: { 'retry-after': retryAfter } }),
        )
        .mockImplementation(async () => Response.json(valid))
      await resolveRegistration(ipfsUri, undefined, read)
      await resolveRegistration(ipfsUri, undefined, read)
      expect(read.mock.calls.map(([url]) => new URL(url).hostname)).toEqual([
        'ipfs.io',
        'dweb.link',
        'dweb.link',
      ])
      await vi.advanceTimersByTimeAsync(121_000)
      await resolveRegistration(ipfsUri, undefined, read)
      expect(new URL(read.mock.calls.at(-1)?.[0]).hostname).toBe('ipfs.io')
    },
  )

  it('keeps both throttled gateways on cooldown and leaves resolution unknown', async () => {
    const read = vi.fn(async () => new Response(null, { status: 429 }))
    expect(await resolveRegistration(ipfsUri, undefined, read)).toMatchObject({
      status: 'unreachable',
    })
    expect(await resolveRegistration(ipfsUri, undefined, read)).toMatchObject({
      status: 'unreachable',
    })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('never silently switches an explicitly configured gateway', async () => {
    const read = vi.fn(async () => new Response(null, { status: 429 }))
    expect(
      await resolveRegistration(ipfsUri, 'https://operator.example/ipfs/', read),
    ).toMatchObject({ status: 'unreachable' })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it.each([401, 402, 403, 404, 500, 503])(
    'does not bypass HTTP %s with another gateway',
    async (status) => {
      const read = vi.fn(async () => new Response(null, { status }))
      expect(await resolveRegistration(ipfsUri, undefined, read)).toMatchObject({
        status: 'unreachable',
        detail: `HTTP ${status}`,
      })
      expect(read).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    new Error('private credentials must not escape'),
    new ForbiddenDestinationError('internal.example'),
  ])('does not bypass unsafe or unknown transport failures', async (error) => {
    const read = vi.fn().mockRejectedValue(error)
    const result = await resolveRegistration(ipfsUri, undefined, read)
    expect(result.status).toBe('unreachable')
    expect(result.detail).not.toContain(error.message)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it.each(['not JSON', JSON.stringify({ type: REGISTRATION_TYPE })])(
    'does not retry malformed metadata',
    async (body) => {
      const read = vi.fn(async () => new Response(body))
      expect(await resolveRegistration(ipfsUri, undefined, read)).toMatchObject({
        status: 'invalid',
      })
      expect(read).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    'ipfs://ipfs/example',
    `ipfs://${cid}/../secret`,
    `ipfs://${cid}/./registration.json`,
    `ipfs://${cid}/%2e%2e`,
    `ipfs://${cid}?query=1`,
  ])('rejects unsafe or noncanonical paths before fetching: %s', async (uri) => {
    const read = vi.fn()
    expect(await resolveRegistration(uri, undefined, read)).toMatchObject({ status: 'unreachable' })
    expect(read).not.toHaveBeenCalled()
  })

  it('enforces the body cap on the fallback without a third attempt', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response('a'.repeat(512 * 1024 + 1)))
    expect(await resolveRegistration(ipfsUri, undefined, read)).toMatchObject({
      status: 'unreachable',
      detail: expect.stringContaining('byte limit'),
    })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('aborts a nonresponsive transport after 5 seconds even when it ignores abort; late 429 cannot start fallback', async () => {
    vi.useFakeTimers()
    let finish!: (value: Response) => void
    const read = vi.fn(
      (_url: string | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const pending = resolveRegistration(ipfsUri, undefined, read)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toMatchObject({
      status: 'unreachable',
      detail: expect.stringContaining('deadline'),
    })
    expect(read.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    finish(new Response(null, { status: 429 }))
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds both attempts together and cancels a stalled fallback body', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve(new Response(null, { status: 429 })), 4_900),
          ),
      )
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
    const pending = resolveRegistration(ipfsUri, undefined, read)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ status: 'unreachable' })
    expect(read).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
