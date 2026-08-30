import { WAD } from '../reference/venus/types.js'

/**
 * Deciding whether an agent should act, separately from acting.
 *
 * This is the piece that turns "the agent looked at your position" into "the
 * agent did something about it", and it is deliberately a pure function over an
 * assessment. Nothing here reaches the network, so every rule below can be
 * tested against a stated position rather than a mocked chain.
 *
 * The rules are conservative in one direction on purpose. An agent that fails to
 * act costs the user an opportunity; an agent that acts wrongly costs them
 * money, and the whole product is a claim about the second risk.
 */
export interface Assessment {
  status: string
  /** Decimal string, e.g. "1.18". Absent when there is no debt. */
  healthFactor?: string
  minimumHealthFactor: string
  adjustedCollateral: { amount: string }
  borrowed: { amount: string }
  consistency: { verified: boolean; detail: string }
  observedAt: string
}

export interface TriggerState {
  /** When this mandate last acted, so a slow recovery is not repaid twice. */
  lastActedAt?: string
  /** Remaining headroom under the mandate's caps, in base units of the repaid asset. */
  remaining: bigint
  /**
   * The oracle price of the asset being repaid, in Venus's scaling: a price is
   * quoted so that `tokens * price / 1e18` is an 18-decimal USD value, which
   * means the scale is 1e(36 - decimals) and differs per token.
   *
   * It is here because a position is measured in dollars and a mandate is
   * measured in tokens, and something has to convert between them before the
   * two are ever compared. Doing it here rather than in the caller is the point:
   * every number this function returns is then in the same units as the cap it
   * was checked against.
   */
  price: bigint
}

export type Decision =
  | { act: false; reason: string }
  | { act: true; repay: bigint; reason: string; targetHealthFactor: string }

const COOLDOWN_MS = 5 * 60_000

const toWad = (decimal: string): bigint => {
  const [whole = '0', fraction = ''] = decimal.split('.')
  return BigInt(whole) * WAD + BigInt((fraction + '0'.repeat(18)).slice(0, 18))
}

/**
 * How much debt must go away for the position to reach its target again.
 *
 * health = adjustedCollateral / borrowed, so for health >= target the borrow has
 * to fall to adjustedCollateral / target. Repaying exactly to the threshold
 * leaves the position one wei of price movement from tripping again, so this
 * aims slightly past it.
 */
export function repayToReach(adjustedCollateral: bigint, borrowed: bigint, target: bigint): bigint {
  if (target === 0n) return 0n
  const permitted = (adjustedCollateral * WAD) / target
  if (borrowed <= permitted) return 0n
  const shortfall = borrowed - permitted
  // 2% past the line, so ordinary price noise does not immediately re-trigger.
  return shortfall + shortfall / 50n
}

export function decide(assessment: Assessment, state: TriggerState, now = Date.now()): Decision {
  // An assessment that does not agree with the protocol's own numbers is not
  // evidence of anything. The assessment says so itself, and acting on it would
  // be spending money on a reading we have already published as unreliable.
  if (!assessment.consistency.verified)
    return { act: false, reason: `Assessment is inconsistent: ${assessment.consistency.detail}` }

  if (assessment.status === 'SAFE' || assessment.status === 'NO_DEBT')
    return { act: false, reason: `Position is ${assessment.status}; nothing to do.` }

  if (assessment.status === 'NO_POSITION') return { act: false, reason: 'No position to protect.' }

  if (assessment.status !== 'AT_RISK' && assessment.status !== 'LIQUIDATABLE')
    return { act: false, reason: `Unrecognised status ${assessment.status}; refusing to guess.` }

  if (state.lastActedAt) {
    const since = now - Date.parse(state.lastActedAt)
    // Repaying again before the previous repayment is reflected would repay the
    // same shortfall twice, at the user's expense.
    if (since < COOLDOWN_MS)
      return {
        act: false,
        reason: `Acted ${Math.round(since / 1000)}s ago; waiting for the position to reflect it.`,
      }
  }

  const target = toWad(assessment.minimumHealthFactor)
  const shortfallUsd = repayToReach(
    BigInt(assessment.adjustedCollateral.amount),
    BigInt(assessment.borrowed.amount),
    target,
  )
  if (shortfallUsd === 0n)
    return { act: false, reason: 'Position already meets its minimum health factor.' }

  if (state.price <= 0n)
    return { act: false, reason: 'No price for the repaid asset; refusing to guess an amount.' }

  /*
   * Dollars to tokens, and this conversion is the whole reason the price is
   * threaded down here. A position's shortfall is an 18-decimal USD figure; a
   * mandate's cap is in base units of a token that may have six decimals and
   * may not be worth a dollar. Comparing the two directly, or handing the USD
   * figure to repayBorrow, overstates the repayment by the product of both
   * differences — a factor of 5e11 for USDT at $0.50, which the cap then
   * refuses on every pass forever.
   */
  const repay = (shortfallUsd * WAD) / state.price
  if (repay === 0n) return { act: false, reason: 'The shortfall rounds to nothing in this asset.' }

  if (state.remaining <= 0n)
    return { act: false, reason: 'The mandate has no headroom left; the user must raise the cap.' }

  // Spending everything available on a partial fix is better than spending
  // nothing, but the user is told it was partial rather than told it was fixed.
  if (repay > state.remaining)
    return {
      act: true,
      repay: state.remaining,
      targetHealthFactor: assessment.minimumHealthFactor,
      reason:
        `Position is ${assessment.status}. Repaying the ${state.remaining.toString()} the mandate ` +
        `still allows, which is less than the ${repay.toString()} needed to reach the target.`,
    }

  return {
    act: true,
    repay,
    targetHealthFactor: assessment.minimumHealthFactor,
    reason: `Position is ${assessment.status}. Repaying ${repay.toString()} to restore the minimum health factor.`,
  }
}
