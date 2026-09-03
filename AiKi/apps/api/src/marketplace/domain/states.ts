import { InvalidTransitionError } from './errors.js'

export const WORK_STATES = [
  'DRAFT',
  'OPEN',
  'OFFERED',
  'ASSIGNED',
  'IN_PROGRESS',
  'SUBMITTED',
  'CHANGES_REQUESTED',
  'ACCEPTED',
  'CANCELLED',
  'EXPIRED',
] as const
export type WorkState = (typeof WORK_STATES)[number]

export const SETTLEMENT_STATES = [
  'UNFUNDED',
  'FUNDING_SUBMITTED',
  'FUNDED',
  'RELEASE_SUBMITTED',
  'RELEASED',
  'REFUND_SUBMITTED',
  'REFUNDED',
] as const
export type SettlementState = (typeof SETTLEMENT_STATES)[number]

export const DISPUTE_STATES = [
  'NONE',
  'OPENED',
  'EVIDENCE',
  'RESOLVED',
  'APPEALED',
  'FINAL',
] as const
export type DisputeState = (typeof DISPUTE_STATES)[number]

export const PAYOUT_STATES = ['NONE', 'HOLD', 'AVAILABLE', 'PAID', 'FAILED'] as const
export type PayoutState = (typeof PAYOUT_STATES)[number]

type TransitionTable<State extends string> = Readonly<Record<State, readonly State[]>>

export const WORK_TRANSITIONS: TransitionTable<WorkState> = {
  DRAFT: ['OPEN', 'OFFERED', 'ASSIGNED', 'CANCELLED'],
  OPEN: ['OFFERED', 'ASSIGNED', 'CANCELLED', 'EXPIRED'],
  OFFERED: ['ASSIGNED', 'CANCELLED', 'EXPIRED'],
  ASSIGNED: ['IN_PROGRESS', 'CANCELLED', 'EXPIRED'],
  IN_PROGRESS: ['SUBMITTED', 'CANCELLED', 'EXPIRED'],
  SUBMITTED: ['CHANGES_REQUESTED', 'ACCEPTED'],
  CHANGES_REQUESTED: ['IN_PROGRESS', 'CANCELLED', 'EXPIRED'],
  ACCEPTED: [],
  CANCELLED: [],
  EXPIRED: [],
}

export const SETTLEMENT_TRANSITIONS: TransitionTable<SettlementState> = {
  UNFUNDED: ['FUNDING_SUBMITTED'],
  // A proven chain revert restores the last known monetary truth. Timeouts do not.
  FUNDING_SUBMITTED: ['FUNDED', 'UNFUNDED'],
  FUNDED: ['RELEASE_SUBMITTED', 'REFUND_SUBMITTED'],
  RELEASE_SUBMITTED: ['RELEASED', 'FUNDED'],
  RELEASED: [],
  REFUND_SUBMITTED: ['REFUNDED', 'FUNDED'],
  REFUNDED: [],
}

export const DISPUTE_TRANSITIONS: TransitionTable<DisputeState> = {
  NONE: ['OPENED'],
  OPENED: ['EVIDENCE', 'RESOLVED'],
  EVIDENCE: ['RESOLVED'],
  RESOLVED: ['APPEALED', 'FINAL'],
  APPEALED: ['FINAL'],
  FINAL: [],
}

export const PAYOUT_TRANSITIONS: TransitionTable<PayoutState> = {
  NONE: ['HOLD', 'AVAILABLE'],
  HOLD: ['AVAILABLE'],
  AVAILABLE: ['PAID', 'FAILED'],
  PAID: [],
  FAILED: ['AVAILABLE', 'PAID'],
}

function assertTransition<State extends string>(
  machine: string,
  table: TransitionTable<State>,
  from: State,
  to: State,
): State {
  if (!table[from].includes(to)) throw new InvalidTransitionError(machine, from, to)
  return to
}

export const transitionWork = (from: WorkState, to: WorkState): WorkState =>
  assertTransition('work', WORK_TRANSITIONS, from, to)

export const transitionSettlement = (from: SettlementState, to: SettlementState): SettlementState =>
  assertTransition('settlement', SETTLEMENT_TRANSITIONS, from, to)

export const transitionDispute = (from: DisputeState, to: DisputeState): DisputeState =>
  assertTransition('dispute', DISPUTE_TRANSITIONS, from, to)

export const transitionPayout = (from: PayoutState, to: PayoutState): PayoutState =>
  assertTransition('payout', PAYOUT_TRANSITIONS, from, to)
