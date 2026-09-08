import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compilePolicy } from '../authority/policy.js'
import { PostgresJobStore } from '../jobs/postgres-store.js'
import { PostgresWatchStore, type Watch } from './store.js'

const url = process.env.DATABASE_URL

/**
 * These run only where a database exists. The claim query is the reason they
 * matter: it is the one piece of this feature whose correctness lives entirely
 * in SQL, and an in-memory store cannot tell you whether two schedulers racing
 * for the same watch both get it.
 */
describe.skipIf(!url)('PostgresWatchStore', () => {
  const stores: PostgresWatchStore[] = []
  const jobStores: PostgresJobStore[] = []
  const store = () => {
    const made = new PostgresWatchStore(url as string)
    stores.push(made)
    return made
  }

  const raw = (s: PostgresWatchStore) =>
    (s as unknown as { sql: (t: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }).sql

  /** A real job row, because watches carry a foreign key onto one. */
  async function job() {
    const jobs = new PostgresJobStore(url as string)
    jobStores.push(jobs)
    const authorizationId = randomUUID()
    await jobs.createAuthorization({
      id: authorizationId,
      policy: compilePolicy([
        { kind: 'session_total_cap', value: '1000', tier: 'T0', label: 'cap' },
      ]),
      status: 'active',
      spent: 0n,
      createdAt: new Date().toISOString(),
      owner: `0x${'ab'.repeat(20)}`,
    })
    const id = randomUUID()
    await jobs.createJob({
      id,
      authorizationId,
      idempotencyKey: randomUUID(),
      status: 'AUTHORIZED',
      events: [],
      createdAt: new Date().toISOString(),
    })
    return { id, authorizationId }
  }

  const watch = (ids: { id: string; authorizationId: string }): Watch => ({
    jobId: ids.id,
    authorizationId: ids.authorizationId,
    account: `0x${'22'.repeat(20)}`,
    chainId: 97,
    protocol: 'venus',
    minimumHealthFactor: '1.25',
    asset: `0x${'11'.repeat(20)}`,
    market: `0x${'11'.repeat(20)}`,
    status: 'active',
    createdAt: new Date().toISOString(),
  })

  beforeAll(async () => {
    await raw(store())`TRUNCATE watches RESTART IDENTITY CASCADE`
  })
  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close()))
    await Promise.all(jobStores.map((s) => s.close()))
  })

  it('round-trips a watch, chain id included', async () => {
    const s = store()
    const created = await s.create(watch(await job()))
    const read = await s.get(created.jobId)
    // INTEGER has come back as a string from this driver before, and a chain id
    // read as "97" never equals 97.
    expect(read?.chainId).toBe(97)
    expect(read?.status).toBe('active')
    expect(read?.lastCheckedAt).toBeUndefined()
  })

  it('hands one watch to exactly one of two racing schedulers', async () => {
    /*
     * The whole reason claiming is a single statement. A plain SELECT ... FOR
     * UPDATE would release its lock the moment the query returned, because this
     * driver runs each query in its own implicit transaction, and both passes
     * would repay the same shortfall.
     */
    const s = store()
    const created = await s.create(watch(await job()))
    const other = new PostgresWatchStore(url as string)
    stores.push(other)
    const now = new Date()
    const [a, b] = await Promise.all([s.claimDue(now, 60_000, 10), other.claimDue(now, 60_000, 10)])
    // Counted for this watch specifically: other tests leave their own rows due,
    // and a total across both passes would count those too.
    const claims = [...a, ...b].filter((w) => w.jobId === created.jobId)
    expect(claims.length).toBe(1)
  })

  it('does not offer a watch again until it is stale', async () => {
    const s = store()
    const created = await s.create(watch(await job()))
    const now = new Date()
    expect((await s.claimDue(now, 60_000, 10)).some((w) => w.jobId === created.jobId)).toBe(true)
    expect((await s.claimDue(now, 60_000, 10)).some((w) => w.jobId === created.jobId)).toBe(false)
    // Far enough in the future that the interval has passed.
    const later = new Date(now.getTime() + 120_000)
    expect((await s.claimDue(later, 60_000, 10)).some((w) => w.jobId === created.jobId)).toBe(true)
  })

  it('keeps the last action time through a quiet pass', async () => {
    // A quiet pass that cleared it would restart the cooldown every minute and
    // the agent would repay the same shortfall over and over.
    const s = store()
    const created = await s.create(watch(await job()))
    const acted = new Date().toISOString()
    await s.noteChecked(created.jobId, acted, 'repaid', acted)
    await s.noteChecked(created.jobId, new Date(Date.now() + 1000).toISOString(), 'all well')
    const read = await s.get(created.jobId)
    expect(read?.lastActedAt).toBeTruthy()
    expect(read?.lastReason).toBe('all well')
  })

  it('never claims a stopped watch', async () => {
    const s = store()
    const created = await s.create(watch(await job()))
    await s.stop(created.jobId)
    const claimed = await s.claimDue(new Date(Date.now() + 600_000), 60_000, 50)
    expect(claimed.some((w) => w.jobId === created.jobId)).toBe(false)
  })

  it('refuses a second watch on the same job', async () => {
    const s = store()
    const ids = await job()
    await s.create(watch(ids))
    await expect(s.create(watch(ids))).rejects.toThrow(/already being watched/)
  })
})
