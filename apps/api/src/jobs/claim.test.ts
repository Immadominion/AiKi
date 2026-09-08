import { expect, it } from 'vitest'
import type { CompiledPolicy } from '../authority/policy.js'
import { InMemoryJobStore, type JobRecord } from './store.js'

/*
 * Only one of settling and refunding may take a job out of FUNDED.
 *
 * Both draw on one pooled escrow account holding every buyer's funded money,
 * and they used different idempotency keys, so the unique index on `reference`
 * could not see them racing. Run at the same time they both read FUNDED, both
 * judged themselves allowed, and both paid out against a single funding: the
 * second payment came out of somebody else's money in the same account.
 *
 * Reading a status and then acting on it cannot close that. The claim is one
 * conditional write, so exactly one caller matches.
 */

const POLICY = { hash: '0xhash', constraints: [] } as unknown as CompiledPolicy

async function fundedJob(store: InMemoryJobStore, id: string) {
  await store.createAuthorization({
    id: `auth-${id}`,
    policy: POLICY,
    status: 'active',
    spent: 0n,
    createdAt: '2026-09-01T00:00:00.000Z',
    owner: '0xbuyer',
  })
  const job: JobRecord = {
    id,
    authorizationId: `auth-${id}`,
    status: 'FUNDED',
    events: [],
    idempotencyKey: id,
    createdAt: '2026-09-01T00:00:00.000Z',
  }
  await store.createJob(job)
  return job
}

it('lets exactly one of settlement and refund take the money', async () => {
  const store = new InMemoryJobStore()
  await fundedJob(store, 'race')

  const [settle, refund] = await Promise.all([
    store.claim('race', ['FUNDED', 'COMPLETED', 'SETTLED'], 'SETTLED', 'settle'),
    store.claim('race', ['FUNDED', 'CANCELLED'], 'CANCELLED', 'refund'),
  ])

  // One wins, one loses, and the loser is told rather than paying anyway.
  expect([settle, refund].filter(Boolean)).toHaveLength(1)
})

it('lets a settlement that died mid-payout finish', async () => {
  const store = new InMemoryJobStore()
  await fundedJob(store, 'resume')

  expect(await store.claim('resume', ['FUNDED', 'COMPLETED', 'SETTLED'], 'SETTLED', 'first')).toBe(
    true,
  )
  /*
   * A run that claimed and then died before moving the money must be able to
   * come back. The transfers are idempotent by reference, so re-entering pays
   * nobody twice; refusing here would strand the money in escrow instead.
   */
  expect(await store.claim('resume', ['FUNDED', 'COMPLETED', 'SETTLED'], 'SETTLED', 'again')).toBe(
    true,
  )
  // Refund still cannot get in behind it.
  expect(await store.claim('resume', ['FUNDED', 'CANCELLED'], 'CANCELLED', 'refund')).toBe(false)
})

it('refuses to pay out a job nobody funded', async () => {
  const store = new InMemoryJobStore()
  const job = await fundedJob(store, 'unfunded')
  await store.appendEvents(job.id, [], 'AUTHORIZED')

  expect(await store.claim(job.id, ['FUNDED', 'COMPLETED', 'SETTLED'], 'SETTLED', 'x')).toBe(false)
  expect(await store.claim(job.id, ['FUNDED', 'CANCELLED'], 'CANCELLED', 'x')).toBe(false)
})
