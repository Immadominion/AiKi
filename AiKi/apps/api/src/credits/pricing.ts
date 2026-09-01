/**
 * What a turn costs, and why it costs that.
 *
 * Points exist so that people who ask two questions a month are not charged like
 * people who ask two hundred. That only works if a point means something, so a
 * point is pinned to money — one point is a hundredth of a cent — and the cost of
 * a turn is computed from the tokens the model actually read and wrote.
 *
 * Nothing here is a guess or a per-message flat rate. A person who asks why an
 * answer cost 140 points can be shown the two token counts and the two rates and
 * arrive at 140 themselves, which is the same standard the rest of this product
 * holds itself to about numbers.
 */

/** One point is $0.0001, so 1 USDT buys 10,000 of them. */
export const POINTS_PER_USD = 10_000

/**
 * Charged over provider cost. Stated as a number rather than folded invisibly
 * into the rates, so the margin is a thing somebody can see and argue with.
 */
export const MARGIN = 1.3

export interface ModelRate {
  /** USD per million tokens, as the provider charges. */
  inputPerMTok: number
  outputPerMTok: number
  label: string
}

/**
 * Every model here can call tools, which is the only hard requirement: Fast mode
 * is not a chatbot with a marketplace bolted on, it is the marketplace's own
 * tools with a model driving them.
 *
 * Sonnet is the default. The cheaper model is genuinely capable and the gap in
 * price is real, but the moment that matters most in this product is a tool call
 * that moves money under a mandate, and one wrong call costs more than the
 * difference. Anyone who disagrees can change one environment variable.
 */
export const MODELS: Record<string, ModelRate> = {
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15, label: 'Sonnet 5' },
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5, label: 'Haiku 4.5' },
  'claude-opus-5': { inputPerMTok: 15, outputPerMTok: 75, label: 'Opus 5' },
}

export const DEFAULT_MODEL = 'claude-sonnet-5'

export function rateFor(model: string): ModelRate {
  const rate = MODELS[model]
  if (!rate) throw new Error(`No point rate is configured for ${model}.`)
  return rate
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

/** Rounded up, so a turn is never free through rounding. */
export function pointsFor(model: string, usage: Usage): number {
  const rate = rateFor(model)
  const usd =
    (usage.inputTokens * rate.inputPerMTok + usage.outputTokens * rate.outputPerMTok) / 1_000_000
  return Math.ceil(usd * POINTS_PER_USD * MARGIN)
}

/** The same sum in words, for anyone who wants to check it. */
export function explainCost(model: string, usage: Usage): string {
  const rate = rateFor(model)
  return (
    `${usage.inputTokens} in and ${usage.outputTokens} out on ${rate.label}, ` +
    `at $${rate.inputPerMTok} and $${rate.outputPerMTok} per million, ` +
    `plus a ${Math.round((MARGIN - 1) * 100)}% margin, is ${pointsFor(model, usage)} points.`
  )
}

/**
 * What to hold before a turn runs.
 *
 * A turn cannot be priced until it is over, and a turn that runs to completion
 * and then cannot be paid for is a turn someone else paid for. So a floor is
 * required up front — enough for a substantial answer — and the real cost is
 * settled afterwards.
 */
export const MINIMUM_BALANCE_POINTS = 200

/**
 * What a new account is given, once, so that trying Fast mode costs nothing.
 *
 * 5,000 points is fifty cents, which is roughly fifteen questions. Without it
 * the first thing a new visitor met was a 402 telling them to send USDT to a
 * treasury address before they could ask anything at all, which is an absurd
 * thing to require of somebody still deciding whether the product works. The
 * grant is a real credit entry with its own reason, not a fake balance, and it
 * appears in the history like every other movement.
 *
 * It is keyed on the address, and `deposit` refuses a duplicate reference, so
 * one address can only ever receive it once.
 */
export const WELCOME_GRANT_POINTS = 5_000

/** 1 USDT (six decimals) becomes this many points. */
export function pointsForUsdt(baseUnits: bigint): number {
  return Number((baseUnits * BigInt(POINTS_PER_USD)) / 1_000_000n)
}
