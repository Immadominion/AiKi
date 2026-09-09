import { beforeEach, expect, it, vi } from 'vitest'
import { act } from './act.js'
import { JobService } from './service.js'
import { InMemoryJobStore } from './store.js'

vi.mock('../execution/executor.js', () => ({ execute: vi.fn() }))
const { execute } = await import('../execution/executor.js')
const send = vi.mocked(execute)
const hash = `0x${'ab'.repeat(32)}` as const
const account = `0x${'11'.repeat(20)}` as const
const config = {
  rpcUrl: 'http://127.0.0.1:1',
  chainId: 56,
  manager: account,
  agentKey: `0x${'00'.repeat(31)}01` as const,
}
beforeEach(() => {
  send.mockReset()
})

async function setup() {
  const store = new InMemoryJobStore()
  const jobs = new JobService(store)
  let authorization = await jobs.authorize(
    [{ kind: 'session_total_cap', label: 'cap', value: '100', tier: 'T2' }],
    account,
  )
  authorization = await jobs.attachDelegation(authorization.id, {
    chainId: 56,
    delegation: {
      delegate: account,
      delegator: account,
      authority: `0x${'ff'.repeat(32)}`,
      caveats: [],
      salt: '0',
      epoch: '0',
      signature: '0x',
    },
  })
  const job = await jobs.createJob(authorization.id, crypto.randomUUID())
  const action = {
    target: account,
    selector: '0xa9059cbb',
    asset: account,
    amount: 4n,
    at: new Date().toISOString(),
  }
  const input = { jobs, jobId: job.id, action, callData: '0x' as const, authorization, config }
  return { store, jobs, authorization, job, input }
}

it('holds the cap and refuses repeat manual actions after an unknown receipt', async () => {
  send.mockImplementation(async (request) => {
    await request.onPrepared?.(hash)
    return { status: 'unconfirmed', transactionHash: hash, gasUsed: 0n }
  })
  const h = await setup()
  const result = await act(h.input)
  expect(result.chain).toMatchObject({ status: 'unconfirmed', transactionHash: hash })
  expect((await h.jobs.getAuthorization(h.authorization.id)).spent).toBe(4n)
  const restart = new JobService(h.store)
  const retry = await act({ ...h.input, jobs: restart })
  expect(retry.policy).toMatchObject({ allow: false, rule: 'execution_unconfirmed' })
  expect(retry.chain?.transactionHash).toBe(hash)
  expect(send).toHaveBeenCalledOnce()
  expect(
    (await restart.getJob(h.job.id)).events.some(
      (event) => event.detail.includes(hash) && event.detail.includes('unconfirmed'),
    ),
  ).toBe(true)
})

it('does not bypass an unresolved transaction by creating a second job under that mandate', async () => {
  send.mockResolvedValue({ status: 'unconfirmed', transactionHash: hash, gasUsed: 0n })
  const h = await setup()
  await act(h.input)
  const another = await h.jobs.createJob(h.authorization.id, crypto.randomUUID())
  const retry = await act({ ...h.input, jobId: another.id })
  expect(retry.policy.allow).toBe(false)
  expect(send).toHaveBeenCalledOnce()
  expect((await h.jobs.getAuthorization(h.authorization.id)).spent).toBe(4n)
})

it('serializes competing manual sends before either can charge or broadcast', async () => {
  const h = await setup()
  let release!: () => void
  send.mockImplementation(async (request) => {
    await request.onPrepared?.(hash)
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return { status: 'unconfirmed', transactionHash: hash, gasUsed: 0n }
  })
  const first = act(h.input)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const second = await act(h.input)
  expect(second.policy.allow).toBe(false)
  release()
  await first
  expect(send).toHaveBeenCalledOnce()
  expect((await h.jobs.getAuthorization(h.authorization.id)).spent).toBe(4n)
})

it('leaves the claim held if an adapter throws after persisting the signed hash', async () => {
  const h = await setup()
  send.mockImplementation(async (request) => {
    await request.onPrepared?.(hash)
    throw new Error('uncertain adapter')
  })
  expect((await act(h.input)).chain?.status).toBe('unconfirmed')
  expect((await h.jobs.pendingExecution(h.authorization.id))?.transactionHash).toBe(hash)
  expect((await h.jobs.getAuthorization(h.authorization.id)).spent).toBe(4n)
})

it.each(['refused', 'reverted'] as const)(
  'releases cap and permits a new action only after known %s',
  async (status) => {
    const h = await setup()
    send.mockResolvedValue({
      status,
      gasUsed: 0n,
      ...(status === 'reverted' ? { transactionHash: hash } : {}),
    })
    await act(h.input)
    expect(await h.jobs.pendingExecution(h.authorization.id)).toBeNull()
    expect((await h.jobs.getAuthorization(h.authorization.id)).spent).toBe(0n)
    await act(h.input)
    expect(send).toHaveBeenCalledTimes(2)
  },
)
