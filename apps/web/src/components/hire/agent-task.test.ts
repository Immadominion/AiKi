import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAgentTask, taskAttempt, taskPrice, taskRejectedBeforeCharge } from './agent-task'

const draft = {
  agentId: '315943',
  title: 'Read my lending position',
  brief: 'Report supplied collateral, outstanding borrowing and health factor.',
  kind: 'review',
  pricePoints: 1000,
  workHours: 24,
}

test('shows the buyer offer and exact 2.5 percent fee in points', () => {
  assert.deepEqual(taskPrice('1000', 10, 250), { offer: 1000, fee: 25, total: 1025 })
  assert.deepEqual(taskPrice('39', 10, 250), { offer: 39, fee: 0, total: 39 })
  assert.deepEqual(taskPrice('40', 10, 250), { offer: 40, fee: 1, total: 41 })
})

test('rejects invalid amounts and totals that cannot be represented safely', () => {
  for (const amount of ['', '1.5', '-1', '1e6', '1,000', '9'])
    assert.throws(() => taskPrice(amount, 10, 250))
  assert.throws(() => taskPrice(String(Number.MAX_SAFE_INTEGER), 10, 250), /too large/)
  assert.throws(() => taskPrice('1000', 10, Number.NaN), /settings/)
})

test('direct request includes the selected agent and real brief without token authority', () => {
  const request = buildAgentTask(draft)
  assert.deepEqual(request, {
    title: draft.title,
    brief: draft.brief,
    kind: 'review',
    pricePoints: 1000,
    workHours: 24,
    assignAgentId: '315943',
  })
  assert.equal('authorizationId' in request, false)
  assert.equal('hirePerson' in request, false)
})

test('wallet address is included only when explicitly selected, as public read-only context', () => {
  const address = '0x16240f6655F5f9e0A4965A27f857e59c4922255A'
  assert.equal(buildAgentTask(draft).brief.includes(address), false)
  const request = buildAgentTask({ ...draft, walletAddress: address })
  assert.equal(request.brief, `${draft.brief}\n\nWallet to read (read only): ${address}`)
  assert.throws(() => buildAgentTask({ ...draft, walletAddress: '' }), /complete 0x/)
  assert.throws(() => buildAgentTask({ ...draft, walletAddress: '0x1234' }), /complete 0x/)
})

test('prevents silently truncated briefs, invalid kinds and out-of-range deadlines', () => {
  assert.throws(() => buildAgentTask({ ...draft, brief: 'x'.repeat(2001) }), /2,000/)
  assert.throws(() => buildAgentTask({ ...draft, title: 'x'.repeat(121) }), /120/)
  assert.throws(() => buildAgentTask({ ...draft, workHours: 0 }), /delivery time/)
  assert.throws(() => buildAgentTask({ ...draft, kind: 'anything' }), /type of work/)
})

test('retries reuse their operation key and changed requests get a new key', () => {
  let sequence = 0
  const createKey = () => `request-${++sequence}`
  const original = taskAttempt(null, 'same-request', createKey)
  assert.strictEqual(taskAttempt(original, 'same-request', createKey), original)
  assert.equal(sequence, 1)
  const changed = taskAttempt(original, 'new-request', createKey)
  assert.equal(changed.key, 'request-2')
})

test('known uncharged refusals allow a new attempt after balance or availability changes', () => {
  const errors = [
    { status: 402, code: 'INSUFFICIENT_POINTS' },
    { status: 400, code: 'TASK_PRICE_TOO_LOW' },
    { status: 422, code: 'AGENT_TASK_PROTOCOL_UNSUPPORTED' },
    { status: 422, code: 'AGENT_NOT_LIVE' },
    { status: 503, code: 'DISPATCH_UNAVAILABLE' },
  ]
  for (const error of errors) {
    assert.equal(taskRejectedBeforeCharge(error), true)
    const previous = { fingerprint: 'request', key: 'previous-key' }
    const next = taskAttempt(
      taskRejectedBeforeCharge(error) ? null : previous,
      'request',
      () => 'new-key',
    )
    assert.equal(next.key, 'new-key')
  }
})

test('uncertain failures keep the operation key so retrying cannot fund another task', () => {
  const errors = [
    new TypeError('Failed to fetch'),
    new Error('Request timed out'),
    { status: 500, code: 'INTERNAL_ERROR' },
    { status: 500, code: 'INSUFFICIENT_POINTS' },
    { status: 503, code: 'UNKNOWN' },
    { status: 409, code: 'TASK_REQUEST_IN_PROGRESS' },
    { status: 409, code: 'TASK_ALREADY_FUNDED' },
    { status: 409, code: 'TASK_IDEMPOTENCY_CONFLICT' },
    { status: 422, code: 'UNKNOWN' },
    null,
  ]
  for (const error of errors) {
    assert.equal(taskRejectedBeforeCharge(error), false)
    const previous = { fingerprint: 'request', key: 'previous-key' }
    assert.strictEqual(
      taskAttempt(taskRejectedBeforeCharge(error) ? null : previous, 'request', () => 'new-key'),
      previous,
    )
  }
})
