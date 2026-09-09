import { randomUUID } from 'node:crypto'
import { ROOT_AUTHORITY, type SignedDelegation } from '@aiki/contracts'
import { afterAll, describe, expect, it } from 'vitest'
import type { Constraint } from '../authority/policy.js'
import { PostgresJobStore } from './postgres-store.js'
import { JobService } from './service.js'
import { InMemoryJobStore } from './store.js'

const owner = `0x${'12'.repeat(20)}`
const constraints = (): [Constraint, Constraint] => [
  { kind: 'session_total_cap', value: '1000', label: 'Lifetime total', tier: 'T2' },
  { kind: 'expiry', value: '2030-01-01T00:00:00.000Z', label: 'Expires', tier: 'T2' },
]
const stores: PostgresJobStore[] = []
afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()))
})

function cases(make: () => { first: JobService; second: JobService }) {
  it('replays one authorization across concurrent requests and a fresh service', async () => {
    const { first, second } = make()
    const key = randomUUID()
    const records = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? first : second).authorize(constraints(), owner, key),
      ),
    )
    expect(new Set(records.map((record) => record.id)).size).toBe(1)
    expect(new Set(records.map((record) => record.policy.id)).size).toBe(1)
    expect(new Set(records.map((record) => record.createdAt)).size).toBe(1)
    expect(await second.authorize(constraints(), owner, key)).toEqual(records[0])
  })

  it('does not reactivate a revoked authorization on retry', async () => {
    const { first, second } = make()
    const key = randomUUID()
    const original = await first.authorize(constraints(), owner, key)
    await first.revoke(original.id)
    const replay = await second.authorize(constraints(), owner, key)
    expect(replay.id).toBe(original.id)
    expect(replay.status).toBe('revoked')
    expect(replay.revokedAt).toBeTruthy()
  })

  it('refuses the same key with changed terms without modifying the original', async () => {
    const { first, second } = make()
    const key = randomUUID()
    const original = await first.authorize(constraints(), owner, key)
    const changed = constraints()
    changed[0] = { ...changed[0], value: '1001' }
    await expect(second.authorize(changed, owner, key)).rejects.toMatchObject({
      code: 'AUTHORIZATION_IDEMPOTENCY_CONFLICT',
      statusCode: 409,
    })
    expect(await first.getAuthorization(original.id)).toEqual(original)
  })

  it('isolates the same key by owner and normalizes owner case', async () => {
    const { first, second } = make()
    const key = randomUUID()
    const lower = `0x${'ab'.repeat(20)}`
    const original = await first.authorize(constraints(), lower, key)
    expect(
      (await second.authorize(constraints(), lower.toUpperCase().replace('0X', '0x'), key)).id,
    ).toBe(original.id)
    expect((await second.authorize(constraints(), owner, key)).id).not.toBe(original.id)
  })

  it('ignores object key order but not changed labels, tiers or expiry', async () => {
    const { first, second } = make()
    const key = randomUUID()
    const original = await first.authorize(constraints(), owner, key)
    const reordered = constraints().map(({ kind, value, label, tier }) => ({
      tier,
      label,
      value,
      kind,
    }))
    expect((await second.authorize(reordered, owner, key)).id).toBe(original.id)
    for (const patch of [{ label: 'Changed' }, { tier: 'T3' as const }, { value: '999' }]) {
      const changed = constraints()
      changed[0] = { ...changed[0], ...patch }
      await expect(second.authorize(changed, owner, key)).rejects.toMatchObject({ statusCode: 409 })
    }
  })

  it('retains ordinary unkeyed creation as separate authorizations', async () => {
    const { first } = make()
    const one = await first.authorize(constraints(), owner)
    expect((await first.authorize(constraints(), owner)).id).not.toBe(one.id)
  })

  it('preserves spent limits and a filed signature on keyed replay', async () => {
    const { first, second } = make()
    const key = randomUUID()
    const original = await first.authorize(constraints(), owner, key)
    const job = await first.createJob(original.id, randomUUID())
    await first.attempt(job.id, {
      target: '0x1',
      selector: '0x01',
      asset: '0x2',
      amount: 31n,
      at: '2029-01-01T00:00:00.000Z',
    })
    const delegation: SignedDelegation = {
      delegate: `0x${'34'.repeat(20)}`,
      delegator: `0x${'56'.repeat(20)}`,
      authority: ROOT_AUTHORITY,
      caveats: [],
      salt: '1',
      epoch: '0',
      signature: '0x1234',
    }
    // This store-level fixture stands in for a delegation already verified by the route.
    await first.attachDelegation(original.id, { delegation, chainId: 56 })
    const current = await first.getAuthorization(original.id)
    const replay = await second.authorize(constraints(), owner, key)
    expect(replay).toEqual(current)
    expect(replay.spent).toBe(31n)
    expect(replay.delegation).toEqual(delegation)
    expect(replay.delegationSignedAt).toBeTruthy()
  })
}

describe('authorization retry in memory', () => {
  cases(() => {
    const store = new InMemoryJobStore()
    return { first: new JobService(store), second: new JobService(store) }
  })
  it('rejects empty, oversized, whitespace/control keys and an unbound owner', async () => {
    const jobs = new JobService()
    for (const key of ['', ' ', 'a'.repeat(129), 'key\nother', 'key:😀'])
      await expect(jobs.authorize(constraints(), owner, key)).rejects.toMatchObject({
        statusCode: 400,
      })
    await expect(jobs.authorize(constraints(), null, randomUUID())).rejects.toMatchObject({
      statusCode: 400,
    })
  })
})

describe.skipIf(!process.env.DATABASE_URL)(
  'authorization retry across PostgreSQL connections',
  () => {
    cases(() => {
      const one = new PostgresJobStore(process.env.DATABASE_URL as string)
      const two = new PostgresJobStore(process.env.DATABASE_URL as string)
      stores.push(one, two)
      return { first: new JobService(one), second: new JobService(two) }
    })
  },
)
