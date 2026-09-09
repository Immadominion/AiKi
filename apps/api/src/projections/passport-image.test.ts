import { expect, it } from 'vitest'
import type { Observation } from '../evidence/types.js'
import { projectPassport } from './passport.js'

const observation = (image: unknown, day: number): Observation => ({
  id: `image-${day}`,
  subject: { type: 'agent', chainId: 56, registry: '0x8004', agentId: '43129' },
  predicate: 'erc8004.registration_resolution',
  value: { status: 'resolved', manifest: { name: 'Venus', image } },
  validAt: `2026-09-0${day}T00:00:00Z`,
  observedAt: `2026-09-0${day}T00:00:00Z`,
  recordedAt: `2026-09-0${day}T00:00:00Z`,
  source: 'test',
  method: 'test',
  evidenceClass: 'B',
  dedupeKey: `image-${day}`,
})
it('preserves artwork from the newest registration without changing proof', () => {
  const passport = projectPassport('43129', [
    observation('https://example.com/old.png', 1),
    observation('ipfs://bafy-new/avatar.png', 2),
  ])
  expect(passport.image).toBe('ipfs://bafy-new/avatar.png')
  expect(passport.checks.trials).toBe(0)
  expect(passport.components.outcomeQuality).toBeNull()
})
it('does not project malformed or unbounded artwork', () => {
  expect(projectPassport('43129', [observation({ url: 'bad' }, 1)]).image).toBeNull()
  expect(projectPassport('43129', [observation('x'.repeat(2049), 1)]).image).toBeNull()
})
