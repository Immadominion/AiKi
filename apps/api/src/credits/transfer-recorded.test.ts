import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ESCROW_ACCOUNT, InMemoryCreditStore, PostgresCreditStore } from './store.js'

for (const backend of ['memory', 'postgres'] as const) {
  describe.skipIf(backend === 'postgres' && !process.env.DATABASE_URL)(
    `${backend} committed transfer lookup`,
    () => {
      it('requires both exact ledger legs with the correct accounts, amount, reason and reference', async () => {
        const store =
          backend === 'postgres'
            ? new PostgresCreditStore(process.env.DATABASE_URL as string)
            : new InMemoryCreditStore()
        const owner = `0x${randomUUID().replaceAll('-', '')}12345678`
        const transfer = {
          from: owner,
          to: ESCROW_ACCOUNT,
          points: 512,
          reason: 'task_funding',
          reference: randomUUID(),
        }
        try {
          await store.deposit({ owner, points: 1_000, reason: 'test', reference: randomUUID() })
          expect(await store.transferRecorded(transfer)).toBe(false)
          await store.transfer(transfer)
          expect(await store.transferRecorded(transfer)).toBe(true)
          expect(await store.transferRecorded({ ...transfer, from: owner.toUpperCase() })).toBe(
            true,
          )
          for (const changed of [
            { from: 'someone else' },
            { to: 'another escrow' },
            { points: 500 },
            { reason: 'task_refund' },
            { reference: randomUUID() },
          ]) {
            expect(await store.transferRecorded({ ...transfer, ...changed })).toBe(false)
          }
        } finally {
          if (store instanceof PostgresCreditStore) await store.close()
        }
      })
    },
  )
}
