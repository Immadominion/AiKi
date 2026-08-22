/**
 * The four kinds of work AiKi claims today.
 *
 * Shared by the ask field and by search so they can never disagree about what
 * we say we can do — a suggestion the results page then fails to honour is worse
 * than no suggestion.
 */
export interface Task {
  key: string
  title: string
  sub: string
  glyph: string
  bg: string
  meta: string
  intent: string
  keys: string[]
}

export const TASKS: Task[] = [
  {
    key: 'health_factor',
    title: 'Protect me from liquidation',
    sub: 'Watches positions, repays debt before danger',
    glyph: 'G',
    bg: 'linear-gradient(135deg,#FF4D00,#FF8A3D)',
    meta: '4 agents',
    intent: 'Protect me from liquidation on Venus',
    keys: [
      'protect',
      'liquidation',
      'liquidated',
      'health',
      'borrow',
      'venus',
      'debt',
      'repay',
      'safe',
    ],
  },
  {
    key: 'rebalancing',
    title: 'Keep my LP in range',
    sub: 'Adjusts concentrated liquidity as price moves',
    glyph: 'L',
    bg: 'linear-gradient(135deg,#00B3A4,#4ADE80)',
    meta: '2 agents',
    intent: 'Keep my BNB / USDT position in range',
    keys: ['lp', 'liquidity', 'range', 'pool', 'rebalance', 'position'],
  },
  {
    key: 'yield_optimisation',
    title: 'Earn more on idle assets',
    sub: 'Finds a better rate, moves in, shows receipts',
    glyph: 'Y',
    bg: 'linear-gradient(135deg,#3B82F6,#8B5CF6)',
    meta: '3 agents',
    intent: 'Find better yield for 2 BNB',
    keys: ['yield', 'earn', 'apy', 'idle', 'move', 'interest', 'stake', 'better'],
  },
  {
    key: 'grid_trading',
    title: 'Trade a price range',
    sub: 'Grid strategy between two prices you set',
    glyph: 'G',
    bg: 'linear-gradient(135deg,#7C5CFF,#C05CFF)',
    meta: '2 agents',
    intent: 'Run a grid strategy on BNB',
    keys: ['trade', 'grid', 'price', 'buy', 'sell'],
  },
]

/**
 * Rank a query against a task.
 *
 * A whole-phrase key hit is worth two, a word-prefix hit one. Deliberately dumb
 * and deliberately local: a search that silently returns something plausible for
 * a query it did not understand is how you end up recommending an agent that
 * cannot do the job.
 */
export function rankTask(task: Task, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const words = q.split(/\s+/).filter((w) => w.length > 2)
  const keyScore = task.keys.reduce(
    (n, k) =>
      n + (q.includes(k) ? 2 : words.some((w) => k.startsWith(w) || w.startsWith(k)) ? 1 : 0),
    0,
  )
  return keyScore + (task.title.toLowerCase().includes(q) ? 2 : 0)
}

export const matchTasks = (query: string): Task[] =>
  TASKS.map((t) => ({ t, s: rankTask(t, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.t)
