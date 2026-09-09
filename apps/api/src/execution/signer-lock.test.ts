import { beforeEach, expect, it, vi } from 'vitest'
import { executorAddress } from '../config/executor-identity.js'
import { JobService } from '../jobs/service.js'
import { InMemoryJobStore } from '../jobs/store.js'
import { WAD } from '../reference/venus/types.js'
import { InMemoryWatchStore } from '../runner/store.js'
import { sweep } from '../runner/sweep.js'
import { executeJobAction } from './job-execution.js'

vi.mock('./executor.js', async (original) => ({
  ...(await original<typeof import('./executor.js')>()),
  execute: vi.fn(),
}))
const { execute } = await import('./executor.js')
const send = vi.mocked(execute)
const key = `0x${'00'.repeat(31)}01` as const
const sender = executorAddress(key)
const otherSender = `0x${'22'.repeat(20)}` as const
const address = `0x${'11'.repeat(20)}` as const
const hash = `0x${'ab'.repeat(32)}` as const

beforeEach(() => {
  send.mockReset()
})

async function fixture() {
  const store = new InMemoryJobStore()
  const jobs = new JobService(store)
  const makeJob = async () => {
    const authorization = await jobs.authorize(
      [{ kind: 'session_total_cap', label: 'cap', value: '100', tier: 'T2' }],
      address,
    )
    return jobs.createJob(authorization.id, crypto.randomUUID())
  }
  const first = await makeJob()
  const second = await makeJob()
  return { store, jobs, first, second }
}

it('permits only one claim for different authorizations using the same chain and signer', async () => {
  const h = await fixture()
  const claims = await Promise.all([
    h.jobs.beginExecution(h.first.id, 56, sender),
    new JobService(h.store).beginExecution(
      h.second.id,
      56,
      sender.toUpperCase().replace('0X', '0x'),
    ),
  ])
  expect(claims.filter((claim) => claim.acquired)).toHaveLength(1)
  expect(claims.find((claim) => !claim.acquired)?.scope).toBe('executor')
})

it.each(['signer', 'chain'])(
  'permits an independent execution %s without serializing unrelated work',
  async (kind) => {
    const h = await fixture()
    await h.jobs.beginExecution(h.first.id, 56, sender)
    expect(
      (
        await h.jobs.beginExecution(
          h.second.id,
          kind === 'chain' ? 97 : 56,
          kind === 'signer' ? otherSender : sender,
        )
      ).acquired,
    ).toBe(true)
  },
)

it('retains shared-signer contention after uncertainty and service restart', async () => {
  const h = await fixture()
  const claim = await h.jobs.beginExecution(h.first.id, 56, sender)
  await h.jobs.recordExecutionHash(claim.attempt.id, hash)
  await h.jobs.finishExecution(claim.attempt.id, 'UNCONFIRMED')
  const restart = new JobService(h.store)
  expect(await restart.beginExecution(h.second.id, 56, sender)).toMatchObject({
    acquired: false,
    scope: 'executor',
    attempt: { transactionHash: hash, executorAddress: sender.toLowerCase() },
  })
})

it('blocks sender-aware claims behind legacy unknown-sender attempts on that chain', async () => {
  const h = await fixture()
  await h.jobs.beginExecution(h.first.id, 56)
  expect((await h.jobs.beginExecution(h.second.id, 56, sender)).acquired).toBe(false)
  expect((await h.jobs.beginExecution(h.second.id, 97, sender)).acquired).toBe(true)
})

it('does not let a new unknown-sender claim bypass an existing sender lock', async () => {
  const h = await fixture()
  await h.jobs.beginExecution(h.first.id, 56, sender)
  expect((await h.jobs.beginExecution(h.second.id, 56)).acquired).toBe(false)
})

it.each(['REFUSED', 'REVERTED', 'LANDED'] as const)(
  'frees the signer lock only on terminal %s',
  async (state) => {
    const h = await fixture()
    const claim = await h.jobs.beginExecution(h.first.id, 56, sender)
    await h.jobs.finishExecution(claim.attempt.id, state)
    expect((await h.jobs.beginExecution(h.second.id, 56, sender)).acquired).toBe(true)
  },
)

it('defers another mandate without leaking its hash or charging the waiting mandate', async () => {
  const h = await fixture()
  const request = {
    rpcUrl: 'http://127.0.0.1:1',
    chainId: 56,
    delegationManager: address,
    relayerKey: key,
    delegation: {
      delegate: sender,
      delegator: address,
      authority: `0x${'ff'.repeat(32)}` as const,
      caveats: [],
      salt: 0n,
      epoch: 0n,
      signature: '0x' as const,
    },
    action: {
      target: address,
      selector: '0xa9059cbb',
      asset: address,
      amount: 4n,
      at: new Date().toISOString(),
    },
    callData: '0x' as const,
  }
  send.mockImplementation(async (input) => {
    await input.onPrepared?.(hash)
    return { status: 'unconfirmed', transactionHash: hash, gasUsed: 0n }
  })
  await executeJobAction({ jobs: h.jobs, jobId: h.first.id, request })
  const waiting = await executeJobAction({ jobs: h.jobs, jobId: h.second.id, request })
  expect(waiting).toMatchObject({
    inFlight: true,
    policy: { allow: false, rule: 'executor_pending' },
  })
  expect(waiting.outcome?.transactionHash).toBeUndefined()
  expect(waiting.policy.reason).not.toContain(hash)
  expect(send).toHaveBeenCalledOnce()
  expect((await h.jobs.getAuthorization(h.first.authorizationId)).spent).toBe(4n)
  expect((await h.jobs.getAuthorization(h.second.authorizationId)).spent).toBe(0n)
})

it.each(['SUBMITTED', 'UNCONFIRMED'] as const)(
  'keeps a different mandate watch scheduled behind a %s signer lock, then runs after finalization',
  async (state) => {
    const h = await fixture()
    const claim = await h.jobs.beginExecution(h.first.id, 56, sender)
    await h.jobs.recordExecutionHash(claim.attempt.id, hash)
    if (state === 'UNCONFIRMED') await h.jobs.finishExecution(claim.attempt.id, state)
    await h.jobs.attachDelegation(h.second.authorizationId, {
      chainId: 56,
      delegation: {
        delegate: sender,
        delegator: address,
        authority: `0x${'ff'.repeat(32)}`,
        caveats: [],
        salt: '0',
        epoch: '0',
        signature: '0x',
      },
    })
    const watches = new InMemoryWatchStore()
    const now = Date.now()
    await watches.create({
      jobId: h.second.id,
      authorizationId: h.second.authorizationId,
      account: address,
      chainId: 56,
      protocol: 'venus',
      minimumHealthFactor: '1.25',
      asset: address,
      market: address,
      status: 'active',
      createdAt: new Date(now).toISOString(),
    })
    const deps = {
      jobs: h.jobs,
      watches,
      reader: () => ({
        snapshot: async () => ({
          account: address,
          observedAt: new Date(now).toISOString(),
          controllerLiquidity: 0n,
          controllerShortfall: 0n,
          markets: [
            {
              vToken: address,
              collateralFactor: (8n * WAD) / 10n,
              liquidationThreshold: (8n * WAD) / 10n,
              vTokenBalance: 125n * WAD,
              borrowBalance: 100n * WAD,
              exchangeRate: WAD,
              underlyingPrice: WAD,
            },
          ],
        }),
        underlying: async () => address,
      }),
      chain: () => ({
        rpcUrl: 'http://127.0.0.1:1',
        chainId: 56,
        delegationManager: address,
        relayerKey: key,
      }),
      verifyMandate: async () => ({ ready: true as const }),
      now: () => now,
    }
    const report = await sweep(deps)
    expect(report).toMatchObject({ looked: 1, acted: 0, stopped: 0 })
    expect(report.passes[0]?.reason).toMatch(/will wait/)
    expect(JSON.stringify(report)).not.toContain(hash)
    expect((await watches.get(h.second.id))?.status).toBe('active')
    expect((await h.jobs.getAuthorization(h.second.authorizationId)).spent).toBe(0n)
    expect(send).not.toHaveBeenCalled()
    await h.jobs.finishExecution(claim.attempt.id, 'LANDED')
    send.mockResolvedValue({ status: 'landed', transactionHash: hash, gasUsed: 1n })
    expect(await sweep({ ...deps, now: () => now + 300_001 })).toMatchObject({
      looked: 1,
      acted: 1,
      stopped: 0,
    })
    expect(send).toHaveBeenCalledOnce()
  },
)
