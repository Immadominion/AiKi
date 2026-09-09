import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { PostgresJobStore } from './postgres-store.js'
import { JobService } from './service.js'

const url = process.env.DATABASE_URL
const hash = `0x${'ab'.repeat(32)}` as const
const stores: PostgresJobStore[] = []
const service = () => {
  const store = new PostgresJobStore(url as string)
  stores.push(store)
  return new JobService(store)
}
afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()))
})

describe.skipIf(!url)('durable execution attempts', () => {
  async function fixture() {
    const jobs = service()
    const auth = await jobs.authorize(
      [{ kind: 'session_total_cap', label: 'cap', value: '1000', tier: 'T2' }],
      `0x${'11'.repeat(20)}`,
    )
    const job = await jobs.createJob(auth.id, randomUUID())
    return { jobs, auth, job }
  }

  it('permits exactly one concurrent claimant across two database connections', async () => {
    const h = await fixture()
    const second = service()
    const claims = await Promise.all([
      h.jobs.beginExecution(h.job.id, 56),
      second.beginExecution(h.job.id, 56),
    ])
    expect(claims.filter((claim) => claim.acquired)).toHaveLength(1)
    expect(claims[0]?.attempt.id).toBe(claims[1]?.attempt.id)
  })

  it('retains unresolved hash and cap across connection restart, including a new job', async () => {
    const h = await fixture()
    const claim = await h.jobs.beginExecution(h.job.id, 56)
    await h.jobs.attempt(h.job.id, {
      target: '0x1',
      selector: '0x12',
      asset: '0x1',
      amount: 40n,
      at: new Date().toISOString(),
    })
    await h.jobs.recordExecutionHash(claim.attempt.id, hash)
    await h.jobs.finishExecution(claim.attempt.id, 'UNCONFIRMED')
    const restart = service()
    const newerJob = await restart.createJob(h.auth.id, randomUUID())
    const retry = await restart.beginExecution(newerJob.id, 56)
    expect(retry).toMatchObject({
      acquired: false,
      attempt: { id: claim.attempt.id, transactionHash: hash, state: 'UNCONFIRMED' },
    })
    expect((await restart.getAuthorization(h.auth.id)).spent).toBe(40n)
    expect(
      (await restart.getJob(h.job.id)).events.some((event) => event.detail.includes(hash)),
    ).toBe(true)
  })

  it('does not release an uncertain cap, and keeps prepared hashes immutable', async () => {
    const h = await fixture()
    const claim = await h.jobs.beginExecution(h.job.id, 56)
    await h.jobs.recordExecutionHash(claim.attempt.id, hash)
    await expect(
      h.jobs.recordExecutionHash(claim.attempt.id, `0x${'cd'.repeat(32)}`),
    ).rejects.toThrow('cannot be changed')
    await expect(h.jobs.finishExecution(claim.attempt.id, 'UNCONFIRMED', 4n)).rejects.toThrow(
      'cannot release',
    )
    expect((await h.jobs.pendingExecution(h.auth.id))?.transactionHash).toBe(hash)
  })

  it('settles a known revert and releases its cap exactly once across concurrent retries', async () => {
    const h = await fixture()
    const claim = await h.jobs.beginExecution(h.job.id, 56)
    await h.jobs.attempt(h.job.id, {
      target: '0x1',
      selector: '0x12',
      asset: '0x1',
      amount: 100n,
      at: new Date().toISOString(),
    })
    await h.jobs.recordExecutionHash(claim.attempt.id, hash)
    await Promise.all([
      h.jobs.finishExecution(claim.attempt.id, 'REVERTED', 40n),
      service().finishExecution(claim.attempt.id, 'REVERTED', 40n),
    ])
    expect((await h.jobs.getAuthorization(h.auth.id)).spent).toBe(60n)
    expect(await h.jobs.pendingExecution(h.auth.id)).toBeNull()
    expect((await h.jobs.beginExecution(h.job.id, 56)).acquired).toBe(true)
  })

  it('has no timer that releases an abandoned preparing claim', async () => {
    const h = await fixture()
    const claim = await h.jobs.beginExecution(h.job.id, 97)
    const restart = service()
    expect(await restart.beginExecution(h.job.id, 97)).toMatchObject({
      acquired: false,
      attempt: { id: claim.attempt.id, state: 'PREPARING' },
    })
  })
})
