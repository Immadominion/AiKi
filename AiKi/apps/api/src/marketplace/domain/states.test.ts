import { describe, expect, it } from 'vitest'
import { InvalidTransitionError } from './errors.js'
import {
  DISPUTE_STATES,
  DISPUTE_TRANSITIONS,
  PAYOUT_STATES,
  PAYOUT_TRANSITIONS,
  SETTLEMENT_STATES,
  SETTLEMENT_TRANSITIONS,
  transitionDispute,
  transitionPayout,
  transitionSettlement,
  transitionWork,
  WORK_STATES,
  WORK_TRANSITIONS,
} from './states.js'

describe('marketplace state machines', () => {
  const verify = (
    states: readonly string[],
    transitions: Readonly<Record<string, readonly string[]>>,
    move: (from: never, to: never) => string,
  ) => {
    for (const from of states) {
      for (const to of states) {
        if (transitions[from]?.includes(to)) {
          expect(move(from as never, to as never)).toBe(to)
        } else {
          expect(() => move(from as never, to as never)).toThrow(InvalidTransitionError)
        }
      }
    }
  }

  it('accepts only the declared transitions', () => {
    verify(WORK_STATES, WORK_TRANSITIONS, transitionWork)
    verify(SETTLEMENT_STATES, SETTLEMENT_TRANSITIONS, transitionSettlement)
    verify(DISPUTE_STATES, DISPUTE_TRANSITIONS, transitionDispute)
    verify(PAYOUT_STATES, PAYOUT_TRANSITIONS, transitionPayout)
  })

  it('does not mistake a settlement retry for a second logical payment', () => {
    expect(transitionSettlement('RELEASE_SUBMITTED', 'FUNDED')).toBe('FUNDED')
    expect(() => transitionSettlement('RELEASED', 'RELEASE_SUBMITTED')).toThrow(
      InvalidTransitionError,
    )
  })

  it('keeps a dispute separate from the work phase', () => {
    expect(transitionDispute('NONE', 'OPENED')).toBe('OPENED')
    expect(() => transitionWork('SUBMITTED', 'CANCELLED')).toThrow(InvalidTransitionError)
  })
})
