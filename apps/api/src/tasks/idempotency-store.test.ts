import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PostgresTaskStore } from './store.js'

describe.skipIf(!process.env.DATABASE_URL)('persistent task request claims', () => {
  const url = process.env.DATABASE_URL as string
  const owner = () => `0x${randomUUID().replaceAll('-', '')}12345678`
  const hash = 'a'.repeat(64)

  it('replays a completed result from a new store instance and rejects changed work', async () => {
    const wallet = owner()
    const key = randomUUID()
    const first = new PostgresTaskStore(url)
    try {
      const claim = await first.beginCreateRequest(wallet, key, hash)
      expect(claim.kind).toBe('started')
      if (claim.kind !== 'started') throw new Error('Expected a new request')
      await first.completeCreateRequest(claim.id, 201, { id: 'task-real', heldPoints: 512 })
    } finally {
      await first.close()
    }
    const restarted = new PostgresTaskStore(url)
    try {
      expect(
        await restarted.beginCreateRequest(wallet.toUpperCase().replace('0X', '0x'), key, hash),
      ).toEqual({
        kind: 'replayed',
        statusCode: 201,
        body: { id: 'task-real', heldPoints: 512 },
      })
      expect((await restarted.beginCreateRequest(wallet, key, 'b'.repeat(64))).kind).toBe(
        'conflict',
      )
    } finally {
      await restarted.close()
    }
  })

  it('allows one concurrent claimant, preserves uncertainty across restart, and scopes keys to the owner', async () => {
    const wallet = owner()
    const key = randomUUID()
    const first = new PostgresTaskStore(url)
    const second = new PostgresTaskStore(url)
    try {
      const results = await Promise.all([
        first.beginCreateRequest(wallet, key, hash),
        second.beginCreateRequest(wallet, key, hash),
      ])
      expect(results.filter((result) => result.kind === 'started')).toHaveLength(1)
      expect(results.filter((result) => result.kind === 'in_progress')).toHaveLength(1)
    } finally {
      await Promise.all([first.close(), second.close()])
    }
    const restarted = new PostgresTaskStore(url)
    try {
      expect((await restarted.beginCreateRequest(wallet, key, hash)).kind).toBe('in_progress')
      expect((await restarted.beginCreateRequest(owner(), key, hash)).kind).toBe('started')
    } finally {
      await restarted.close()
    }
  })
})
