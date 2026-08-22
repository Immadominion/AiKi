import type { JobEvent } from '@aiki/contracts'

/**
 * A job's event stream.
 *
 * Replayed locally on a timer so Mission Control can be built and demoed without
 * apps/api, and shaped exactly like the SSE payload from
 * `GET /v1/jobs/:id/events` so swapping to the live stream changes the source and
 * nothing else.
 *
 * The `policy` deny and the `approval_required` are the two events worth
 * designing for. Everything else is the boring middle.
 */
/**
 * SSE carries an `id:` on every message so a dropped connection can resume from
 * the last one seen. We model that here rather than inventing keys at render
 * time: the sequence number is the event's identity, in the data, where it
 * belongs.
 */
export interface StreamedEvent {
  seq: number
  event: JobEvent
}

const RAW: JobEvent[] = [
  { type: 'status', at: '2026-08-22T02:36:00Z', status: 'DISPATCHED' },
  {
    type: 'step',
    at: '2026-08-22T02:36:04Z',
    label: 'Read your Venus position',
    detail: 'Health factor 1.22 — below your 1.25 floor.',
  },
  { type: 'status', at: '2026-08-22T02:36:05Z', status: 'RUNNING' },
  {
    type: 'step',
    at: '2026-08-22T02:38:40Z',
    label: 'Worked out the repayment',
    detail: '72 USDT brings the health factor to 1.47.',
  },
  {
    type: 'policy',
    at: '2026-08-22T02:38:44Z',
    decision: 'allow',
    rule: 'per_action_cap',
    reason: '$72.00 is inside your $80 per-action limit.',
  },
  {
    type: 'onchain',
    at: '2026-08-22T02:39:02Z',
    txHash: '0x8f2c41a7d93b06e5c8147ab29f0d63e5b41c907a2ed85f36b10c47592a8ef3d1',
    action: 'Repaid 72 USDT to Venus',
    gas: { amount: '211000000000000', asset: 'BNB', decimals: 18, displayUsd: '0.06' },
  },
  {
    type: 'spend',
    at: '2026-08-22T02:39:03Z',
    amount: { amount: '72000000000000000000', asset: 'USDT', decimals: 18, displayUsd: '72.00' },
    runningTotal: {
      amount: '86200000000000000000',
      asset: 'USDT',
      decimals: 18,
      displayUsd: '86.20',
    },
  },
  {
    type: 'step',
    at: '2026-08-22T02:39:20Z',
    label: 'Checked the result',
    detail: 'Health factor is 1.47. Above your floor.',
  },

  // The one that matters. The limit visibly doing its job.
  {
    type: 'step',
    at: '2026-08-22T02:41:10Z',
    label: 'Price moved. Recalculated.',
    detail: 'Health factor back to 1.19. Wants to repay 91.20 USDT.',
  },
  {
    type: 'policy',
    at: '2026-08-22T02:41:12Z',
    decision: 'deny',
    rule: 'per_action_cap',
    reason:
      '$91.20 is over your $80 per-action limit. The transaction was never signed and nothing was spent.',
  },
  {
    type: 'step',
    at: '2026-08-22T02:41:14Z',
    label: 'Split the repayment instead',
    detail: 'Two repayments of 45.60 USDT, each inside the limit.',
  },
  {
    type: 'policy',
    at: '2026-08-22T02:41:15Z',
    decision: 'allow',
    rule: 'per_action_cap',
    reason: '$45.60 is inside your $80 per-action limit.',
  },

  {
    type: 'approval_required',
    at: '2026-08-22T02:41:18Z',
    approvalId: 'apr_01J8',
    prompt: 'Two repayments in a row will take today past $120. Go ahead?',
    amount: { amount: '91200000000000000000', asset: 'USDT', decimals: 18, displayUsd: '91.20' },
    expiresAt: '2026-08-22T02:56:18Z',
  },
]

export const JOB_EVENTS: StreamedEvent[] = RAW.map((event, i) => ({ seq: i, event }))

export const JOB = {
  jobId: 'job_01J8',
  agentKey: 'guardian' as const,
  title: 'Protecting your Venus loan',
  spent: { value: '$86.20', cap: '$250', pct: '34.5%' },
  perAction: '$80',
  stopsOn: '30 September 2026',
  nextTrigger: 'Health factor drops below 1.25',
  receiptId: 'rcp_01J8',
}
