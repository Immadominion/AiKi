import { expect, it } from 'vitest'
import type { CompiledPolicy } from '../authority/policy.js'
import { InMemoryJobStore, type JobRecord } from './store.js'

/*
 * The terms of a sale are fixed when the money is taken.
 *
 * Verified as a money-loss bug before this existed: the jobs table recorded no
 * agent and no amount, so settlement took the agent from its own request body
 * and worked the price out again from whatever the registry said by then. A
 * buyer could settle naming an agent whose owner was themselves and have the
 * escrow paid to their own address, and a price that moved between funding and
 * settlement paid the seller a different number from the one they were charged.
 */

const POLICY = { hash: '0xhash', constraints: [] } as unknown as CompiledPolicy
/* `outlay` is what the buyer parted with in base units of the settlement asset,
 * which is the unit a mandate's caps are written in. Points are the wrong unit
 * for a cap by a factor of 10^14. */
const SOLD = {
  agentId: '315943',
  pricePoints: 1_000,
  totalPoints: 1_025,
  outlay: 102_500_000_000_000_000n,
}

async function jobFor(store: InMemoryJobStore, authId: string, key: string) {
  await store.createAuthorization({
    id: authId,
    policy: POLICY,
    status: 'active',
    spent: 0n,
    createdAt: '2026-09-01T00:00:00.000Z',
    owner: '0xbuyer',
  })
  const job: JobRecord = {
    id: `job-${key}`,
    authorizationId: authId,
    status: 'AUTHORIZED',
    events: [],
    idempotencyKey: key,
    createdAt: '2026-09-01T00:00:00.000Z',
  }
  await store.createJob(job)
  return job
}

it('remembers who was bought and for how much', async () => {
  const store = new InMemoryJobStore()
  const job = await jobFor(store, 'a1', 'k1')
  expect(job.sale).toBeUndefined()

  await store.recordSale(job.id, SOLD)
  expect((await store.getJob(job.id))?.sale).toEqual(SOLD)
})

it('refuses to re-sell a job that has already been paid for', async () => {
  const store = new InMemoryJobStore()
  const job = await jobFor(store, 'a2', 'k2')
  await store.recordSale(job.id, SOLD)

  /*
   * Two funders racing must not both write terms. The second is told it lost
   * rather than quietly overwriting the first, which would change who gets paid
   * after the money had already been taken for somebody else.
   */
  await expect(store.recordSale(job.id, { ...SOLD, agentId: '310108' })).rejects.toThrow()
  expect((await store.getJob(job.id))?.sale?.agentId).toBe('315943')
})

it('will not record a sale against a job that does not exist', async () => {
  const store = new InMemoryJobStore()
  await expect(store.recordSale('no-such-job', SOLD)).rejects.toThrow()
})
