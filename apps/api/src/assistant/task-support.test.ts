import { afterEach, expect, it, vi } from 'vitest'
import { MUTATING, runTool, TOOLS } from './tools.js'

afterEach(() => vi.unstubAllGlobals())

it('lets Fast mode check task compatibility through the same authenticated API without spending', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          available: true,
          protocol: 'aiki.task/v1',
          minimumPricePoints: 10,
          feeBasisPoints: 250,
        }),
        { status: 200 },
      ),
  )
  vi.stubGlobal('fetch', fetch)
  const result = await runTool(
    { baseUrl: 'https://api.example', cookie: 'test-session' },
    'agent_task_support',
    { agent_id: '315943' },
  )
  expect(result.ok).toBe(true)
  expect(result.body).toMatchObject({ available: true, feeBasisPoints: 250 })
  expect(fetch).toHaveBeenCalledWith(
    'https://api.example/v1/agents/315943/task-support',
    expect.objectContaining({
      headers: { cookie: 'test-session' },
    }),
  )
  expect(MUTATING.has('agent_task_support')).toBe(false)
  expect(TOOLS.some((tool) => tool.name === 'agent_task_support')).toBe(true)
})
