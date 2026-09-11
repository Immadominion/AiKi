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

it('refuses an unsigned mandate on a deployment that can reach a chain', async () => {
  /*
   * This used to answer `allow`, charge the cap, and submit nothing, so three
   * sends in a row read as three successes while the money never moved and the
   * lifetime cap drained. On a chain-configured deployment an unsigned mandate
   * is a refusal: there is nothing on chain holding its limits and nothing to
   * redeem.
   */
  executeMock.mockReset()
  const { jobs, job, id } = await setup(false)
  const authorization = await jobs.getAuthorization(id)
  const before = (await jobs.getAuthorization(id)).spent
  const out = await act({
    jobs,
    jobId: job.id,
    action: action(4n),
    callData: '0x',
    authorization,
    config: CONFIG,
  })
  expect(out.policy.allow).toBe(false)
  expect(out.policy.rule).toBe('unsigned')
  expect(out.policy.reason).toMatch(/has not been signed/)
  expect(executeMock).not.toHaveBeenCalled()
  // Refused before the cap is touched, so a refusal costs nothing.
  expect((await jobs.getAuthorization(id)).spent).toBe(before)
})

it('says AiKi held the limit when this deployment cannot reach a chain at all', async () => {
  // Without enforcers or an agent key there is no chain to ask, so an allowed
  // action is genuinely held by AiKi and has to be reported as itself.
  executeMock.mockReset()
  const { jobs, job, id } = await setup(false)
  const authorization = await jobs.getAuthorization(id)
  const out = await act({ jobs, jobId: job.id, action: action(4n), callData: '0x', authorization })
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

/*
 * The selector that decides the rules has to be the one the chain will run.
 *
 * A caller states a selector and supplies calldata separately. The policy engine
 * checked the stated one against the allowlist and read the destination at the
 * offset that selector implies, while the chain executed the calldata. For the
 * rules an enforcer also checks that is survivable. The destination rule has no
 * contract behind it, so declaring `transfer` and sending `transferFrom` made it
 * read the source address and call it the recipient.
 */
it('refuses calldata whose selector is not the one declared', () => {
  const transferFrom = `0x23b872dd${'0'.repeat(24)}${'aa'.repeat(20)}${'0'.repeat(24)}${'ff'.repeat(20)}${'0'.repeat(63)}1`
  expect(() =>
    parseAction({
      target: TOKEN,
      selector: '0xa9059cbb',
      asset: TOKEN,
      amount: '1',
      callData: transferFrom,
    }),
  ).toThrow(/does not match the call being sent/)
})

it('reads the destination at the offset the calldata itself implies', () => {
  const from = `0x${'aa'.repeat(20)}`
  const to = `0x${'ff'.repeat(20)}`
  const transferFrom = `0x23b872dd${'0'.repeat(24)}${from.slice(2)}${'0'.repeat(24)}${to.slice(2)}${'0'.repeat(63)}1`
  const { action } = parseAction({
    target: TOKEN,
    selector: '0x23b872dd',
    asset: TOKEN,
    amount: '1',
    callData: transferFrom,
  })
  // Argument one, the destination, not argument zero, the source.
  expect(action.recipient).toBe(to)
})

it('leaves an empty call alone, since there is no selector to disagree with', () => {
  const { action } = parseAction({
    target: TOKEN,
    selector: '0xa9059cbb',
    asset: TOKEN,
    amount: '1',
    callData: '0x',
  })
  expect(action.selector).toBe('0xa9059cbb')
  expect(action.recipient).toBeNull()
})
