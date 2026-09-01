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
 * The least a turn may be allowed to start with.
 *
 * Below this there is not enough held to reach an answer worth reading, so the
 * turn is refused rather than begun and cut off two rounds in.
 */
export const MINIMUM_BALANCE_POINTS = 200

/**
 * What is held before a turn runs, and the hard ceiling on what it may cost.
 *
 * A turn cannot be priced until it is over. The old arrangement checked a
 * balance of 200 points, ran, and then charged whatever the turn came to,
 * clamped to whatever was left: on production that admitted turns costing 402,
 * 263 and 711 points, each shortfall forgiven silently, and two tabs could both
 * pass the check on the same 200 points.
 *
 * Now the money is taken up front and the loop is told what it has. 2,000
 * points is twenty cents, comfortably above every turn this has ever run, and
 * a turn that would exceed it stops and says so instead of running up a bill
 * against money that was never there. Whatever is not spent goes back the
 * moment the turn ends.
 */
export const TURN_HOLD_POINTS = 2_000

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

/**
 * The most this can cost AiKi in a day.
 *
 * Signing in costs a signature and nothing else, so an address is free and
 * unlimited, and a grant keyed on the address is a faucet: every grant is real
 * model spend somebody else pays for. This is the number that turns an
 * unbounded liability into a line item. Two hundred grants is a thousand
 * dollars of points a day, which is a decision rather than an accident.
 *
 * When it is reached, new accounts are told plainly that the free allowance is
 * gone for today, rather than being handed a balance that silently is not there.
 */
export const WELCOME_GRANTS_PER_DAY = 200

/** 1 USDT (six decimals) becomes this many points. */
export function pointsForUsdt(baseUnits: bigint): number {
  return Number((baseUnits * BigInt(POINTS_PER_USD)) / 1_000_000n)
}

/**
 * Points as an amount of the settlement asset. The inverse of the next one.
 *
 * Exact, not approximate, and that matters. A task's price is named in points
 * because that is what a person has a balance of, while a mandate's caps are
 * written in base units, so posting work under a mandate has to state the same
 * money in both. Deriving one from the other with rounding in between is how a
 * spend and the cap counting it start to disagree, and the disagreement is
 * invisible until somebody is refused for a limit they are inside.
 *
 * One point is a ten-thousandth of a unit, so on an eighteen-decimal asset this
 * is a multiplication by 10^14 and nothing is lost.
 */
export function settlementForPoints(points: number, decimals: number): bigint {
  if (points < 0) throw new Error('A price cannot be negative.')
  return (BigInt(Math.trunc(points)) * 10n ** BigInt(decimals)) / BigInt(POINTS_PER_USD)
}

/**
 * An amount of a settlement token, in points.
 *
 * A price is a number AND the thing it is counted in, and these two are counted
 * in different things: an agent publishes its price in base units of the
 * settlement asset, which carries eighteen decimals on BNB Chain, while a
 * balance is in points at ten thousand to the dollar. Charging one as if it
 * were the other is a factor of 10^14, and it is exactly what funding a job did
 * before this existed: it asked a buyer for 102,500,000,000,000,000 points for
 * a job priced at ten cents.
 *
 * Rounds DOWN, on the same rule the fee follows: the remainder is absorbed
 * rather than charged to somebody who was never quoted it.
 */
export function pointsForSettlement(baseUnits: bigint, decimals: number): number {
  if (baseUnits < 0n) throw new Error('A price cannot be negative.')
  return Number((baseUnits * BigInt(POINTS_PER_USD)) / 10n ** BigInt(decimals))
}
