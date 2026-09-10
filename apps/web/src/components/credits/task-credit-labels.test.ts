import assert from 'node:assert/strict'
import test from 'node:test'
import { creditEntryLabel } from './credits'

test('task reservations, earnings and refunds have explicit point activity labels', () => {
  assert.equal(creditEntryLabel('task_funding', -41), 'Work payment reserved')
  assert.equal(creditEntryLabel('task_earnings', 40), 'Work earnings')
  assert.equal(creditEntryLabel('task_refund', 41), 'Work refund')
})

test('task and legacy job payment events use the same customer-facing language', () => {
  for (const [suffix, delta] of [
    ['funding', -41],
    ['earnings', 40],
    ['refund', 41],
  ] as const)
    assert.equal(
      creditEntryLabel(`task_${suffix}`, delta),
      creditEntryLabel(`job_${suffix}`, delta),
    )
  assert.equal(creditEntryLabel('platform_fee', 1), 'Marketplace fee')
  assert.equal(creditEntryLabel('unknown_reason', 1), 'Points adjustment')
})
