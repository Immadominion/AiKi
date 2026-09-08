import { expect, it, vi } from 'vitest'
import { createVenusReferenceServer } from './server.js'

it('advertises the implemented task protocol and required input without running an assessment', async () => {
  const assess = vi.fn()
  const app = createVenusReferenceServer({
    reader: { assess } as never,
    registration: { agentId: '315943' } as never,
  })
  try {
    const result = await app.inject({ method: 'GET', url: '/v1/reference/venus/agent/315943' })
    expect(result.json()).toMatchObject({
      taskProtocol: 'aiki.task/v1',
      taskKinds: ['research', 'data', 'verify'],
    })
    expect(result.json().taskInputHint).toContain('0x wallet address')
    expect(assess).not.toHaveBeenCalled()
  } finally {
    await app.close()
  }
})
