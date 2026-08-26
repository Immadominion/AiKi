import type { ApprovalMode, CapPeriod } from '@aiki/contracts'
import type { AgentKey } from '@/lib/agents'

/**
 * Local mock state.
 *
 * Shaped like the contract so swapping it for apps/api is a change of import
 * rather than a rewrite — but deliberately simpler in two places:
 *
 *  - money is integer CENTS, not the contract's Money strings. Cents cannot
 *    drift the way floats do, and a mock that quietly loses a penny would send
 *    us hunting a bug that does not exist.
 *  - ids are sequential, not opaque. When you are walking a flow by hand you
 *    want to recognise the thing you just made.
 */
export const MOCK_VERSION = 3

export type JobStatus = 'RUNNING' | 'WAITING' | 'PAUSED' | 'DONE'

export interface Mandate {
  perActionCents: number
  capCents: number
  period: CapPeriod
  expiresAt: string
  approval: ApprovalMode
}

export interface Hire {
  key: AgentKey
  hiredAt: string
  status: 'working' | 'paused' | 'revoked'
  mandate: Mandate
  spentCents: number
  jobId: string
  /**
   * Set when this mandate was recorded by the API under a proven address.
   * Absent means it exists only in this browser, and the UI says so.
   */
  authorizationId?: string
}

export interface PendingApproval {
  id: string
  prompt: string
  amountCents: number
  expiresAt: string
}

export interface Job {
  id: string
  key: AgentKey
  title: string
  status: JobStatus
  /** How far through the script this job has run. */
  step: number
  createdAt: string
  updatedAt: string
  receiptId?: string
  approval?: PendingApproval
  /** Set once the mandate has refused something. Drives the honest banners. */
  blockedOnce: boolean
}

export type EventResult = 'Done' | 'Blocked' | 'Checked' | 'Waiting'

export interface ActivityEvent {
  id: string
  at: string
  key: AgentKey
  where: string
  what: string
  costCents: number
  result: EventResult
  txHash?: string
  jobId?: string
  /** Policy events carry the rule that decided them, like the real stream. */
  rule?: string
}

export interface ReceiptAction {
  what: string
  at: string
  allowed: boolean
  txHash?: string
  gasCents?: number
}

export interface Receipt {
  id: string
  jobId: string
  key: AgentKey
  actions: ReceiptAction[]
  providerCents: number
  platformCents: number
  networkCents: number
  summary: string
  mandateHash: string
  signature: string
  startedAt: string
  completedAt: string
}

export interface MockState {
  version: number
  connected: boolean
  /** 'injected' is a real EIP-1193 wallet; 'simulated' is the demo fallback and is always labelled. */
  walletKind: 'injected' | 'simulated'
  chainId: number | null
  address: string
  hires: Hire[]
  jobs: Job[]
  events: ActivityEvent[]
  receipts: Receipt[]
  /** Bumped on every write so consumers can key off it. */
  seq: number
}

export const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const EMPTY: MockState = {
  version: MOCK_VERSION,
  connected: false,
  walletKind: 'simulated',
  chainId: null,
  address: '0x7f4a2b91c0de44a1f8e37b25d90ac6183f4a3a91',
  hires: [],
  jobs: [],
  events: [],
  receipts: [],
  seq: 0,
}
