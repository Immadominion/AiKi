import { AGENT_BG, AGENT_BY_KEY, type AgentKey } from '@/lib/agents'

import {
  type ActivityEvent,
  EMPTY,
  type Hire,
  type Job,
  type MockState,
  type Receipt,
} from './types'

/**
 * The demo dataset.
 *
 * Two agents working, one paused, a week of history including the refusal and
 * the approval still waiting. This is what the design was drawn against, so
 * seeding it puts the app back into the state every screenshot shows.
 *
 * Timestamps are relative to when you seed, so "2 minutes ago" stays true
 * instead of drifting into last August.
 */
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

const ev = (
  id: string,
  minutesAgo: number,
  key: AgentKey,
  where: string,
  what: string,
  costCents: number,
  result: ActivityEvent['result'],
  extra: Partial<ActivityEvent> = {},
): ActivityEvent => ({ id, at: iso(minutesAgo), key, where, what, costCents, result, ...extra })

export function demoState(): MockState {
  const hires: Hire[] = [
    {
      key: 'guardian',
      name: AGENT_BY_KEY['guardian']?.name ?? 'guardian',
      initial: AGENT_BY_KEY['guardian']?.initial ?? '?',
      bg: AGENT_BG['guardian'] ?? '#171715',
      hiredAt: iso(60 * 24 * 12),
      status: 'working',
      mandate: {
        perActionCents: 8000,
        capCents: 25000,
        period: 'per_month',
        expiresAt: new Date(Date.now() + 39 * 86_400_000).toISOString(),
        approval: 'approve_above_threshold',
      },
      spentCents: 1420,
      jobId: 'job_01',
    },
    {
      key: 'gridly',
      name: AGENT_BY_KEY['gridly']?.name ?? 'gridly',
      initial: AGENT_BY_KEY['gridly']?.initial ?? '?',
      bg: AGENT_BG['gridly'] ?? '#171715',
      hiredAt: iso(60 * 24 * 5),
      status: 'working',
      mandate: {
        perActionCents: 4000,
        capCents: 12000,
        period: 'per_month',
        expiresAt: new Date(Date.now() + 51 * 86_400_000).toISOString(),
        approval: 'notify',
      },
      spentCents: 3180,
      jobId: 'job_02',
    },
    {
      key: 'sentinel',
      name: AGENT_BY_KEY['sentinel']?.name ?? 'sentinel',
      initial: AGENT_BY_KEY['sentinel']?.initial ?? '?',
      bg: AGENT_BG['sentinel'] ?? '#171715',
      hiredAt: iso(60 * 24 * 9),
      status: 'paused',
      mandate: {
        perActionCents: 0,
        capCents: 4000,
        period: 'per_month',
        expiresAt: new Date(Date.now() + 73 * 86_400_000).toISOString(),
        approval: 'notify',
      },
      spentCents: 0,
      jobId: 'job_03',
    },
  ]

  const jobs: Job[] = [
    {
      id: 'job_01',
      key: 'guardian',
      title: 'Protecting your Venus loan',
      status: 'WAITING',
      step: 5,
      createdAt: iso(322),
      updatedAt: iso(318),
      blockedOnce: true,
      approval: {
        id: 'apr_01',
        prompt: 'Two repayments in a row will take today past $120. Go ahead?',
        amountCents: 9120,
        expiresAt: new Date(Date.now() + 11 * 60_000).toISOString(),
      },
    },
    {
      id: 'job_02',
      key: 'gridly',
      title: 'Managing BNB / USDT',
      status: 'RUNNING',
      step: 2,
      createdAt: iso(190),
      updatedAt: iso(18),
      blockedOnce: false,
    },
    {
      id: 'job_03',
      key: 'sentinel',
      title: 'Watching your Venus position',
      status: 'PAUSED',
      step: 1,
      createdAt: iso(60 * 24 * 3),
      updatedAt: iso(60 * 24 * 3),
      blockedOnce: false,
    },
  ]

  const events: ActivityEvent[] = [
    ev('e1', 322, 'guardian', 'Venus', 'Repaid 72 USDT. Health factor 1.22 → 1.47', 6, 'Done', {
      jobId: 'job_01',
    }),
    ev(
      'e2',
      320,
      'guardian',
      'Venus',
      'Tried to spend 91.20 USDT, over your $80 per-action limit. Never signed, nothing spent.',
      0,
      'Blocked',
      { jobId: 'job_01', rule: 'per_action_cap' },
    ),
    ev('e3', 168, 'gridly', 'PancakeSwap', 'Rebalanced BNB / USDT back into range', 12, 'Done', {
      jobId: 'job_02',
    }),
    ev('e4', 130, 'guardian', 'Venus', 'Checked your position, no action needed', 0, 'Checked', {
      jobId: 'job_01',
    }),
    ev(
      'e5',
      64,
      'yieldmax',
      'Radiant',
      'Found 11.8% APY and asked for your approval',
      0,
      'Waiting',
    ),
    ev('e6', 18, 'gridly', 'PancakeSwap', 'Placed 4 grid orders between $580 and $640', 9, 'Done', {
      jobId: 'job_02',
    }),
  ]

  const receipts: Receipt[] = []

  return { ...EMPTY, connected: true, hires, jobs, events, receipts, seq: 1 }
}

/** Connected, but nothing hired. The state a real new user is actually in. */
export function freshState(): MockState {
  return { ...EMPTY, connected: true, seq: 1 }
}
