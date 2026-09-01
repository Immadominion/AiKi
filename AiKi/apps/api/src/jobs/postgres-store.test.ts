import { randomUUID } from 'node:crypto'
import type { SignedDelegation } from '@aiki/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compilePolicy } from '../authority/policy.js'
import { PostgresJobStore } from './postgres-store.js'
import { JobService } from './service.js'

const url = process.env.DATABASE_URL
const databaseUrl = url

/**
 * These run only where a database exists. CI provides one; a laptop without
 * Postgres skips them rather than failing, and the suite says which it did.
 */
describe.skipIf(!url)('PostgresJobStore', () => {
  const stores: PostgresJobStore[] = []
  const store = () => {
    const made = new PostgresJobStore(url as string)
    stores.push(made)
    return made
  }

  beforeAll(async () => {
    const sql = store()
    // A clean slate per run, so a previous run's rows cannot mask a regression.
    await (sql as unknown as { sql: (s: TemplateStringsArray) => Promise<unknown> }).sql`
      TRUNCATE job_events, jobs, authorizations RESTART IDENTITY CASCADE
    `
  })
  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close()))
  })

  it('survives a restart: a mandate outlives the process that made it', async () => {
    const before = new JobService(store())
    const auth = await before.authorize(
      [
        { kind: 'session_total_cap', label: 'total', value: '1000', tier: 'T2' },
        { kind: 'per_action_cap', label: 'each', value: '400', tier: 'T2' },
      ],
      '0xowner',
    )
    const job = await before.createJob(auth.id, 'restart-key')
    await before.attempt(job.id, {
      target: '0xabc',
      selector: '0x01',
      asset: '0xusdt',
      amount: 250n,
      at: new Date().toISOString(),
    })

    // A brand new service over a brand new connection: the process "restarted".
    const after = new JobService(store())
    const reloaded = await after.getAuthorization(auth.id)
    expect(reloaded.spent).toBe(250n)
    expect(reloaded.policy.hash).toBe(auth.policy.hash)

    const reloadedJob = await after.getJob(job.id)
    expect(reloadedJob.status).toBe('RUNNING')
    // AUTHORIZED, the policy verdict, and the spend, in the order they happened.
    expect(reloadedJob.events.map((e) => e.type)).toEqual(['status', 'policy', 'spend'])

    // Idempotency is a property of the database, not of a process-local map.
    expect((await after.createJob(auth.id, 'restart-key')).id).toBe(job.id)
  })

  it('holds the line under concurrency: a cap cannot be double-spent', async () => {
    const service = new JobService(store())
    // Ten actions of 100 against a cap of 550: exactly five may pass.
    const auth = await service.authorize(
      [{ kind: 'session_total_cap', label: 'total', value: '550', tier: 'T2' }],
      '0xowner',
    )
    const jobs = await Promise.all(
      Array.from({ length: 10 }, (_, i) => service.createJob(auth.id, `race-${i}`)),
    )
    const action = {
      target: '0xabc',
      selector: '0x01',
      asset: '0xusdt',
      amount: 100n,
      at: new Date().toISOString(),
    }
    const verdicts = await Promise.all(jobs.map((job) => service.attempt(job.id, action)))

    expect(verdicts.filter((v) => v.allow)).toHaveLength(5)
    expect((await service.getAuthorization(auth.id)).spent).toBe(500n)
  })

  it('stores uint256 amounts without truncating them', async () => {
    const service = new JobService(store())
    // Larger than a signed 64-bit integer: a BIGINT column would have thrown or
    // silently wrapped, which is how caps quietly stop meaning anything.
    const huge = 2n ** 200n
    const auth = await service.authorize(
      [{ kind: 'session_total_cap', label: 'total', value: (huge * 2n).toString(), tier: 'T2' }],
      '0xowner',
    )
    const job = await service.createJob(auth.id, 'uint256-key')
    const verdict = await service.attempt(job.id, {
      target: '0xabc',
      selector: '0x01',
      asset: '0xusdt',
      amount: huge,
      at: new Date().toISOString(),
    })
    expect(verdict.allow).toBe(true)
    expect((await service.getAuthorization(auth.id)).spent).toBe(huge)
  })
})

it.skipIf(!databaseUrl)(
  'keeps the first signature and refuses to let a second replace it',
  async () => {
    const url = process.env.DATABASE_URL
    if (!url) return
    const { PostgresJobStore } = await import('./postgres-store.js')
    const store = new PostgresJobStore(url)
    try {
      const id = randomUUID()
      await store.createAuthorization({
        id,
        policy: compilePolicy([
          { kind: 'session_total_cap', value: '1000', tier: 'T2', label: 'cap' },
        ]),
        status: 'active',
        spent: 0n,
        createdAt: new Date().toISOString(),
        owner: `0x${'ab'.repeat(20)}`,
      })

      const first: SignedDelegation = {
        delegate: `0x${'11'.repeat(20)}`,
        delegator: `0x${'22'.repeat(20)}`,
        authority: `0x${'ff'.repeat(32)}`,
        caveats: [{ enforcer: `0x${'33'.repeat(20)}`, terms: '0xaaaa', args: '0x' }],
        salt: '1',
        epoch: '0',
        signature: `0x${'11'.repeat(65)}` as `0x${string}`,
      }
      const attached = await store.attachDelegation(
        id,
        first,
        first.delegator,
        97,
        new Date().toISOString(),
      )
      expect(attached?.delegation?.signature).toBe(first.signature)
      expect(attached?.delegationChainId).toBe(97)
      // A number, not the string INTEGER can arrive as: a chain id read as "97"
      // never equals 97, and the mandate would look like it was for another chain.
      expect(typeof attached?.delegationChainId).toBe('number')

      // Signing again over different terms is how the limits somebody agreed to
      // would quietly become different limits. The UPDATE says `delegation IS
      // NULL` rather than reading first, so two racing requests cannot both win.
      const firstCaveat = first.caveats[0]
      if (!firstCaveat) throw new Error('fixture has no caveats')
      const second: SignedDelegation = {
        ...first,
        caveats: [{ ...firstCaveat, terms: '0xbbbb' }],
      }
      const again = await store.attachDelegation(
        id,
        second,
        second.delegator,
        97,
        new Date().toISOString(),
      )
      expect(again?.delegation?.caveats[0]?.terms).toBe('0xaaaa')
    } finally {
      await store.close()
    }
  },
)
