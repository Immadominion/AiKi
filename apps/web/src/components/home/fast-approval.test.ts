import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountTokensFor } from '@aiki/contracts/guardian'
import {
  approvalContinuations,
  FastApprovalController,
  type FastApprovalDependencies,
} from './fast-approval'

/**
 * Answering the agent from the chat it asked in.
 *
 * The thing under test is mostly what this control refuses to take on trust.
 * The amount it shows is read back from the API rather than taken from the step
 * that produced the control, and nothing here ever says the money moved.
 */

const JOB = '11111111-1111-4111-8111-111111111111'
const ID = '22222222-2222-4222-8222-222222222222'
const TO = `0x${'aa'.repeat(20)}`
const USDT = accountTokensFor(56).find((token) => token.symbol === 'USDT')?.address ?? ''

const pending = (over: Record<string, unknown> = {}) => ({
  id: ID,
  target: USDT,
  selector: '0xa9059cbb',
  asset: USDT,
  amount: '2500000000000000000',
  recipient: TO,
  reason: 'Paying the invoice you named.',
  status: 'pending' as const,
  requestedAt: new Date().toISOString(),
  ...over,
})

function harness(over: Partial<FastApprovalDependencies> = {}) {
  const decided: string[] = []
  const deps: FastApprovalDependencies = {
    approvals: async () => ({ jobId: JOB, approvals: [pending()] }),
    decide: async (_job: string, _id: string, decision: string) => {
      decided.push(decision)
      return { id: ID, status: decision, amount: '2500000000000000000' }
    },
    ...over,
  }
  return {
    decided,
    controller: new FastApprovalController(
      { kind: 'answer_approval', jobId: JOB, approvalId: ID, chainId: 56 },
      deps,
    ),
  }
}

test('shows the amount the API says is waiting, at the token’s own decimals', async () => {
  const { controller } = harness()
  await controller.load()
  const { phase, waiting } = controller.getSnapshot()
  assert.equal(phase, 'waiting')
  assert.equal(waiting?.amount, '2.5')
  assert.equal(waiting?.symbol, 'USDT')
  assert.equal(waiting?.recipient, TO)
})

test('shows base units and the address for a token this network has not reviewed', async () => {
  // Guessing eighteen decimals for somebody else's token is how a screen shows
  // a thousandth of what is actually being agreed to.
  const asset = `0x${'cc'.repeat(20)}`
  const { controller } = harness({
    approvals: async () => ({ jobId: JOB, approvals: [pending({ asset, amount: '4200' })] }),
  })
  await controller.load()
  const { waiting } = controller.getSnapshot()
  assert.equal(waiting?.amount, '4200')
  assert.equal(waiting?.symbol, null)
  assert.equal(waiting?.asset, asset)
})

test('records an answer and never says the money moved', async () => {
  const { controller, decided } = harness()
  await controller.load()
  await controller.answer('approved')
  assert.deepEqual(decided, ['approved'])
  assert.equal(controller.getSnapshot().phase, 'approved')
})

test('a decline is an answer too, and reaches the API as one', async () => {
  const { controller, decided } = harness()
  await controller.load()
  await controller.answer('declined')
  assert.deepEqual(decided, ['declined'])
  assert.equal(controller.getSnapshot().phase, 'declined')
})

test('offers no buttons for a request that was already answered elsewhere', async () => {
  // The job screen shows the same request. Two controls over one decision have
  // to agree rather than both insist.
  const { controller, decided } = harness({
    approvals: async () => ({ jobId: JOB, approvals: [pending({ status: 'used' })] }),
  })
  await controller.load()
  assert.equal(controller.getSnapshot().phase, 'gone')
  await controller.answer('approved')
  assert.deepEqual(decided, [])
})

test('does not answer a request the job does not have', async () => {
  const { controller, decided } = harness({
    approvals: async () => ({ jobId: JOB, approvals: [] }),
  })
  await controller.load()
  assert.equal(controller.getSnapshot().phase, 'gone')
  await controller.answer('approved')
  assert.deepEqual(decided, [])
})

test('keeps the request answerable when the answer itself fails', async () => {
  const { controller } = harness({
    decide: async () => {
      throw new Error('Network request failed.')
    },
  })
  await controller.load()
  await controller.answer('approved')
  const { phase, error } = controller.getSnapshot()
  assert.equal(phase, 'waiting')
  assert.match(String(error), /Nothing has moved|did not go through/)
})

test('reads the control out of a send that paused, and only out of that', async () => {
  const action = { kind: 'answer_approval', jobId: JOB, approvalId: ID, chainId: 56 }
  assert.equal(approvalContinuations([{ tool: 'send_token', ok: true, action }]).length, 1)
  // Another tool's step must not be able to put an approve button on the screen.
  assert.equal(approvalContinuations([{ tool: 'hire', ok: true, action }]).length, 0)
  assert.equal(approvalContinuations([{ tool: 'send_token', ok: false, action }]).length, 0)
  assert.equal(
    approvalContinuations([{ tool: 'send_token', ok: true, action: { ...action, jobId: 'no' } }])
      .length,
    0,
  )
})

test('shows one control per waiting action, however often a step repeats it', async () => {
  const action = { kind: 'answer_approval', jobId: JOB, approvalId: ID, chainId: 56 }
  assert.equal(
    approvalContinuations([
      { tool: 'send_token', ok: true, action },
      { tool: 'send_token', ok: true, action },
    ]).length,
    1,
  )
})

test('reports a read it could not make without claiming anything about the money', async () => {
  const { controller } = harness({
    approvals: async () => {
      throw new Error('offline')
    },
  })
  await controller.load()
  const { phase, error } = controller.getSnapshot()
  assert.equal(phase, 'idle')
  assert.match(String(error), /Nothing has moved/)
})
