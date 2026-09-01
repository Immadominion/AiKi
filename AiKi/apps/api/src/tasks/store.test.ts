import { afterAll, describe, expect, it } from 'vitest'
import { PostgresTaskStore } from './store.js'

/*
 * The status field is the safety mechanism, so it is tested against the
 * database that enforces it and not against an object that agrees with itself.
 *
 * The property that matters most is the one at the bottom: a poster cannot take
 * the money back once somebody has claimed the work. A marketplace without it
 * lets a poster read a submission and then withdraw, which is theft with extra
 * steps, and it is the failure the research on this primitive singles out
 * (arXiv 2602.19514).
 */

const url = process.env.DATABASE_URL

describe.skipIf(!url)('PostgresTaskStore', () => {
  const stores: PostgresTaskStore[] = []
  const store = () => {
    const made = new PostgresTaskStore(url as string)
    stores.push(made)
    return made
  }

  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close()))
  })

  const POSTER = `0x${'a1'.repeat(20)}`
  const WORKER = `0x${'b2'.repeat(20)}`
  const OTHER = `0x${'c3'.repeat(20)}`

  const post = (tasks: PostgresTaskStore, title = 'Check an owner claim') =>
    tasks.create({
      poster: POSTER,
      title,
      brief: 'Read the contract and say whether the owner is who the site says.',
      kind: 'verify',
      pricePoints: 1_000,
      feePoints: 25,
      totalPoints: 1_025,
      outlay: 102_500_000_000_000_000n,
    })

  it('lets exactly one person claim a task', async () => {
    const tasks = store()
    const task = await post(tasks)

    const [a, b] = await Promise.all([tasks.claim(task.id, WORKER), tasks.claim(task.id, OTHER)])

    // Two people watching a board and clicking together is the ordinary case,
    // not the edge one. A read then a write would set both of them working on
    // the same money.
    expect([a, b].filter(Boolean)).toHaveLength(1)
    const after = await tasks.get(task.id)
    expect(after?.status).toBe('CLAIMED')
    expect([WORKER.toLowerCase(), OTHER.toLowerCase()]).toContain(after?.claimedBy)
  })

  it('will not let a poster claim their own task', async () => {
    // Not a rule about fairness. A poster who claims and accepts their own work
    // moves money from their balance to their balance less a fee, which turns a
    // mandate's spend into their own pocket while the cap records paid work.
    const tasks = store()
    const task = await post(tasks)
    expect(await tasks.claim(task.id, POSTER)).toBeNull()
    expect((await tasks.get(task.id))?.status).toBe('OPEN')
  })

  it('lets only the claimant hand work in, and only once', async () => {
    const tasks = store()
    const task = await post(tasks)
    await tasks.claim(task.id, WORKER)

    expect(await tasks.submit(task.id, OTHER, 'I did it')).toBeNull()
    expect(await tasks.submit(task.id, WORKER, 'The owner address matches.')).not.toBeNull()
    // A second submission would let somebody replace what the poster is looking
    // at after they have started reading it.
    expect(await tasks.submit(task.id, WORKER, 'Actually, something else.')).toBeNull()
  })

  it('will not let the poster take the money back once somebody is working', async () => {
    const tasks = store()
    const task = await post(tasks)
    await tasks.claim(task.id, WORKER)

    expect(await tasks.advance(task.id, ['OPEN'], 'CANCELLED', 'changed my mind')).toBeNull()
    await tasks.submit(task.id, WORKER, 'Here it is.')
    expect(await tasks.advance(task.id, ['OPEN'], 'CANCELLED', 'changed my mind')).toBeNull()
    expect((await tasks.get(task.id))?.status).toBe('SUBMITTED')
  })

  it('lets only one of accepting and disputing decide', async () => {
    const tasks = store()
    const task = await post(tasks)
    await tasks.claim(task.id, WORKER)
    await tasks.submit(task.id, WORKER, 'Here it is.')

    const [accepted, disputed] = await Promise.all([
      tasks.advance(task.id, ['SUBMITTED', 'SETTLED'], 'SETTLED'),
      tasks.advance(task.id, ['SUBMITTED'], 'DISPUTED', 'not what I asked for'),
    ])
    // Both draw on one escrow. If both could win, the second payout would come
    // from somebody else's money in the same account.
    expect([accepted, disputed].filter(Boolean)).toHaveLength(1)
  })

  it('keeps the price in points and the cap amount in base units', async () => {
    // The two are the same money in different units, and the mandate reads the
    // second. Rounding between them is how a spend and the cap counting it
    // start to disagree.
    const tasks = store()
    const task = await post(tasks)
    const read = await tasks.get(task.id)
    expect(read?.totalPoints).toBe(1_025)
    expect(read?.outlay).toBe(102_500_000_000_000_000n)
  })

  it('shows open work on the board and takes it off once claimed', async () => {
    const tasks = store()
    const task = await post(tasks, `Board check ${Date.now()}`)
    expect((await tasks.open(200)).some((t) => t.id === task.id)).toBe(true)
    await tasks.claim(task.id, WORKER)
    expect((await tasks.open(200)).some((t) => t.id === task.id)).toBe(false)
    // But both sides can still find it.
    expect((await tasks.mine(WORKER, 200)).some((t) => t.id === task.id)).toBe(true)
    expect((await tasks.mine(POSTER, 200)).some((t) => t.id === task.id)).toBe(true)
  })
})

/*
 * Regression, found by a security review of the commit that introduced these
 * routes and confirmed against the database.
 *
 * Cancelling accepted CANCELLED as a source status, copied from the settlement
 * routes where re-entry is wanted. The refund transfer is idempotent by
 * reference so a second cancel moved no money and looked harmless. Releasing
 * the mandate's spend is NOT idempotent: it subtracts every time. Post a task,
 * cancel it, cancel it again and again, and the spend counter walks down to
 * zero while money spent on other tasks stays spent. The cap stops meaning
 * anything, which is an unlimited budget reached through a button that appears
 * to do nothing.
 */
describe.skipIf(!process.env.DATABASE_URL)('cancelling twice', () => {
  it('cancels once, so the cap can only be given back once', async () => {
    const tasks = new PostgresTaskStore(process.env.DATABASE_URL as string)
    const task = await tasks.create({
      poster: `0x${'d4'.repeat(20)}`,
      title: 'Cancel twice',
      brief: 'Post it and take it back, and take it back again.',
      kind: 'research',
      pricePoints: 1_000,
      feePoints: 25,
      totalPoints: 1_025,
      outlay: 102_500_000_000_000_000n,
    })

    expect(await tasks.advance(task.id, ['OPEN'], 'CANCELLED', 'took it back')).not.toBeNull()
    // The second attempt has to lose, because the route releases the cap only
    // when this returns a row.
    expect(await tasks.advance(task.id, ['OPEN'], 'CANCELLED', 'took it back again')).toBeNull()
    await tasks.close()
  })
})
