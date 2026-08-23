import { expect, it } from 'vitest'
import { JobService } from './service.js'

it('is idempotent and stops actions after revocation', () => {
  const service = new JobService()
  const auth = service.authorize([
    { kind: 'session_total_cap', label: 'total', value: '10', tier: 'T2' },
  ])
  const a = service.createJob(auth.id, 'key')
  expect(service.createJob(auth.id, 'key').id).toBe(a.id)
  service.revoke(auth.id)
  expect(
    service.attempt(a.id, {
      target: 'x',
      selector: 'y',
      asset: 'z',
      amount: 1n,
      at: new Date().toISOString(),
    }).allow,
  ).toBe(false)
})
