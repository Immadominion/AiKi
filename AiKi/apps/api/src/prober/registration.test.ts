import { describe, expect, it } from 'vitest'
import { REGISTRATION_TYPE, resolveRegistration } from './registration.js'

function data(value: unknown): string { return `data:application/json;base64,${Buffer.from(JSON.stringify(value)).toString('base64')}` }
const valid = {
  type: REGISTRATION_TYPE,
  name: 'Guardian',
  description: 'Protects a Venus lending position.',
  image: 'https://agent.example/icon.png',
  registrations: [{ agentId: 42, agentRegistry: 'eip155:56:0x8004' }],
  services: [{ name: 'APEX', endpoint: 'https://agent.example/apex/', transport: 'http' }],
  supportedTrust: ['reputation'],
}

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
    expect(result.manifest?.registrations[0]).toEqual({ agentId: '42', agentRegistry: 'eip155:56:0x8004' })
  })
})
