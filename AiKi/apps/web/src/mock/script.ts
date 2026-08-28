import type { AgentKey } from '@/lib/agents'
import { DETAILS } from '@/lib/detail'
import type { ActivityEvent, Hire, Job, PendingApproval, Receipt } from './types'

/**
 * What a hired agent does, step by step.
 *
 * One script for every agent, parameterised by the mandate you actually set —
 * so the refusal happens at YOUR per-action cap, not at a number baked into a
 * fixture. Walking the flow with a $40 cap and walking it with $150 should feel
 * like two different products, and it does.
 *
 * Step 4 is the point of the whole thing: the agent asks for more than it is
 * allowed and the mandate says no, before anything is signed.
 */
export interface StepResult {
  events: Omit<ActivityEvent, 'id' | 'at'>[]
  approval?: Omit<PendingApproval, 'id' | 'expiresAt'> | undefined
  done?: boolean
  spendCents?: number
}

const WHERE: Record<AgentKey, string> = {
  guardian: 'Venus',
  sentinel: 'Venus',
  lpilot: 'PancakeSwap v3',
  gridly: 'PancakeSwap',
  yieldmax: 'Radiant',
  harbor: 'Venus',
}

const READ: Record<AgentKey, string> = {
  guardian: 'Read your Venus position. Health factor 1.22, below your 1.25 floor',
  sentinel: 'Read your Venus position. Health factor 1.22, below your 1.25 floor',
  lpilot: 'Read your BNB / USDT position. Price has left your range',
  gridly: 'Read the BNB book. Four grid levels are unfilled',
  yieldmax: 'Compared supply rates. Radiant is 11.8%, 3.1 points above where you are',
  harbor: 'Compared stablecoin rates. 2.4 points of idle yield available',
}

/** Sentence-case, for a line that starts. */
const ACT: Record<AgentKey, string> = {
  guardian: 'Repay borrowed USDT',
  sentinel: 'Alert you',
  lpilot: 'Re-mint the position around the current price',
  gridly: 'Place the missing grid orders',
  yieldmax: 'Move idle USDT into Radiant',
  harbor: 'Move idle USDT into the better market',
}

/** Mid-sentence phrasing. Lowercasing ACT would turn USDT into usdt. */
const PLAN: Record<AgentKey, string> = {
  guardian: 'repay part of the debt',
  sentinel: 'alert you',
  lpilot: 're-mint the position',
  gridly: 'place the missing orders',
  yieldmax: 'move idle USDT into Radiant',
  harbor: 'move idle USDT to the better market',
}

/**
 * There are no transaction hashes here, and no signature.
 *
 * This script drives a demonstration of the flow; nothing it describes was ever
 * broadcast. It used to hash the job id into 64 hex characters and render that
 * under a "Signed" pill next to real venue names, which is a fabricated proof of
 * a transaction that does not exist, in a product whose whole claim is that a
 * number on screen can be traced to something that happened. A real signed
 * receipt comes from POST /v1/jobs/:id/receipt and verifies at /verify.
 */

/** Agents that cannot spend never reach the money steps. */
const canSpend = (key: AgentKey) =>
  DETAILS[key].capabilities.some((c) => c.permissions.some((p) => p.startsWith('spend_')))

export function runStep(job: Job, hire: Hire): StepResult | null {
  const key = job.key
  const where = WHERE[key]
  const perAction = hire.mandate.perActionCents
  const base = { key, where, jobId: job.id }

  // The over-cap ask is always 14% above whatever you allowed, so the refusal
  // lands wherever you set the line.
  const over = Math.round(perAction * 1.14)
  const half = Math.round(over / 2)

  if (!canSpend(key)) {
    switch (job.step) {
      case 0:
        return { events: [{ ...base, what: READ[key], costCents: 0, result: 'Checked' }] }
      case 1:
        return {
          events: [
            {
              ...base,
              what: `${ACT[key]}. It has no session key, so it cannot act on this itself`,
              costCents: 0,
              result: 'Done',
            },
          ],
          done: true,
        }
      default:
        return null
    }
  }

  switch (job.step) {
    case 0:
      return { events: [{ ...base, what: READ[key], costCents: 0, result: 'Checked' }] }

    case 1:
      return {
        events: [
          {
            ...base,
            what: `Worked out the action: ${PLAN[key]}, ${(half / 100).toFixed(2)} USDT`,
            costCents: 0,
            result: 'Checked',
          },
        ],
      }

    case 2:
      return {
        events: [
          {
            ...base,
            what: `${ACT[key]}, ${(half / 100).toFixed(2)} USDT`,
            costCents: 6,
            result: 'Done',
            rule: 'per_action_cap',
          },
        ],
        spendCents: half,
      }

    // The one that matters.
    case 3:
      return {
        events: [
          {
            ...base,
            what: `Tried to spend ${(over / 100).toFixed(2)} USDT, over your ${(perAction / 100).toFixed(2)} per-action limit. Never signed, nothing spent.`,
            costCents: 0,
            result: 'Blocked',
            rule: 'per_action_cap',
          },
        ],
      }

    case 4:
      return {
        events: [
          {
            ...base,
            what: `Split it into two actions of ${(half / 100).toFixed(2)} USDT, each inside the limit`,
            costCents: 0,
            result: 'Checked',
          },
        ],
        approval:
          hire.mandate.approval === 'automatic'
            ? undefined
            : {
                prompt: `Two actions in a row will take today past ${((half * 2) / 100).toFixed(2)}. Go ahead?`,
                amountCents: half * 2,
              },
      }

    case 5:
      return {
        events: [
          {
            ...base,
            what: `${ACT[key]}, ${(half / 100).toFixed(2)} USDT`,
            costCents: 6,
            result: 'Done',
          },
        ],
        spendCents: half,
        done: true,
      }

    default:
      return null
  }
}

const OUTCOME: Record<AgentKey, string> = {
  guardian: 'Health factor moved from 1.19 to 1.51 and stayed above your floor.',
  sentinel: 'You were told. Sentinel cannot act, and did not.',
  lpilot: 'The position is back in range and earning fees again.',
  gridly: 'Four grid orders are live between the prices you set.',
  yieldmax: 'Your idle USDT is earning 11.8% instead of 8.7%.',
  harbor: 'Your idle stablecoins moved to the better market, and here is where they went.',
}

export function buildReceipt(job: Job, _hire: Hire, events: ActivityEvent[]): Receipt {
  const mine = events.filter((e) => e.jobId === job.id)
  const spent = mine.reduce((n, e) => n + e.costCents, 0)

  return {
    id: `rcp_${job.id.replace('job_', '')}`,
    jobId: job.id,
    key: job.key,
    actions: mine.map((e) => ({
      what: e.what,
      at: e.at,
      allowed: e.result !== 'Blocked',
      ...(e.txHash ? { txHash: e.txHash } : {}),
      ...(e.costCents ? { gasCents: e.costCents } : {}),
    })),
    providerCents: 200,
    platformCents: 10,
    networkCents: spent,
    summary: OUTCOME[job.key],
    startedAt: job.createdAt,
    completedAt: job.updatedAt,
  }
}
