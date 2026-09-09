import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('node:https', () => ({ request: mocks.request }))

import { boundedText, isPublicDestination, publicFetch } from './transport.js'

describe('pinned HTTPS network transport', () => {
  beforeEach(() => {
    mocks.lookup.mockReset().mockResolvedValue([{ address: '104.21.41.9', family: 4 }])
    mocks.request.mockReset()
  })
  function response(status: number, headers: Record<string, string> = {}) {
    const stream = Object.assign(new PassThrough(), { statusCode: status, headers })
    mocks.request.mockImplementation(
      (_options: RequestOptions, callback: (message: IncomingMessage) => void) => {
        const request = new EventEmitter() as EventEmitter & { end: () => void }
        request.end = () =>
          queueMicrotask(() => {
            callback(stream as unknown as IncomingMessage)
            if (!stream.destroyed) stream.end('ok')
          })
        return request
      },
    )
    return stream
  }
  it.each([600, 700, 199])(
    'rejects provider status%s without throwing outside the promise',
    async (status) => {
      const stream = response(status)
      await expect(publicFetch(new URL('https://provider.example/mcp'), {})).rejects.toMatchObject({
        code: 'INVALID_HTTP_STATUS',
      })
      expect(stream.destroyed).toBe(true)
    },
  )
  it('contains invalid response-header construction exceptions', async () => {
    const stream = response(200, { 'x-invalid': 'line\nbreak' })
    await expect(publicFetch(new URL('https://provider.example/mcp'), {})).rejects.toMatchObject({
      code: 'INVALID_HTTP_RESPONSE',
    })
    expect(stream.destroyed).toBe(true)
  })
  it('pins the checked address and preserves TLS hostname verification', async () => {
    response(201)
    const result = await publicFetch(new URL('https://provider.example/mcp?x=1'), {
      method: 'POST',
      body: '{}',
      headers: { accept: 'application/json' },
    })
    expect(await boundedText(result, 20)).toBe('ok')
    expect(mocks.lookup).toHaveBeenCalledTimes(1)
    expect(mocks.request.mock.calls[0]?.[0]).toMatchObject({
      hostname: '104.21.41.9',
      servername: 'provider.example',
      agent: false,
      path: '/mcp?x=1',
      headers: { host: 'provider.example' },
    })
    expect(mocks.request.mock.calls[0]?.[0]).not.toHaveProperty('rejectUnauthorized', false)
  })
  it('refuses mixed public/private DNS answers before connection', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '104.21.41.9', family: 4 },
      { address: '10.0.0.2', family: 4 },
    ])
    await expect(publicFetch(new URL('https://provider.example/mcp'), {})).rejects.toMatchObject({
      code: 'UNSAFE_ENDPOINT',
    })
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('does not follow redirects or send MCP session IDs to a redirected host', async () => {
    const stream = response(307, { location: 'https://127.0.0.1/admin' })
    await expect(
      publicFetch(new URL('https://provider.example/mcp'), {
        headers: { 'mcp-session-id': 'private' },
      }),
    ).rejects.toMatchObject({ code: 'ENDPOINT_REDIRECT' })
    expect(stream.destroyed).toBe(true)
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
  it('times out even during DNS lookup without opening a socket later', async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const controller = new AbortController()
    const operation = publicFetch(new URL('https://provider.example/mcp'), {
      signal: controller.signal,
    })
    controller.abort()
    await expect(operation).rejects.toThrow()
    finish([{ address: '104.21.41.9', family: 4 }])
    await Promise.resolve()
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it.each(['::7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001::1', '3fff::1', 'fc00::1'])(
    'rejects transition/private/reserved IPv6 %s',
    (address) => {
      expect(isPublicDestination(address)).toBe(false)
    },
  )
  it('allows public global IPv6', () => expect(isPublicDestination('2606:4700::1111')).toBe(true))
})
