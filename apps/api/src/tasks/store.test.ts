import type postgres from 'postgres'
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
      workHours: 48,
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
      workHours: 48,
    })

    expect(await tasks.advance(task.id, ['OPEN'], 'CANCELLED', 'took it back')).not.toBeNull()
    // The second attempt has to lose, because the route releases the cap only
    // when this returns a row.
    expect(await tasks.advance(task.id, ['OPEN'], 'CANCELLED', 'took it back again')).toBeNull()
    await tasks.close()
  })
})

/*
 * Neither side can strand the other's money by going quiet.
 *
 * Both holes shipped in the first version of the board and both are the same
 * shape: one party stops answering and the other has no route at all.
 * Cancelling is refused from CLAIMED on purpose, so a claimant who vanished
 * locked the poster's money behind them; and a poster who never answered
 * finished work held both the work and the payment.
 *
 * Fixed with a clock, and tested by moving the clock rather than waiting.
 */
describe.skipIf(!process.env.DATABASE_URL)('deadlines', () => {
  const tasks = () => new PostgresTaskStore(process.env.DATABASE_URL as string)
  const POSTER = `0x${'e5'.repeat(20)}`
  const FIRST = `0x${'f6'.repeat(20)}`
  const SECOND = `0x${'07'.repeat(20)}`

  const post = (store: PostgresTaskStore) =>
    store.create({
      poster: POSTER,
      title: 'Deadline check',
      brief: 'Claim it and go quiet.',
      kind: 'research',
      pricePoints: 500,
      feePoints: 12,
      totalPoints: 512,
      outlay: 51_200_000_000_000_000n,
      workHours: 48,
    })

  /** Reaching past the store, because the point is what happens when time passes. */
  const age = async (store: PostgresTaskStore, id: string, column: string) => {
    const raw = (store as unknown as { sql: postgres.Sql }).sql
    await raw`UPDATE tasks SET ${raw(column)} = now() - interval '1 minute' WHERE id = ${id}`
  }

  it('puts work back on the board when its claimant runs out of time', async () => {
    const store = tasks()
    const task = await post(store)
    await store.claim(task.id, FIRST)

    // While the claim stands, nobody else can take it.
    expect(await store.claim(task.id, SECOND)).toBeNull()
    expect((await store.open(500)).some((t) => t.id === task.id)).toBe(false)

    await age(store, task.id, 'claim_expires_at')

    // Once it lapses the work is available again, with no sweep having run.
    expect((await store.open(500)).some((t) => t.id === task.id)).toBe(true)
    const takenOver = await store.claim(task.id, SECOND)
    expect(takenOver?.claimedBy).toBe(SECOND.toLowerCase())
    // And the new claimant gets a full window rather than inheriting a dead one.
    expect(new Date(takenOver?.claimExpiresAt as string).getTime()).toBeGreaterThan(Date.now())
    await store.close()
  })

  it('will not accept work from somebody whose claim has already lapsed', async () => {
    // Otherwise a claimant who lost the task could still hand in against it and
    // overwrite whatever the person who took it over is doing.
    const store = tasks()
    const task = await post(store)
    await store.claim(task.id, FIRST)
    await age(store, task.id, 'claim_expires_at')

    expect(await store.submit(task.id, FIRST, 'late')).toBeNull()
    await store.close()
  })

  it('lets the person who did the work take payment when the poster goes quiet', async () => {
    const store = tasks()
    const task = await post(store)
    await store.claim(task.id, FIRST)
    await store.submit(task.id, FIRST, 'Here is what I found.')

    // Not before the window is up.
    expect(await store.claimLapsedReview(task.id, FIRST)).toBeNull()

    await age(store, task.id, 'review_expires_at')

    // And not by anybody else, however long it has been.
    expect(await store.claimLapsedReview(task.id, SECOND)).toBeNull()
    const released = await store.claimLapsedReview(task.id, FIRST)
    expect(released?.status).toBe('SETTLED')
    expect(released?.resolution).toMatch(/did not answer in time/)
    // Once only: the payment legs run after this and must not run twice.
    expect(await store.claimLapsedReview(task.id, FIRST)).toBeNull()
    await store.close()
  })

  it('stops the clock when the poster actually answers', async () => {
    // Declining is answering. A poster who says no has engaged, and the release
    // route must not then pay out over their objection.
    const store = tasks()
    const task = await post(store)
    await store.claim(task.id, FIRST)
    await store.submit(task.id, FIRST, 'Here it is.')
    await store.advance(task.id, ['SUBMITTED'], 'DISPUTED', 'not what I asked for')
    await age(store, task.id, 'review_expires_at')

    expect(await store.claimLapsedReview(task.id, FIRST)).toBeNull()
    await store.close()
  })
})

/*
 * Hiring one named agent, which is the same board with the claimant decided in
 * advance rather than a second delivery machine beside it.
 *
 * Before this, hiring took money and paid it out and never asked the agent for
 * anything: of the states a job can be in, DISPATCHED and COMPLETED were
 * written by no code at all. The marketplace could sell something it had never
 * asked anybody to make.
 */
describe.skipIf(!process.env.DATABASE_URL)('hiring one agent', () => {
  const tasks = () => new PostgresTaskStore(process.env.DATABASE_URL as string)
  const BUYER = `0x${'11'.repeat(20)}`
  const AGENT_OWNER = `0x${'22'.repeat(20)}`
  const WATCHER = `0x${'33'.repeat(20)}`

  const hire = (store: PostgresTaskStore) =>
    store.create({
      poster: BUYER,
      title: 'Price a position',
      brief: 'Say what this is worth and how you got there.',
      kind: 'research',
      pricePoints: 900,
      feePoints: 22,
      totalPoints: 922,
      outlay: 92_200_000_000_000_000n,
      workHours: 6,
      assigned: { agentId: '315943', owner: AGENT_OWNER },
    })

  it('starts claimed by the agent, off the public board, on the clock', async () => {
    const store = tasks()
    const task = await hire(store)

    expect(task.status).toBe('CLAIMED')
    expect(task.assignedAgentId).toBe('315943')
    // Paid to the address the registry names, because an agent has no account
    // here: it is a URL in a document.
    expect(task.claimedBy).toBe(AGENT_OWNER.toLowerCase())
    expect(new Date(task.claimExpiresAt as string).getTime()).toBeGreaterThan(Date.now())
    expect((await store.open(500)).some((t) => t.id === task.id)).toBe(false)
    await store.close()
  })

  it('is not up for grabs, even after the agent runs out of time', async () => {
    // If a hired agent goes quiet the money goes back to the buyer, never to
    // whoever happened to be watching the board. They hired one thing.
    const store = tasks()
    const task = await hire(store)
    const raw = (store as unknown as { sql: postgres.Sql }).sql
    await raw`UPDATE tasks SET claim_expires_at = now() - interval '1 minute' WHERE id = ${task.id}`

    expect(await store.claim(task.id, WATCHER)).toBeNull()
    expect((await store.open(500)).some((t) => t.id === task.id)).toBe(false)
    // The buyer's route out, and the only one assigned work has.
    expect(await store.cancelLapsedClaim(task.id, WATCHER)).toBeNull()
    const back = await store.cancelLapsedClaim(task.id, BUYER)
    expect(back?.status).toBe('CANCELLED')
    await store.close()
  })

  it('takes work only from the agent it was given to, and only in time', async () => {
    const store = tasks()
    const task = await hire(store)

    expect(await store.recordDelivery(task.id, '999999', 'not me')).toBeNull()
    const delivered = await store.recordDelivery(task.id, '315943', 'It is worth 12 USDT because…')
    expect(delivered?.status).toBe('SUBMITTED')
    // And the review clock starts, so the buyer cannot sit on a delivered answer.
    expect(new Date(delivered?.reviewExpiresAt as string).getTime()).toBeGreaterThan(Date.now())
    await store.close()
  })

  it('refuses work that arrives after the deadline', async () => {
    // By then the buyer may already have taken the money back, and paying for
    // an answer nobody is waiting for any more is paying twice.
    const store = tasks()
    const task = await hire(store)
    const raw = (store as unknown as { sql: postgres.Sql }).sql
    await raw`UPDATE tasks SET claim_expires_at = now() - interval '1 minute' WHERE id = ${task.id}`

    expect(await store.recordDelivery(task.id, '315943', 'late')).toBeNull()
    await store.close()
  })
})
