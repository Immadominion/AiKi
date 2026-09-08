import { expect, it } from 'vitest'
import { type ProbeCandidate, runProbeSweep } from './sweep.js'

const candidate = (agentId: string): ProbeCandidate => ({
  agentId,
  chainId: 56,
  registry: '0x8004',
  agentUri: `https://example.test/${agentId}`,
  lastProbedAt: null,
})

it('probes every candidate and counts the observations written', async () => {
  const seen: string[] = []
  const result = await runProbeSweep(
    ['1', '2', '3'].map(candidate),
    async (c) => {
      seen.push(c.agentId)
      return 4
    },
    { concurrency: 2, budgetMs: 10_000 },
  )
  expect(seen.sort()).toEqual(['1', '2', '3'])
  expect(result).toMatchObject({ probed: 3, failed: 0, skipped: 0, observationsInserted: 12 })
})

it('keeps going when one agent is hostile or broken', async () => {
  const result = await runProbeSweep(
    ['ok1', 'bad', 'ok2'].map(candidate),
    async (c) => {
      if (c.agentId === 'bad') throw new Error('connection reset')
      return 1
    },
    { concurrency: 1, budgetMs: 10_000 },
  )
  expect(result.probed).toBe(2)
  expect(result.failed).toBe(1)
  expect(result.failures).toEqual([{ agentId: 'bad', error: 'connection reset' }])
})

it('stops at its budget and counts what it did not reach', async () => {
  let clock = 0
  const result = await runProbeSweep(
    Array.from({ length: 10 }, (_, i) => candidate(String(i))),
    async () => {
      clock += 40
      return 1
    },
    { concurrency: 1, budgetMs: 100, now: () => clock },
  )
  // Three fit inside the budget; the rest are reported as skipped, not lost.
  expect(result.probed).toBe(3)
  expect(result.skipped).toBe(7)
  expect(result.probed + result.skipped).toBe(10)
})

it('caps the failure list so a registry-wide outage cannot flood the result', async () => {
  const result = await runProbeSweep(
    Array.from({ length: 50 }, (_, i) => candidate(String(i))),
    async () => {
      throw new Error('everything is down')
    },
    { concurrency: 4, budgetMs: 10_000 },
  )
  expect(result.failed).toBe(50)
  expect(result.failures).toHaveLength(20)
})
