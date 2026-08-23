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
