/**
 * The demo dataset the design reference was drawn against.
 *
 * This is the seed the UI is built on until apps/api serves the real thing —
 * same field names as the contract in @aiki/contracts, so swapping the source
 * is a change of import, not a rewrite of every screen.
 */

export type AgentKey = 'guardian' | 'gridly' | 'yieldmax' | 'lpilot' | 'sentinel' | 'harbor'

/** Identity gradients live in globals.css so a colour is defined exactly once. */
export const AGENT_BG: Record<AgentKey, string> = {
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
    blurb: 'Same job as Guardian, cheaper — but barely tested so far.',
    bars: 1,
    evidence: 'Not enough history yet',
    evidenceTone: 'thin',
    price: '$1 / mo',
  },
]

export const AGENT_BY_KEY = Object.fromEntries(AGENTS.map((a) => [a.key, a])) as Record<
  AgentKey,
  AgentRow
>
