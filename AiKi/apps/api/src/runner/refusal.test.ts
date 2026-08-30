import { expect, it, vi } from 'vitest'
import { JobService } from '../jobs/service.js'
import { InMemoryJobStore } from '../jobs/store.js'
import { tick } from './runner.js'
import type { Assessment } from './trigger.js'

vi.mock('../execution/executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../execution/executor.js')>()),
  execute: vi.fn(),
}))
const { execute } = await import('../execution/executor.js')
const executeMock = execute as unknown as ReturnType<typeof vi.fn>

const TOKEN = `0x${'bb'.repeat(20)}` as const
const OWNER = `0x${'cc'.repeat(20)}` as const

/** A position well under its minimum, so the trigger wants to repay. */
const AT_RISK: Assessment = {
  status: 'AT_RISK',
  healthFactor: '1.00',
  minimumHealthFactor: '1.25',
  adjustedCollateral: { amount: (100n * 10n ** 18n).toString() },
  borrowed: { amount: (100n * 10n ** 18n).toString() },
  consistency: { verified: true, detail: 'agrees' },
  observedAt: new Date().toISOString(),
}

async function setup() {
  const jobs = new JobService(new InMemoryJobStore())
  const authorization = await jobs.authorize(
    [
      {
        kind: 'session_total_cap',
        value: (1000n * 10n ** 18n).toString(),
        tier: 'T0',
        label: 'cap',
      },
    ],
    OWNER,
  )
  await jobs.attachDelegation(authorization.id, {
    delegation: {
      delegate: `0x${'44'.repeat(20)}`,
      delegator: `0x${'55'.repeat(20)}`,
      authority: `0x${'ff'.repeat(32)}`,
      caveats: [],
      salt: '1',
      epoch: '0',
      signature: `0x${'66'.repeat(65)}`,
    } as never,
    chainId: 97,
  })
  const job = await jobs.createJob(authorization.id, `k-${Math.random()}`)
  return { jobs, job, id: authorization.id }
}

const run = (jobs: JobService, jobId: string) =>
  tick({
    jobs,
    jobId,
    assessment: AT_RISK,
    state: { remaining: 1000n * 10n ** 18n },
    asset: TOKEN,
    market: TOKEN,
    chain: {
      rpcUrl: 'http://127.0.0.1:0',
      chainId: 97,
      delegationManager: `0x${'22'.repeat(20)}`,
      relayerKey: `0x${'33'.repeat(32)}`,
    },
    delegation: {} as never,
  })

it('gives the cap back when the chain refuses a watched repayment', async () => {
  /*
   * The bug this exists to stop: `attempt` charges the cap before the chain has
   * spoken, so a refusal leaves the counter ahead of reality. On a one-off
   * action that is a wrong number. On a loop it is worse — four failed passes
   * against a cap and the agent has spent nothing and has no room left, so it
   * quietly stops protecting the position for a reason that never happened.
   */
  executeMock.mockReset()
  executeMock.mockResolvedValue({
    status: 'reverted',
    transactionHash: `0x${'ee'.repeat(32)}`,
    revertReason: 'PolicyDenied(per_action_cap)',
  })
  const { jobs, job, id } = await setup()

  const before = (await jobs.getAuthorization(id)).spent
  const result = await run(jobs, job.id)

  expect(result.acted).toBe(false)
  expect(result.deniedBy).toBe('chain')
  expect((await jobs.getAuthorization(id)).spent).toBe(before)
})

it('does not lose headroom to repeated chain refusals', async () => {
  executeMock.mockReset()
  executeMock.mockResolvedValue({ status: 'refused', gasUsed: 0n, revertReason: 'reverted' })
  const { jobs, job, id } = await setup()
  for (let i = 0; i < 4; i++) await run(jobs, job.id)
  expect((await jobs.getAuthorization(id)).spent).toBe(0n)
})

it('records the chain refusal against the job', async () => {
  // A refusal nobody can see is indistinguishable from a watch that never ran.
  executeMock.mockReset()
  executeMock.mockResolvedValue({
    status: 'reverted',
    transactionHash: `0x${'ee'.repeat(32)}`,
    revertReason: 'PolicyDenied(session_total_cap)',
  })
  const { jobs, job } = await setup()
  await run(jobs, job.id)
  const events = (await jobs.getJob(job.id)).events
  expect(events.some((e) => e.detail.includes('chain refused'))).toBe(true)
})

it('keeps the charge when the repayment lands', async () => {
  executeMock.mockReset()
  executeMock.mockResolvedValue({ status: 'landed', transactionHash: `0x${'dd'.repeat(32)}` })
  const { jobs, job, id } = await setup()
  const result = await run(jobs, job.id)
  expect(result.acted).toBe(true)
  expect((await jobs.getAuthorization(id)).spent).toBeGreaterThan(0n)
})
