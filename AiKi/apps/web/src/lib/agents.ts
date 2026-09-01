/**
 * The demo dataset the design reference was drawn against.
 *
 * This is the seed the UI is built on until apps/api serves the real thing —
 * same field names as the contract in @aiki/contracts, so swapping the source
 * is a change of import, not a rewrite of every screen.
 */

export type AgentKey = 'guardian' | 'gridly' | 'yieldmax' | 'lpilot' | 'sentinel' | 'harbor'

/** Identity gradients live in globals.css so a colour is defined exactly once. */
export const AGENT_BG: Record<string, string> = {
  guardian: 'var(--agent-guardian)',
  gridly: 'var(--agent-gridly)',
  yieldmax: 'var(--agent-yieldmax)',
  lpilot: 'var(--agent-lpilot)',
  sentinel: 'var(--agent-sentinel)',
  harbor: 'var(--agent-harbor)',
}

export type EvidenceTone = 'strong' | 'fair' | 'thin'

export interface AgentRow {
  key: AgentKey
  initial: string
  name: string
  works: string
  does: string
  blurb: string
  /** Filled bars out of five. One bar is one batch of checks AiKi ran itself. */
  bars: number
  evidence: string
  evidenceTone: EvidenceTone
  price: string
}

/**
 * Six example agents.
 *
 * These are NOT in the ERC-8004 registry and AiKi has never probed them. They
 * exist so the hiring flow, the mandate builder and the receipt can be walked
 * end to end before any real agent publishes enough to be hired, and every
 * surface that renders them is required to say so.
 *
 * The real ones live at /registry, built entirely from observations. The two
 * sets are deliberately not mixed: an invented check count sitting beside a
 * measured one would make both meaningless.
 */
export const AGENTS: AgentRow[] = [
  {
    key: 'guardian',
    initial: 'G',
    name: 'Guardian',
    works: 'Venus · BNB',
    does: 'Repays debt before liquidation',
    blurb: 'Watches your loan and repays debt before liquidation gets close.',
    bars: 5,
    evidence: 'Strong · 174 checks',
    evidenceTone: 'strong',
    price: '$2 / mo',
  },
  {
    key: 'lpilot',
    initial: 'L',
    name: 'LPilot',
    works: 'Pancake v3',
    does: 'Keeps liquidity in range',
    blurb: 'Keeps a concentrated position in range without you watching charts.',
    bars: 4,
    evidence: 'Good · 96 checks',
    evidenceTone: 'strong',
    price: '$3 / mo',
  },
  {
    key: 'yieldmax',
    initial: 'Y',
    name: 'YieldMax',
    works: 'Venus · Radiant',
    does: 'Moves idle assets to better rates',
    blurb: 'Moves idle assets into the best rate it can verify, with receipts.',
    bars: 3,
    evidence: 'Fair · 61 checks',
    evidenceTone: 'fair',
    price: '0.4% of gain',
  },
  {
    key: 'gridly',
    initial: 'G',
    name: 'Gridly',
    works: 'PancakeSwap',
    does: 'Trades a price range you set',
    blurb: 'Runs a grid strategy between two prices you set yourself.',
    bars: 3,
    evidence: 'Fair · 48 checks',
    evidenceTone: 'fair',
    price: '$0.12 / run',
  },
  {
    key: 'harbor',
    initial: 'H',
    name: 'Harbor',
    works: 'Multi-protocol',
    does: 'Moves idle stablecoins',
    blurb: 'Moves idle stablecoins and tells you exactly where they went.',
    bars: 2,
    evidence: 'Thin · 22 checks',
    evidenceTone: 'thin',
    price: '$1 / mo',
  },
  {
    key: 'sentinel',
    initial: 'S',
    name: 'Sentinel',
    works: 'Venus',
    does: 'Watches risk, alerts only',
    blurb: 'Same job as Guardian and cheaper, but barely tested so far.',
    bars: 1,
    evidence: 'Not enough history yet',
    evidenceTone: 'thin',
    price: '$1 / mo',
  },
]

export const AGENT_BY_KEY = Object.fromEntries(AGENTS.map((a) => [a.key, a])) as Record<
  string,
  AgentRow
>

/**
 * A row for anything you have hired, example or real.
 *
 * The six example agents live in a table keyed by name. A real listing is an
 * ERC-8004 token id and has no row there, which is precisely why the only
 * agents anybody could hire were the six that do not exist. Rather than guard
 * every screen against a missing row, this returns one either way, and the
 * synthesised row says plainly that it is a token id rather than inventing a
 * description for an agent nobody has read.
 */
export function agentRow(key: string, known?: { name?: string; initial?: string }): AgentRow {
  const row = AGENT_BY_KEY[key]
  if (row) return row
  const name = known?.name ?? `Agent ${key}`
  return {
    key: key as AgentKey,
    initial: known?.initial ?? (name.charAt(0) || '?').toUpperCase(),
    name,
    works: `token ${key}`,
    does: 'See its passport for what it declares and what we measured.',
    blurb: 'See its passport for what it declares and what we measured.',
    bars: 0,
    evidence: 'Not measured here',
    evidenceTone: 'thin',
    price: 'See passport',
  }
}
