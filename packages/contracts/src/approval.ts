/**
 * How much the agent may do on its own, inside the caps.
 *
 * Kept apart from either mandate builder because both need it and neither owns
 * it. The caps say how much can ever move; this says who decides each time it
 * does, and they are not substitutes: a mandate capped at 50 USDT with no ask
 * is still 50 USDT an agent spends with nobody in the loop.
 *
 * `never` is the honest name for what both builders did before this existed,
 * and the fact that it was written down nowhere is the thing being fixed.
 */
export type AskLevel = 'every' | 'over' | 'never'

/** The vocabulary the policy engine already reads. Mapped here, in one place. */
export const ASK_MODE: Record<AskLevel, 'approve_every' | 'approve_above_threshold' | 'automatic'> =
  {
    every: 'approve_every',
    over: 'approve_above_threshold',
    never: 'automatic',
  }

export interface AskInput {
  ask: AskLevel
  /** Whole tokens. Required by `over`, meaningless to the other two. */
  askOver?: number
  /** Base units, for the check that an `over` threshold can actually be reached. */
  perActionUnits: string
  symbol: string
  decimals: number
  units(value: number, decimals: number, symbol: string): string
}

/**
 * The one constraint, at the only tier it could honestly carry.
 *
 * T2 because no contract can wait for a person. The chain accepts a transaction
 * or it does not, so "hold this until somebody answers" is AiKi declining to
 * relay. This is the control somebody reaches for when they trust the agent
 * least, which makes drawing it as chain-held the worst available lie.
 */
export function approvalConstraint(input: AskInput): {
  kind: 'approval'
  value: { mode: string; threshold: string }
  tier: 'T2'
  label: string
} {
  if (!Object.hasOwn(ASK_MODE, input.ask))
    throw new Error('Say whether the agent asks before every action, over an amount, or never.')
  let threshold = '0'
  if (input.ask === 'over') {
    if (typeof input.askOver !== 'number' || !Number.isFinite(input.askOver) || input.askOver <= 0)
      throw new Error('Say the amount the agent should start asking over, in whole tokens.')
    threshold = input.units(input.askOver, input.decimals, input.symbol)
    /*
     * A threshold at or above the per-action cap never fires.
     *
     * The gate asks when the amount is strictly over the threshold, and the cap
     * already refuses anything over itself, so "over 50" on a mandate capped at
     * 50 is "never" wearing the word "over". Someone who chose to be asked would
     * be told they had been, and never would be. Refused rather than silently
     * accepted, because the failure is invisible until the money has moved.
     */
    if (BigInt(threshold) >= BigInt(input.perActionUnits))
      throw new Error(
        `Asking only over ${input.askOver} ${input.symbol} would never ask, because this mandate already refuses anything over the per-action cap in one action. Choose a lower amount, or ask every time.`,
      )
  }
  return {
    kind: 'approval',
    value: { mode: ASK_MODE[input.ask], threshold },
    tier: 'T2',
    label:
      input.ask === 'every'
        ? 'asks you before every action'
        : input.ask === 'over'
          ? `asks you over ${input.askOver} ${input.symbol}`
          : 'acts without asking, inside these limits',
  }
}
