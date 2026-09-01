import type { EnforcementTier, EvidenceClass, LivenessState } from '@aiki/contracts'
import type { AgentKey } from './agents'

/**
 * Passport fixtures.
 *
 * Rule for this file: an enforcement line may never name a contract that does
 * not exist. A renewing cap has no enforcer anywhere, on chain or off, because
 * Constraint has no period field and evaluatePolicy has no reset, so it is T2
 * and says why. Claiming T0 for it named ERC20PeriodTransferEnforcer, which is
 * not in onchain/ and never was.
 *
 * Everything measurable is stored as the COUNTS behind it — successes out of
 * trials — never as a finished score. The score is computed at render time from
 * those counts, so a number on screen can always be traced back to the evidence
 * that produced it, and cannot drift away from it when someone edits this file.
 */

export type Counts = readonly [successes: number, trials: number]

export interface ComponentCounts {
  liveness: Counts
  executionReliability: Counts
  outcomeQuality: Counts
  reputation: Counts
  safety: Counts
}

export interface EnforcementLine {
  label: string
  tier: EnforcementTier
  enforcedBy: string
  verified: boolean
  caveat?: string
}

export interface AgentDetail {
  key: AgentKey
  tagline: string
  owner: string
  ownerVerified: boolean
  /** The one field ERC-8004 actually proves cryptographically. */
  agentWalletProven: boolean
  tokenId: string
  registeredAt: string
  uriScheme: 'https' | 'ipfs' | 'data'
  reciprocalProofVerified: boolean
  /** Empty means the registry entry is discovery only, carrying no trust claim. */
  supportedTrust: string[]
  ownershipTransfers: number
  liveness: {
    state: LivenessState
    detail: string
    lastProbeAt: string
    p95LatencyMs?: number
  }
  /** Overall: did it do what it said, across every check we ran. */
  checks: Counts
  components: ComponentCounts
  price: string
  priceModel: string
  settlementAsset: string
  supportsX402: boolean
  capabilities: { name: string; does: string; permissions: string[] }[]
  /**
   * The assets this agent may move, as addresses.
   *
   * A spend cap is a limit on money leaving your account, and money leaves
   * through the token contract, so this is what the cap has to be scoped to
   * before a chain can hold it: the enforcers locate an amount by the contract
   * and function being called, and refuse outright when they cannot find one.
   * Without this the cap is only ever counted by AiKi.
   *
   * Empty means the agent cannot move anything, which is a real answer and a
   * stronger one than any cap.
   */
  spends: { asset: `0x${string}`; symbol: string; decimals: number }[]
  enforcement: EnforcementLine[]
  risks: { label: string; severity: 'info' | 'warn' | 'critical'; detail: string }[]
  evidence: { cls: EvidenceClass; count: number; summary: string }[]
}

/**
 * Checked against the chain rather than copied from a list: both answered
 * `symbol()` and `decimals()` on BNB Chain on 29 August 2026, and both are 18
 * decimals. USDT is 6 decimals on most other chains, and assuming that here
 * would make every cap wrong by a factor of a trillion.
 */
// Both carry eighteen decimals on BNB Chain, not the six USDT uses elsewhere.
const USDT = {
  asset: '0x55d398326f99059fF775485246999027B3197955',
  symbol: 'USDT',
  decimals: 18,
} as const
const WBNB = {
  asset: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  symbol: 'WBNB',
  decimals: 18,
} as const

const OBSERVED = '2026-08-22T04:10:00Z'

export const DETAILS: Record<string, AgentDetail> = {
  guardian: {
    key: 'guardian',
    spends: [USDT],
    tagline: 'Watches a lending position and repays debt before liquidation gets close.',
    owner: '0x9c41f2a7b83e5d0146c9a7f3b2e8d4517a09cb62',
    ownerVerified: true,
    agentWalletProven: true,
    tokenId: '50285',
    registeredAt: '2026-03-04T09:12:00Z',
    uriScheme: 'https',
    reciprocalProofVerified: true,
    supportedTrust: ['feedback', 'inference-validation'],
    ownershipTransfers: 0,
    liveness: {
      state: 'LIVE',
      detail: 'Answers differently for different positions.',
      lastProbeAt: OBSERVED,
      p95LatencyMs: 410,
    },
    checks: [171, 174],
    components: {
      liveness: [172, 174],
      executionReliability: [88, 91],
      outcomeQuality: [40, 44],
      reputation: [12, 19],
      safety: [174, 174],
    },
    price: '$2 / mo',
    priceModel: 'Subscription, billed monthly',
    settlementAsset: '$U',
    supportsX402: true,
    capabilities: [
      {
        name: 'Watch health factor',
        does: 'Reads your Venus account every 90 seconds.',
        permissions: ['read_position'],
      },
      {
        name: 'Repay debt',
        does: 'Repays borrowed USDT when the health factor drops below your floor.',
        permissions: ['repay_debt', 'spend_usdt'],
      },
    ],
    enforcement: [
      {
        label: 'Can only call Venus Comptroller and vUSDT',
        tier: 'T0',
        enforcedBy: 'SmartSession:UniversalActionPolicy',
        verified: true,
      },
      {
        label: 'Never more than $80 in one action',
        tier: 'T2',
        enforcedBy: 'aiki:policy-service',
        verified: true,
        caveat:
          'Counted by AiKi before relaying. PerActionCapEnforcer takes this over once deployed.',
      },
      {
        label: 'Never more than $250 a month',
        tier: 'T2',
        enforcedBy: 'aiki:policy-service',
        verified: true,
        caveat:
          'A renewing cap is counted by AiKi, not by a contract. No periodic enforcer exists on either side, so this is the weakest line in the mandate.',
      },
      {
        label: 'Stops on 30 September',
        tier: 'T0',
        enforcedBy: 'SmartSession:expiry',
        verified: true,
      },
    ],
    risks: [
      {
        label: 'Identity is transferable',
        severity: 'info',
        detail:
          'The ERC-721 behind this agent can be sold. If it moves, evidence confidence resets to zero and you are told before the next action.',
      },
    ],
    evidence: [
      {
        cls: 'B',
        count: 174,
        summary: 'AiKi probes for capability, liveness and impostor detection.',
      },
      { cls: 'A', count: 91, summary: 'On-chain actions, all finalised.' },
      {
        cls: 'D',
        count: 19,
        summary:
          'Registry feedback. Ingested, weighted near zero, because none carries payment proof.',
      },
    ],
  },

  lpilot: {
    key: 'lpilot',
    spends: [WBNB],
    tagline: 'Keeps a concentrated position in range without you watching charts.',
    owner: '0x3fa8d15c72e94b0d61a8c53f7e2b9d04ca617e38',
    ownerVerified: true,
    agentWalletProven: true,
    tokenId: '48117',
    registeredAt: '2026-04-19T14:02:00Z',
    uriScheme: 'https',
    reciprocalProofVerified: true,
    supportedTrust: ['feedback'],
    ownershipTransfers: 0,
    liveness: {
      state: 'LIVE',
      detail: 'Answers differently for different pools.',
      lastProbeAt: OBSERVED,
      p95LatencyMs: 620,
    },
    checks: [92, 96],
    components: {
      liveness: [95, 96],
      executionReliability: [51, 54],
      outcomeQuality: [22, 27],
      reputation: [5, 9],
      safety: [96, 96],
    },
    price: '$3 / mo',
    priceModel: 'Subscription, billed monthly',
    settlementAsset: '$U',
    supportsX402: true,
    capabilities: [
      {
        name: 'Watch range',
        does: 'Tracks where the price sits inside your position.',
        permissions: ['read_position'],
      },
      {
        name: 'Rebalance',
        does: 'Withdraws and re-mints the position around the current price.',
        permissions: ['manage_liquidity', 'spend_bnb'],
      },
    ],
    enforcement: [
      {
        label: 'Can only call the PancakeSwap v3 position manager',
        tier: 'T0',
        enforcedBy: 'SmartSession:UniversalActionPolicy',
        verified: true,
      },
      {
        label: 'Never more than $120 a month',
        tier: 'T2',
        enforcedBy: 'aiki:policy-service',
        verified: true,
        caveat:
          'A renewing cap is counted by AiKi, not by a contract. No periodic enforcer exists on either side, so this is the weakest line in the mandate.',
      },
      {
        label: 'At most 6 rebalances a day',
        tier: 'T2',
        enforcedBy: 'aiki:policy-service',
        verified: true,
        caveat:
          'Counted by AiKi before relaying, not by a contract. A compromised AiKi could not stop it.',
      },
    ],
    risks: [
      {
        label: 'Rebalancing realises impermanent loss',
        severity: 'warn',
        detail:
          'Every rebalance closes the old range at current prices. In a trending market that is a real loss, and it is the intended behaviour, not a fault.',
      },
    ],
    evidence: [
      {
        cls: 'B',
        count: 96,
        summary: 'AiKi probes for capability, liveness and impostor detection.',
      },
      { cls: 'A', count: 54, summary: 'On-chain actions, all finalised.' },
      { cls: 'D', count: 9, summary: 'Registry feedback. Ingested, weighted near zero.' },
    ],
  },

  yieldmax: {
    key: 'yieldmax',
    spends: [USDT],
    tagline: 'Moves idle assets into the best rate it can verify, with receipts.',
    owner: '0x77b0e4a9c1d35f826b4e07a9c2f81d63e5a04b19',
    ownerVerified: true,
    agentWalletProven: false,
    tokenId: '39204',
    registeredAt: '2026-05-27T08:44:00Z',
    uriScheme: 'ipfs',
    reciprocalProofVerified: false,
    supportedTrust: [],
    ownershipTransfers: 1,
    liveness: {
      state: 'LIVE',
      detail: 'Answers differently for different assets.',
      lastProbeAt: OBSERVED,
      p95LatencyMs: 1180,
    },
    checks: [55, 61],
    components: {
      liveness: [58, 61],
      executionReliability: [24, 28],
      outcomeQuality: [11, 16],
      reputation: [2, 6],
      safety: [61, 61],
    },
    price: '0.4% of gain',
    priceModel: 'Performance fee, charged on realised gain only',
    settlementAsset: '$U',
    supportsX402: true,
    capabilities: [
      {
        name: 'Compare rates',
        does: 'Reads supply rates across Venus and Radiant.',
        permissions: ['read_position'],
      },
      {
        name: 'Move funds',
        does: 'Withdraws from one market and supplies to another.',
        permissions: ['move_funds', 'spend_usdt'],
      },
    ],
    enforcement: [
      {
        label: 'Can only call Venus and Radiant markets',
        tier: 'T0',
        enforcedBy: 'SmartSession:UniversalActionPolicy',
        verified: true,
      },
      {
        label: 'Never more than $500 in total',
        tier: 'T0',
        enforcedBy: 'SmartSession:spendLimit',
        verified: true,
        caveat: 'This one is a lifetime cap. It does not refill each month.',
      },
      {
        label: 'Asks you before any move over $100',
        tier: 'T2',
        enforcedBy: 'aiki:policy-service',
        verified: true,
        caveat: 'Held by AiKi, not by a contract.',
      },
    ],
    risks: [
      {
        label: 'Agent wallet is not proven',
        severity: 'warn',
        detail:
          'The owner has not signed to prove control of the wallet this agent acts from. The registry entry names it; nothing verifies it.',
      },
      {
        label: 'Identity changed hands once',
        severity: 'info',
        detail:
          'Transferred on 12 July 2026. Evidence gathered before that date is held separately and is not counted toward the current score.',
      },
    ],
    evidence: [
      { cls: 'B', count: 61, summary: 'AiKi probes since the transfer.' },
      { cls: 'A', count: 28, summary: 'On-chain actions, all finalised.' },
      { cls: 'D', count: 6, summary: 'Registry feedback. Ingested, weighted near zero.' },
    ],
  },

  gridly: {
    key: 'gridly',
    spends: [WBNB],
    tagline: 'Runs a grid strategy between two prices you set yourself.',
    owner: '0x1d93c807ae62f5b40c37e8d1962af5730b8c4e2d',
    ownerVerified: true,
    agentWalletProven: true,
    tokenId: '44880',
    registeredAt: '2026-05-02T17:20:00Z',
    uriScheme: 'https',
    reciprocalProofVerified: false,
    supportedTrust: ['feedback'],
    ownershipTransfers: 0,
    liveness: {
      state: 'LIVE',
      detail: 'Answers differently for different grids.',
      lastProbeAt: OBSERVED,
      p95LatencyMs: 540,
    },
    checks: [43, 48],
    components: {
      liveness: [47, 48],
      executionReliability: [31, 34],
      outcomeQuality: [9, 15],
      reputation: [3, 7],
      safety: [48, 48],
    },
    price: '$0.12 / run',
    priceModel: 'Per action, charged when an order is placed',
    settlementAsset: '$U',
    supportsX402: true,
    capabilities: [
      {
        name: 'Place grid orders',
        does: 'Places buy and sell orders at even steps between your two prices.',
        permissions: ['place_order', 'spend_bnb'],
      },
      {
        name: 'Rebalance',
        does: 'Replaces filled orders to keep the grid whole.',
        permissions: ['place_order'],
      },
    ],
    enforcement: [
      {
        label: 'Can only call PancakeSwap routers',
        tier: 'T0',
        enforcedBy: 'SmartSession:UniversalActionPolicy',
        verified: true,
      },
      {
        label: 'Never more than $120 a month',
        tier: 'T2',
        enforcedBy: 'aiki:policy-service',
        verified: true,
        caveat:
          'A renewing cap is counted by AiKi, not by a contract. No periodic enforcer exists on either side, so this is the weakest line in the mandate.',
      },
      {
        label: 'Only trades between $580 and $640',
        tier: 'T2',
        enforcedBy: 'aiki:policy-service',
        verified: true,
        caveat: 'Price bounds are checked by AiKi before relaying. No contract holds them.',
      },
    ],
    risks: [
      {
        label: 'No reciprocal proof',
        severity: 'warn',
        detail:
          'The endpoint this agent declares does not serve a matching /.well-known file, so nothing links the domain back to the registry entry. About 0.04% of agents on BSC do.',
      },
      {
        label: 'A grid loses money in a trend',
        severity: 'info',
        detail:
          'Grids profit from oscillation. If price leaves your range and stays out, the position sits one-sided until you move it.',
      },
    ],
    evidence: [
      {
        cls: 'B',
        count: 48,
        summary: 'AiKi probes for capability, liveness and impostor detection.',
      },
      { cls: 'A', count: 34, summary: 'On-chain actions, all finalised.' },
      { cls: 'D', count: 7, summary: 'Registry feedback. Ingested, weighted near zero.' },
    ],
  },

  harbor: {
    key: 'harbor',
    spends: [USDT],
    tagline: 'Moves idle stablecoins and tells you exactly where they went.',
    owner: '0x5e02b7d9184ac36f0e73b1c85d2947af60e13cb7',
    ownerVerified: false,
    agentWalletProven: false,
    tokenId: '61033',
    registeredAt: '2026-07-30T11:05:00Z',
    uriScheme: 'https',
    reciprocalProofVerified: false,
    supportedTrust: [],
    ownershipTransfers: 0,
    liveness: {
      state: 'DEGRADED',
      detail: 'Reachable, but 4 of the last 22 probes timed out.',
      lastProbeAt: OBSERVED,
      p95LatencyMs: 4900,
    },
    checks: [19, 22],
    components: {
      liveness: [18, 22],
      executionReliability: [8, 10],
      outcomeQuality: [3, 6],
      reputation: [0, 1],
      safety: [22, 22],
    },
    price: '$1 / mo',
    priceModel: 'Subscription, billed monthly',
    settlementAsset: '$U',
    supportsX402: false,
    capabilities: [
      {
        name: 'Find a rate',
        does: 'Compares stablecoin supply rates across protocols.',
        permissions: ['read_position'],
      },
      {
        name: 'Move stables',
        does: 'Moves idle USDT or USDC into the market it picked.',
        permissions: ['move_funds', 'spend_usdt'],
      },
    ],
    enforcement: [
      {
        label: 'Can only call allowlisted lending markets',
        tier: 'T0',
        enforcedBy: 'SmartSession:UniversalActionPolicy',
        verified: true,
      },
      {
        label: 'Never more than $60 a month',
        tier: 'T1',
        enforcedBy: 'altana:KeyStore',
        verified: false,
        caveat:
          'The vendor states a custodial signer refuses over-limit calls. CertiK audited their registry, not the contract that would enforce this. We have not read the enforcing code.',
      },
    ],
    risks: [
      {
        label: 'Cap is not enforced on-chain',
        severity: 'critical',
        detail:
          'The monthly cap is held by the vendor’s signer. If that signer is compromised, nothing on the chain stops a larger spend.',
      },
      {
        label: 'Slow and intermittent',
        severity: 'warn',
        detail:
          '4 of the last 22 probes timed out, and the 95th-percentile response is 4.9 seconds. It may miss a fast-moving opportunity.',
      },
      {
        label: 'Owner is unverified',
        severity: 'warn',
        detail: 'Nobody has proven control of the address behind this agent.',
      },
    ],
    evidence: [
      { cls: 'B', count: 22, summary: 'AiKi probes, 4 of which timed out.' },
      { cls: 'A', count: 10, summary: 'On-chain actions, all finalised.' },
      { cls: 'D', count: 1, summary: 'Registry feedback. One entry, no payment proof.' },
    ],
  },

  sentinel: {
    key: 'sentinel',
    spends: [],
    tagline: 'Same job as Guardian and cheaper, but barely tested so far.',
    owner: '0x2ab7f406e91c58d3b70a4e16f9c82d05b3e7401a',
    ownerVerified: true,
    agentWalletProven: true,
    tokenId: '63920',
    registeredAt: '2026-08-14T06:31:00Z',
    uriScheme: 'https',
    reciprocalProofVerified: false,
    supportedTrust: [],
    ownershipTransfers: 0,
    liveness: {
      state: 'LIVE',
      detail: 'Answers differently for different positions.',
      lastProbeAt: OBSERVED,
      p95LatencyMs: 380,
    },
    checks: [6, 7],
    components: {
      liveness: [7, 7],
      executionReliability: [0, 0],
      outcomeQuality: [0, 0],
      reputation: [0, 0],
      safety: [7, 7],
    },
    price: '$1 / mo',
    priceModel: 'Subscription, billed monthly',
    settlementAsset: '$U',
    supportsX402: true,
    capabilities: [
      {
        name: 'Watch health factor',
        does: 'Reads your Venus account every 5 minutes.',
        permissions: ['read_position'],
      },
      {
        name: 'Alert',
        does: 'Notifies you. It cannot act, and cannot spend.',
        permissions: ['notify'],
      },
    ],
    enforcement: [
      {
        label: 'Cannot spend anything at all',
        tier: 'T0',
        enforcedBy: 'no session key issued',
        verified: true,
      },
    ],
    risks: [
      {
        label: 'Almost no history',
        severity: 'warn',
        detail:
          'Seven checks over eight days. That is not enough to tell a good agent from a lucky one, and the score says so rather than guessing.',
      },
      {
        label: 'Alerts only',
        severity: 'info',
        detail: 'It will tell you your position is in danger. It will not fix it.',
      },
    ],
    evidence: [{ cls: 'B', count: 7, summary: 'AiKi probes since registration on 14 August.' }],
  },
}
