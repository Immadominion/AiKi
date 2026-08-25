import { expect, it } from 'vitest'
import { ReceiptService } from './service.js'

it('binds a receipt to a mandate and detects tampering', () => {
  const service = new ReceiptService()
  const receipt = service.create({
    jobId: 'j',
    mandateHash: 'm',
    actions: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
  })
  expect(service.verify(receipt)).toBe(true)
  expect(service.verify({ ...receipt, mandateHash: 'other' })).toBe(false)
})

it('derives a stable key from a seed, so receipts survive restarts', () => {
  const seed = 'ab'.repeat(32)
  const first = new ReceiptService(seed)
  const receipt = first.create({
    jobId: 'job-1',
    mandateHash: 'hash',
    actions: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
  })
  const restarted = new ReceiptService(seed)
  expect(restarted.publicKey()).toBe(first.publicKey())
  expect(restarted.verify(receipt)).toBe(true)
  expect(new ReceiptService('cd'.repeat(32)).verify(receipt)).toBe(false)
  expect(() => new ReceiptService('not-hex')).toThrow()
})
