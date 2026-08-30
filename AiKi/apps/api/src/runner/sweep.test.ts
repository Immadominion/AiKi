import { expect, it, vi } from 'vitest'
import { JobService } from '../jobs/service.js'
import { InMemoryJobStore } from '../jobs/store.js'
import type { VenusAccountSnapshot } from '../reference/venus/types.js'
import { InMemoryWatchStore, type Watch } from './store.js'
import { headroom, type SweepDeps, sweep } from './sweep.js'

vi.mock('./runner.js', () => ({ tick: vi.fn() }))
const { tick } = await import('./runner.js')
const tickMock = tick as unknown as ReturnType<typeof vi.fn>

const ACCOUNT = `0x${'aa'.repeat(20)}` as const
const TOKEN = `0x${'bb'.repeat(20)}` as const
const OWNER = `0x${'cc'.repeat(20)}` as const

const CHAIN = {
  rpcUrl: 'http://127.0.0.1:0',
  chainId: 97,
  delegationManager: `0x${'22'.repeat(20)}` as `0x${string}`,
  relayerKey: `0x${'33'.repeat(32)}` as `0x${string}`,
}

/** A snapshot the assessor will read as an untouched account. */
const EMPTY_SNAPSHOT: VenusAccountSnapshot = {
  account: ACCOUNT,
  observedAt: new Date().toISOString(),
  controllerLiquidity: 0n,
  controllerShortfall: 0n,
  markets: [],
}

async function setup(options: { signed?: boolean; cap?: string; revoked?: boolean } = {}) {
  const jobs = new JobService(new InMemoryJobStore())
  const watches = new InMemoryWatchStore()
  const constraints = options.cap
    ? [
        {
          kind: 'session_total_cap' as const,
          value: options.cap,
          tier: 'T2' as const,
          label: 'cap',
        },
      ]
    : [
        {
          kind: 'expiry' as const,
          value: new Date(Date.now() + 3_600_000).toISOString(),
          tier: 'T2' as const,
          label: 'expiry',
        },
      ]
  const authorization = await jobs.authorize(constraints, OWNER)

  if (options.signed !== false)
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
  // Revoked after the watch exists, which is the order it happens in: somebody
  // sets a guardian up and later changes their mind.
  if (options.revoked) await jobs.revoke(authorization.id)
  const watch: Watch = {
    jobId: job.id,
    authorizationId: authorization.id,
    account: ACCOUNT,
    chainId: 97,
    protocol: 'venus',
    minimumHealthFactor: '1.25',
    asset: TOKEN,
    repayTo: TOKEN,
    status: 'active',
    createdAt: new Date().toISOString(),
  }
  await watches.create(watch)

  const deps: SweepDeps = {
    jobs,
    watches,
    reader: () => ({ snapshot: async () => EMPTY_SNAPSHOT }),
    chain: () => CHAIN,
  }
  return { jobs, watches, deps, job, authorizationId: authorization.id }
}

it('will not act unattended under a mandate nobody signed', async () => {
  // The whole justification for a loop that spends money while the user sleeps
  // is that the chain is holding the limit. Without a signature it is only AiKi
  // holding it, and AiKi asking itself for permission is not a control.
  tickMock.mockReset()
  const { deps, watches, job } = await setup({ signed: false, cap: '100' })
  const report = await sweep(deps)
  expect(report.stopped).toBe(1)
  expect(report.passes[0]?.reason).toMatch(/never signed/)
  expect(tickMock).not.toHaveBeenCalled()
  expect((await watches.get(job.id))?.status).toBe('stopped')
})

it('stops watching when the mandate is revoked', async () => {
  tickMock.mockReset()
  const { deps, watches, job } = await setup({ revoked: true, cap: '100' })
  const report = await sweep(deps)
  expect(report.passes[0]?.reason).toMatch(/revoked/i)
  expect((await watches.get(job.id))?.status).toBe('stopped')
  expect(tickMock).not.toHaveBeenCalled()
})

it('refuses to run against a mandate with no lifetime cap', async () => {
  // An unbounded budget plus an unattended loop is the combination this product
  // exists to refuse.
  tickMock.mockReset()
  const { deps } = await setup({})
  const report = await sweep(deps)
  expect(report.passes[0]?.reason).toMatch(/no lifetime cap/)
  expect(tickMock).not.toHaveBeenCalled()
})

it('passes the remaining headroom, not the whole cap', async () => {
  tickMock.mockReset()
  tickMock.mockResolvedValue({ acted: false, reason: 'Position is SAFE; nothing to do.' })
  const { deps, jobs, authorizationId, job } = await setup({ cap: '100' })
  await jobs.attempt(job.id, {
    target: TOKEN,
    selector: '0xa9059cbb',
    asset: TOKEN,
    amount: 30n,
    at: new Date().toISOString(),
  })
  await sweep(deps)
  expect(tickMock.mock.calls[0]?.[0].state.remaining).toBe(70n)
  expect(headroom(await jobs.getAuthorization(authorizationId))).toBe(70n)
})

it('records the last action time only when it acted', async () => {
  // A quiet pass that stamped the action time would push the cooldown forward
  // every five minutes, and the agent would never repay anything again.
  tickMock.mockReset()
  tickMock.mockResolvedValue({ acted: false, reason: 'Position is SAFE; nothing to do.' })
  const { deps, watches, job } = await setup({ cap: '100' })
  await sweep(deps)
  const after = await watches.get(job.id)
  expect(after?.lastCheckedAt).toBeTruthy()
  expect(after?.lastActedAt).toBeUndefined()
  expect(after?.lastReason).toMatch(/SAFE/)
})

it('one broken watch does not end the sweep', async () => {
  tickMock.mockReset()
  tickMock.mockResolvedValue({ acted: false, reason: 'Position is SAFE; nothing to do.' })
  const first = await setup({ cap: '100' })
  // A second watch on the same stores, whose reader throws.
  const second = await setup({ cap: '100' })
  const deps: SweepDeps = {
    ...first.deps,
    jobs: first.jobs,
    watches: first.watches,
    reader: () => ({
      snapshot: async () => {
        throw new Error('RPC unreachable')
      },
    }),
  }
  const report = await sweep(deps)
  expect(report.looked).toBe(1)
  expect(report.passes[0]?.reason).toMatch(/RPC unreachable/)
  expect(second.job.id).toBeTruthy()
})

it('does not look at the same watch twice in one interval', async () => {
  tickMock.mockReset()
  tickMock.mockResolvedValue({ acted: false, reason: 'Position is SAFE; nothing to do.' })
  const { deps } = await setup({ cap: '100' })
  expect((await sweep(deps)).looked).toBe(1)
  // Immediately again: the claim in the first pass must hold it back.
  expect((await sweep(deps)).looked).toBe(0)
})

it('claims a watch so a second scheduler cannot take it', async () => {
  const watches = new InMemoryWatchStore()
  await watches.create({
    jobId: 'j1',
    authorizationId: 'a1',
    account: ACCOUNT,
    chainId: 97,
    protocol: 'venus',
    minimumHealthFactor: '1.25',
    asset: TOKEN,
    repayTo: TOKEN,
    status: 'active',
    createdAt: new Date().toISOString(),
  })
  const now = new Date()
  const [mine, theirs] = await Promise.all([
    watches.claimDue(now, 60_000, 10),
    watches.claimDue(now, 60_000, 10),
  ])
  // Exactly one of the two passes may end up repaying the shortfall.
  expect(mine.length + theirs.length).toBe(1)
})
