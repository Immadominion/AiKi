import { expect, it } from 'vitest'
import { JobService } from './service.js'

it('is idempotent and stops actions after revocation', async () => {
  const service = new JobService()
  const auth = await service.authorize(
    [{ kind: 'session_total_cap', label: 'total', value: '10', tier: 'T2' }],
    '0xowner',
  )
  const a = await service.createJob(auth.id, 'key')
  expect((await service.createJob(auth.id, 'key')).id).toBe(a.id)
  await service.revoke(auth.id)
  expect(
    (
      await service.attempt(a.id, {
        target: 'x',
        selector: 'y',
        asset: 'z',
        amount: 1n,
        at: new Date().toISOString(),
      })
    ).allow,
  ).toBe(false)
})
