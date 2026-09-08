import { expect, it } from 'vitest'
import type { Action, Constraint } from '../authority/policy.js'
import { JobService } from './service.js'
import { InMemoryJobStore } from './store.js'

/*
 * A person who asked to be asked gets asked.
 *
 * The hire screen offered four approval modes from the beginning and three of
 * them described something that did not exist: the choice was never sent to the
 * API, the API had no concept of approval, and the agent acted regardless.
 * Settings said of approval requests "This is the one thing we will not let you
 * silence" about a setting that reached no server.
 *
 * The runner ticks on a schedule, so a refusal here is a pause: the same action
 * comes back on the next tick, finds the answer, and goes through.
 */

const TENTH = 100_000_000_000_000_000n
const OWNER = `0x${'ab'.repeat(20)}`
const MARKET = '0xfd36e2c2a6789db23113685031d7f16329158384'
const ASSET = '0x55d398326f99059ff775485246999027b3197955'

const action = (amount: bigint): Action => ({
  target: MARKET,
  selector: '0x0e752702',
  asset: ASSET,
  amount,
  at: '2026-09-01T12:00:00.000Z',
})

const scope: Constraint[] = [
  { kind: 'contract_allowlist', value: [MARKET], tier: 'T0', label: 'Venus only' },
  { kind: 'selector_allowlist', value: ['0x0e752702'], tier: 'T0', label: 'Repay only' },
  { kind: 'asset_scope', value: [ASSET], tier: 'T0', label: 'USDT only' },
  {
    kind: 'session_total_cap',
    value: (TENTH * 100n).toString(),
    tier: 'T0',
    label: 'Plenty of room',
  },
]

const approval = (mode: string, threshold = '0'): Constraint => ({
  kind: 'approval',
  value: { mode, threshold },
  tier: 'T2',
  label: 'Ask me',
})

async function jobUnder(constraints: Constraint[]) {
  const store = new InMemoryJobStore()
  const jobs = new JobService(store)
  const auth = await jobs.authorize(constraints, OWNER)
  const job = await jobs.createJob(auth.id, `key-${auth.id}`)
  return { jobs, job, auth }
}

it('pauses an action the mandate says to ask about, and spends nothing', async () => {
  const { jobs, job, auth } = await jobUnder([...scope, approval('approve_every')])

  const first = await jobs.attempt(job.id, action(TENTH), 'Health factor fell below 1.2.')
  expect(first.allow).toBe(false)
  expect(first.rule).toBe('approval_required')
  // Paused, not spent. A watch that asks every minute must not eat its own cap
  // while it waits for somebody to look at their phone.
  expect((await jobs.getAuthorization(auth.id)).spent).toBe(0n)

  const waiting = await jobs.approvals(job.id)
  expect(waiting).toHaveLength(1)
  // Enough of the action to decide on. A request that says "the agent wants to
  // do something" is not an approval, it is a dare.
  expect(waiting[0]?.amount).toBe(TENTH)
  expect(waiting[0]?.reason).toBe('Health factor fell below 1.2.')
})

it('asks the same question once, however many times the agent ticks', async () => {
  const { jobs, job } = await jobUnder([...scope, approval('approve_every')])

  for (let tick = 0; tick < 5; tick++) await jobs.attempt(job.id, action(TENTH))

  // Five ticks, one question. Sixty an hour would train somebody to ignore all
  // of them, which is a worse failure than not asking at all.
  expect(await jobs.approvals(job.id)).toHaveLength(1)
})

it('goes through on the next tick once somebody says yes', async () => {
  const { jobs, job, auth } = await jobUnder([...scope, approval('approve_every')])

  await jobs.attempt(job.id, action(TENTH))
  const [waiting] = await jobs.approvals(job.id)
  await jobs.decideApproval(waiting?.id as string, 'approved')

  const second = await jobs.attempt(job.id, action(TENTH))
  expect(second.allow).toBe(true)
  expect((await jobs.getAuthorization(auth.id)).spent).toBe(TENTH)
})

it('spends the yes, so one answer is not standing permission', async () => {
  const { jobs, job } = await jobUnder([...scope, approval('approve_every')])

  await jobs.attempt(job.id, action(TENTH))
  const [waiting] = await jobs.approvals(job.id)
  await jobs.decideApproval(waiting?.id as string, 'approved')
  expect((await jobs.attempt(job.id, action(TENTH))).allow).toBe(true)

  // The same action again is a new question. Approving one repayment is not
  // approving every repayment after it.
  const third = await jobs.attempt(job.id, action(TENTH))
  expect(third.allow).toBe(false)
  expect(third.rule).toBe('approval_required')
})

it('does not act on a declined request', async () => {
  const { jobs, job } = await jobUnder([...scope, approval('approve_every')])

  await jobs.attempt(job.id, action(TENTH))
  const [waiting] = await jobs.approvals(job.id)
  await jobs.decideApproval(waiting?.id as string, 'declined')

  const again = await jobs.attempt(job.id, action(TENTH))
  expect(again.allow).toBe(false)
  // And it asks again rather than treating a no as permanent: the next tick is
  // a new moment, and the reason for declining may have passed.
  expect(again.rule).toBe('approval_required')
})

it('lets small actions through and stops larger ones', async () => {
  const { jobs, job } = await jobUnder([
    ...scope,
    approval('approve_above_threshold', TENTH.toString()),
  ])

  // At the threshold, not over it, so it goes through.
  expect((await jobs.attempt(job.id, action(TENTH))).allow).toBe(true)

  const bigger = await jobs.attempt(job.id, action(TENTH * 2n))
  expect(bigger.allow).toBe(false)
  expect(bigger.rule).toBe('approval_required')
})

it('acts without asking when nobody asked to be asked', async () => {
  // The other two modes act immediately and differ in what is written down,
  // not in whether the action happens. Treating "tell me each time" as a gate
  // would stop agents their owners expected to keep working.
  for (const mode of ['automatic', 'notify']) {
    const { jobs, job } = await jobUnder([...scope, approval(mode)])
    expect((await jobs.attempt(job.id, action(TENTH))).allow).toBe(true)
    expect(await jobs.approvals(job.id)).toHaveLength(0)
  }
})

it('does not ask on behalf of a revoked mandate', async () => {
  // Revoked means no, not "ask somebody". Raising a request would offer a
  // person the chance to approve something the mandate already forbids.
  const { jobs, job, auth } = await jobUnder([...scope, approval('approve_every')])
  await jobs.revoke(auth.id)

  const verdict = await jobs.attempt(job.id, action(TENTH))
  expect(verdict.allow).toBe(false)
  expect(verdict.rule).toBe('authorization_status')
  expect(await jobs.approvals(job.id)).toHaveLength(0)
})
