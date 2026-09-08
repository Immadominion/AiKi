import { afterAll, describe, expect, it } from 'vitest'
import { PostgresSellerStore } from './sellers.js'
import { PostgresTaskStore } from './store.js'

/*
 * A listing claims nothing. The record beside it is counted.
 *
 * That separation is the whole point of listing people here rather than
 * pointing at a directory. Anybody may type any name and any sentence, so those
 * carry no weight; what carries weight is what has actually settled through the
 * address, which is a join over the task table and cannot be edited into
 * something flattering.
 */
const url = process.env.DATABASE_URL

describe.skipIf(!url)('PostgresSellerStore', () => {
  const stores: (PostgresSellerStore | PostgresTaskStore)[] = []
  const sellers = () => {
    const made = new PostgresSellerStore(url as string)
    stores.push(made)
    return made
  }
  const tasks = () => {
    const made = new PostgresTaskStore(url as string)
    stores.push(made)
    return made
  }
  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close()))
  })

  const WORKER = `0x${'9a'.repeat(20)}`
  const BUYER = `0x${'8b'.repeat(20)}`

  it('lists somebody and starts their record at nothing', async () => {
    const store = sellers()
    const listed = await store.put({
      address: WORKER,
      name: 'Reads contracts',
      blurb: 'I read Solidity and tell you what it does, in Mandarin or English.',
      kinds: ['review', 'verify'],
      ratePoints: 800,
      available: true,
    })

    expect(listed.kinds).toEqual(['review', 'verify'])
    // Nothing delivered yet, and the listing says so rather than being silent
    // about it. A new seller with no record is a fact, not an embarrassment.
    expect(listed.record).toEqual({ delivered: 0, disputed: 0, earnedPoints: 0 })
  })

  it('counts what actually settled, not what anybody typed', async () => {
    const store = sellers()
    const taskStore = tasks()
    await store.put({
      address: WORKER,
      name: 'Reads contracts',
      blurb: 'I read Solidity.',
      kinds: ['review'],
      ratePoints: 800,
      available: true,
    })

    const done = await taskStore.create({
      poster: BUYER,
      title: 'Read this',
      brief: 'Say what it does.',
      kind: 'review',
      pricePoints: 700,
      feePoints: 17,
      totalPoints: 717,
      outlay: 71_700_000_000_000_000n,
      workHours: 24,
      hiredPerson: WORKER,
    })
    await taskStore.submit(done.id, WORKER, 'It does this.')
    await taskStore.advance(done.id, ['SUBMITTED'], 'SETTLED')

    const after = await store.get(WORKER)
    expect(after?.record.delivered).toBeGreaterThanOrEqual(1)
    expect(after?.record.earnedPoints).toBeGreaterThanOrEqual(700)
  })

  it('keeps commissioned work off the public board', async () => {
    /*
     * The reason hiring a person needed its own marker. They commissioned one
     * party; if that party goes quiet the money goes back to the buyer, never to
     * whoever happened to be watching the board when the deadline passed.
     */
    const taskStore = tasks()
    const hired = await taskStore.create({
      poster: BUYER,
      title: 'Commissioned',
      brief: 'For you specifically.',
      kind: 'writing',
      pricePoints: 300,
      feePoints: 7,
      totalPoints: 307,
      outlay: 30_700_000_000_000_000n,
      workHours: 1,
      hiredPerson: WORKER,
    })

    expect(hired.status).toBe('CLAIMED')
    expect(hired.directHire).toBe(true)
    expect(hired.claimedBy).toBe(WORKER.toLowerCase())
    expect((await taskStore.open(500)).some((t) => t.id === hired.id)).toBe(false)
  })

  it('hides somebody who is not taking work, without losing their record', async () => {
    // Better than deleting a listing, which would throw away the only thing on
    // it worth anything.
    const store = sellers()
    await store.put({
      address: WORKER,
      name: 'Reads contracts',
      blurb: 'Away for a bit.',
      kinds: ['review'],
      ratePoints: 800,
      available: false,
    })

    expect((await store.list(500)).some((s) => s.address === WORKER.toLowerCase())).toBe(false)
    const still = await store.get(WORKER)
    expect(still?.record.delivered).toBeGreaterThanOrEqual(1)
  })
})
