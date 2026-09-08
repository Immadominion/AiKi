import { expect, it, vi } from 'vitest'
import { resolveTaskEndpoint } from './support.js'

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

it('selects the declared compatible task endpoint instead of the first service', async () => {
  const read = vi.fn(async (url: string | URL) =>
    response(
      String(url).endsWith('/task')
        ? {
            taskProtocol: 'aiki.task/v1',
            taskInputHint: 'Include a wallet address.',
            taskKinds: ['research', 'unknown'],
          }
        : { name: 'Agent website' },
    ),
  )
  const result = await resolveTaskEndpoint(
    [{ endpoint: 'https://agent.example/about' }, { endpoint: 'https://agent.example/task' }],
    read,
  )
  expect(result).toMatchObject({
    compatible: true,
    endpoint: 'https://agent.example/task',
    kinds: ['research'],
  })
  expect(result.inputHint).toContain('wallet')
  expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls[0]?.[0]).toBe('https://agent.example/about')
})

it('requires the explicit task protocol advertisement, not general liveness or a protocol-looking name', async () => {
  const read = vi.fn(async () => response({ live: true, protocol: 'aiki.task/v1' }))
  expect(
    (await resolveTaskEndpoint([{ endpoint: 'https://agent.example/task' }], read)).compatible,
  ).toBe(false)
})

it('refuses errors, large metadata and guarded fetch failures', async () => {
  for (const read of [
    vi.fn(async () => response({ taskProtocol: 'aiki.task/v1' }, 500)),
    vi.fn(async () => response({ taskProtocol: 'aiki.task/v1', extra: 'x'.repeat(17_000) })),
    vi.fn(async () => {
      throw new Error('Forbidden destination')
    }),
  ])
    expect(
      (await resolveTaskEndpoint([{ endpoint: 'https://agent.example/task' }], read)).compatible,
    ).toBe(false)
})

it('bounds and deterministically orders service checks without using non-web URLs', async () => {
  const read = vi.fn(async () => response({ taskProtocol: 'aiki.task/v1' }))
  const result = await resolveTaskEndpoint(
    [
      { endpoint: 'file:///private/task' },
      ...Array.from({ length: 12 }, (_, index) => ({
        endpoint: `https://agent.example/${11 - index}`,
      })),
    ],
    read,
  )
  expect(read).toHaveBeenCalledTimes(8)
  expect(result.endpoint).toBe('https://agent.example/0')
})
