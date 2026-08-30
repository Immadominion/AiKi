import { expect, it, vi } from 'vitest'
import { act, parseAction } from './act.js'
import { JobService } from './service.js'
import { InMemoryJobStore } from './store.js'

vi.mock('../execution/executor.js', () => ({
  execute: vi.fn(),
}))
const { execute } = await import('../execution/executor.js')
const executeMock = execute as unknown as ReturnType<typeof vi.fn>

const TOKEN = `0x${'11'.repeat(20)}` as const
const OWNER = `0x${'ab'.repeat(20)}` as const
const CONFIG = {
  rpcUrl: 'http://127.0.0.1:0',
  chainId: 97,
  manager: `0x${'22'.repeat(20)}` as `0x${string}`,
  agentKey: `0x${'33'.repeat(32)}` as `0x${string}`,
}

/** A mandate allowing up to 10 in total, and a job under it. */
async function setup(signed: boolean) {
  const store = new InMemoryJobStore()
  const jobs = new JobService(store)
  const authorization = await jobs.authorize(
    [{ kind: 'session_total_cap', value: '10', tier: 'T2', label: '10 in total' }],
    OWNER,
  )
  if (signed)
    await store.attachDelegation(
      authorization.id,
      {
        delegate: `0x${'44'.repeat(20)}`,
        delegator: `0x${'55'.repeat(20)}`,
        authority: `0x${'ff'.repeat(32)}`,
        caveats: [],
        salt: '1',
        epoch: '0',
        signature: `0x${'66'.repeat(65)}`,
      },
      `0x${'55'.repeat(20)}`,
      97,
      new Date().toISOString(),
    )
  const job = await jobs.createJob(authorization.id, `k-${Math.random()}`)
  return { jobs, store, job, id: authorization.id }
}

const action = (amount: bigint) => ({
  target: TOKEN,
  selector: '0xa9059cbb',
  asset: TOKEN,
  amount,
  at: new Date().toISOString(),
})

it('never reaches a chain when the mandate already refused', async () => {
  executeMock.mockReset()
  const { jobs, job, id } = await setup(true)
  const authorization = await jobs.getAuthorization(id)
  // Over the cap, so the off-chain engine says no. Submitting anyway would spend
  // gas to be told something we already knew.
  const out = await act({
    jobs,
    jobId: job.id,
    action: action(99n),
    callData: '0x',
    authorization,
    config: CONFIG,
  })
  expect(out.policy.allow).toBe(false)
  expect(out.chain).toBeUndefined()
  expect(executeMock).not.toHaveBeenCalled()
})

it('gives back the cap when the chain refuses what the mandate allowed', async () => {
  // The case the whole product is about: the two engines disagreed and the chain
  // won. If the charge stood, every later action would be measured against money
  // that never moved.
  executeMock.mockReset()
  executeMock.mockResolvedValue({
    status: 'reverted',
    transactionHash: `0x${'ee'.repeat(32)}`,
    revertReason: 'PolicyDenied(per_action_cap)',
  })
  const { jobs, job, id } = await setup(true)
  const authorization = await jobs.getAuthorization(id)
  const out = await act({
    jobs,
    jobId: job.id,
    action: action(4n),
    callData: '0x',
    authorization,
    config: CONFIG,
  })
  expect(out.policy.allow).toBe(true)
  expect(out.chain?.status).toBe('reverted')
  expect(out.chain?.revertReason).toMatch(/PolicyDenied/)
  expect(out.heldBy).toBe('chain')
  expect((await jobs.getAuthorization(id)).spent).toBe(0n)
})

it('keeps the charge when the chain lands it', async () => {
  executeMock.mockReset()
  executeMock.mockResolvedValue({ status: 'landed', transactionHash: `0x${'dd'.repeat(32)}` })
  const { jobs, job, id } = await setup(true)
  const authorization = await jobs.getAuthorization(id)
  const out = await act({
    jobs,
    jobId: job.id,
    action: action(4n),
    callData: '0x',
    authorization,
    config: CONFIG,
  })
  expect(out.chain?.status).toBe('landed')
  expect((await jobs.getAuthorization(id)).spent).toBe(4n)
})

it('records the refusal against the job, not only the success', async () => {
  executeMock.mockReset()
  executeMock.mockResolvedValue({
    status: 'reverted',
    transactionHash: `0x${'ee'.repeat(32)}`,
    revertReason: 'PolicyDenied(session_total_cap)',
  })
  const { jobs, job, id } = await setup(true)
  const authorization = await jobs.getAuthorization(id)
  await act({
    jobs,
    jobId: job.id,
    action: action(4n),
    callData: '0x',
    authorization,
    config: CONFIG,
  })
  const events = (await jobs.getJob(job.id)).events
  expect(events.some((e) => e.detail.includes('chain refused'))).toBe(true)
})

it('says AiKi held the limit when nothing was ever signed', async () => {
  // An unsigned mandate is a real mandate; the difference is who enforces it,
  // and claiming the chain did would be the one lie this product cannot tell.
  executeMock.mockReset()
  const { jobs, job, id } = await setup(false)
  const authorization = await jobs.getAuthorization(id)
  const out = await act({
    jobs,
    jobId: job.id,
    action: action(4n),
    callData: '0x',
    authorization,
    config: CONFIG,
  })
  expect(out.policy.allow).toBe(true)
  expect(out.heldBy).toBe('aiki')
  expect(executeMock).not.toHaveBeenCalled()
})

it('refuses an action it cannot read', () => {
  expect(() => parseAction({ target: 'not-an-address' })).toThrow(/0x-prefixed 20-byte/)
  expect(() =>
    parseAction({ target: TOKEN, selector: '0xa9059cbb', asset: TOKEN, amount: 'lots' }),
  ).toThrow(/whole number/)
  expect(() =>
    parseAction({
      target: TOKEN,
      selector: '0xa9059cbb',
      asset: TOKEN,
      amount: '-1',
      callData: '0x',
    }),
  ).toThrow(/negative/)
})

it('does not cite a transaction that was never sent', async () => {
  // The node declining to accept a transaction and a transaction landing in a
  // block and reverting are different events. One cost gas and can be linked to;
  // the other never existed. Reporting a hash of '0x' for the second invites
  // somebody to go looking for evidence that is not there.
  executeMock.mockReset()
  executeMock.mockResolvedValue({
    status: 'refused',
    gasUsed: 0n,
    revertReason: 'execution reverted',
  })
  const { jobs, job, id } = await setup(true)
  const authorization = await jobs.getAuthorization(id)
  const out = await act({
    jobs,
    jobId: job.id,
    action: action(4n),
    callData: '0x',
    authorization,
    config: CONFIG,
  })
  expect(out.chain?.status).toBe('refused')
  expect(out.chain?.transactionHash).toBeUndefined()
  // Still a refusal, so the cap is still given back.
  expect((await jobs.getAuthorization(id)).spent).toBe(0n)
  const events = (await jobs.getJob(job.id)).events
  expect(events.some((e) => e.detail.includes('would not accept'))).toBe(true)
})
