/**
 * Fixtures for the mock server and for UI development.
 *
 * These deliberately include the UGLY cases — thin evidence, impostor endpoints,
 * statistically indistinguishable comparisons, policy denials, stale data.
 * Those states are the product. If the UI only looks good on the happy path,
 * it is not finished.
 *
 * Agent names and ids are seeded from real 8004scan captures (19 Aug 2026):
 * see src/fixtures/_real/. `Agent #270263` is a genuine registry entry — minted
 * with a null description, no protocols and zero feedback. That is the canonical
 * thin-evidence case and it is extremely common.
 */

import type {
  Authorization,
  CompareResponse,
  EcosystemStats,
  JobEvent,
  Liveness,
  Measure,
  Money,
  Passport,
  Provenance,
  Quote,
  Receipt,
  SearchResponse,
} from './types.js'

const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
const U_TOKEN = '0xcE24439F2D9C6a2289F741120FE202248B666666'
const NOW = '2026-08-19T12:40:00Z'

// ── helpers ──────────────────────────────────────────────────────────────────

const prov = (
  source: string,
  evidenceClass: Provenance['evidenceClass'],
  method: string,
  extra: Partial<Provenance> = {},
): Provenance => ({ source, method, observedAt: NOW, evidenceClass, ...extra })

/** Wilson lower bound — the same formula the backend uses. z is pinned. */
export const Z = 1.96
export function wilsonLb(successes: number, trials: number, z = Z): number {
  if (trials === 0) return 0
  const p = successes / trials
  const d = 1 + (z * z) / trials
  const c = p + (z * z) / (2 * trials)
  const m = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))
  return (c - m) / d
}

function measure(successes: number, trials: number, source = 'aiki:prober'): Measure {
  const lb = wilsonLb(successes, trials)
  const ub = trials === 0 ? 1 : Math.min(1, successes / trials + (1 - lb) * 0.5)
  return {
    value: Math.round(lb * 1000) / 10,
    confidence: trials === 0 ? 0 : Math.max(0, 1 - (ub - lb)),
    interval: [Math.round(lb * 1000) / 10, Math.round(ub * 1000) / 10],
    sampleSize: trials,
    method: `wilson-lb;z=${Z}`,
    provenance: prov(source, 'B', 'capability-probe/v2'),
  }
}

// Note: with exactOptionalPropertyTypes an optional field must be OMITTED, not
// set to undefined — hence the conditional spread rather than a ternary.
const money = (amount: string, asset = 'U', decimals = 18): Money => ({
  amount,
  asset,
  decimals,
  ...(asset === 'U' ? { assetAddress: U_TOKEN } : {}),
})

// ── agents ───────────────────────────────────────────────────────────────────

/** Well-evidenced. Lower score than GUARDIAN_THIN but far more confidence. */
export const AGENT_STRONG = {
  id: 'agt_rangepilot',
  chainId: 56,
  registry: REGISTRY,
  agentId: '241188',
  name: 'RangePilot',
}

/** Real registry entry: null description, no protocols, zero feedback. */
export const AGENT_THIN = {
  id: 'agt_270263',
  chainId: 56,
  registry: REGISTRY,
  agentId: '270263',
  name: 'Agent #270263',
}

/** The 30%-of-BSC case: 200 OK, byte-identical for any input. */
export const AGENT_IMPOSTOR = {
  id: 'agt_impostor',
  chainId: 56,
  registry: REGISTRY,
  agentId: '269666',
  name: 'EvoEvo Agent',
}

export const AGENT_GUARDIAN = {
  id: 'agt_guardian',
  chainId: 56,
  registry: REGISTRY,
  agentId: '238104',
  name: 'Venus Guardian',
}

// ── liveness ─────────────────────────────────────────────────────────────────

export const LIVENESS_LIVE: Liveness = {
  state: 'LIVE',
  uptime: measure(998, 1000),
  lastProbeAt: NOW,
  lastSuccessAt: NOW,
  p95LatencyMs: 410,
  regionsProbed: 3,
  provenance: prov('aiki:prober', 'B', 'capability-probe/v2'),
}

export const LIVENESS_IMPOSTOR: Liveness = {
  state: 'IMPOSTOR_STATIC',
  lastProbeAt: NOW,
  regionsProbed: 3,
  detail:
    'Returns byte-identical responses (MD5 2067c4db…) for a valid id, a nonsense id, and a non-numeric id. This is a static page, not an agent service.',
  provenance: prov('aiki:prober', 'B', 'impostor-detect/D1'),
}

export const LIVENESS_UNPROBED: Liveness = {
  state: 'UNPROBED',
  regionsProbed: 0,
  detail: 'Registered 26 minutes ago. Not yet probed.',
  provenance: prov('chain:bsc', 'A', 'erc8004:Registered'),
}

// ── search ───────────────────────────────────────────────────────────────────

export const SEARCH_RESPONSE: SearchResponse = {
  results: [
    {
      agent: AGENT_STRONG,
      category: 'rebalancing',
      proofScore: measure(89, 104),
      liveness: LIVENESS_LIVE,
      priceFrom: money('120000000000000000'),
      reasons: [
        { code: 'category_fit', label: 'Built for PancakeSwap v3 LP rebalancing', weight: 0.34 },
        { code: 'strong_evidence', label: '104 verified executions', weight: 0.31 },
        { code: 'liveness', label: 'Live, 99.8% over 1000 probes', weight: 0.2 },
      ],
      sponsored: false,
    },
    {
      agent: AGENT_THIN,
      category: 'other',
      // 4 of 4 — a perfect record that means nothing.
      proofScore: measure(4, 4),
      liveness: LIVENESS_UNPROBED,
      reasons: [{ code: 'new', label: 'Registered today, no track record', weight: 0.05 }],
      warnings: [
        { code: 'thin_evidence', label: 'Only 4 observations', severity: 'warn' },
        { code: 'no_manifest', label: 'No services declared', severity: 'warn' },
      ],
      sponsored: false,
    },
    {
      agent: AGENT_IMPOSTOR,
      category: 'other',
      proofScore: measure(0, 12),
      liveness: LIVENESS_IMPOSTOR,
      reasons: [],
      warnings: [
        {
          code: 'impostor_static',
          label: 'Endpoint is not agent-specific',
          severity: 'critical',
        },
      ],
      sponsored: false,
    },
  ],
  total: 3,
  coverage: {
    indexedAgents: 270263,
    matchedBeforeFilters: 40,
    excludedUnverified: 37,
    exclusionReasons: {
      IMPOSTOR_STATIC: 22,
      DECLARED_ONLY: 9,
      UNREACHABLE: 4,
      PLACEHOLDER_URL: 2,
    },
  },
}

// ── passport ─────────────────────────────────────────────────────────────────

export const PASSPORT_STRONG: Passport = {
  agent: AGENT_STRONG,
  owner: {
    address: '0xc5478f275f9aab845117fbdbd9c8d9f7bef8d928',
    verified: true,
    agentWalletProven: true,
  },
  proofScore: measure(89, 104),
  components: {
    liveness: measure(998, 1000),
    executionReliability: measure(101, 104),
    outcomeQuality: measure(31, 40),
    reputation: measure(2, 3),
    safety: measure(104, 104),
  },
  liveness: LIVENESS_LIVE,
  identity: {
    registry: REGISTRY,
    tokenId: '241188',
    registrationFile: {
      resolved: true,
      uriScheme: 'https',
      reciprocalProofVerified: true,
      supportedTrust: ['reputation', 'crypto-economic'],
    },
    ownershipTransfers: 0,
    createdAt: '2026-05-02T09:14:00Z',
  },
  capabilities: [
    {
      name: 'rebalance_pancakeswap_v3',
      category: 'rebalancing',
      protocols: ['PancakeSwap'],
      requiredPermissions: ['read_position', 'decrease_liquidity', 'increase_liquidity', 'swap'],
    },
  ],
  economics: {
    priceModel: 'per_task',
    price: money('120000000000000000'),
    settlementAsset: 'U',
    supportsX402: true,
  },
  performance: [
    {
      category: 'rebalancing',
      metrics: { timeInRange: measure(31, 40), netFeeApr: measure(28, 40) },
      baselineComparison: { baseline: 'passive LP, same snapshot', delta: measure(31, 40) },
    },
  ],
  evidence: [
    { class: 'A', count: 104, latestAt: NOW, summary: 'Settled ERC-8183 jobs' },
    { class: 'B', count: 1000, latestAt: NOW, summary: 'Liveness probes, 3 regions' },
    { class: 'B', count: 40, latestAt: NOW, summary: 'Arena paired-replay scenarios' },
    { class: 'D', count: 1, latestAt: NOW, summary: 'Self-reported capability claims' },
  ],
  risks: [
    {
      code: 'commerce_proxy_upgradeable',
      label: 'Settlement contract is upgradeable',
      severity: 'info',
      detail:
        'ERC-8183 AgenticCommerce is an upgradeable, pausable, owner-controlled proxy. This is inherited from the protocol, not specific to this agent.',
    },
  ],
  updatedAt: NOW,
}

// ── compare — the indistinguishable case ─────────────────────────────────────

export const COMPARE_INDISTINGUISHABLE: CompareResponse = {
  category: 'grid_trading',
  agents: [AGENT_STRONG, AGENT_GUARDIAN, AGENT_THIN],
  rows: [
    {
      metric: 'realised_pnl_vs_baseline',
      label: 'Return vs passive baseline',
      unit: '%',
      values: [measure(21, 40), measure(19, 38), null],
      better: 'higher',
    },
    {
      metric: 'max_drawdown',
      label: 'Max drawdown',
      unit: '%',
      values: [measure(8, 40), measure(9, 38), null],
      better: 'lower',
    },
  ],
  indistinguishable: true,
  indistinguishableReason:
    'Confidence intervals overlap at n=40 and n=38. Separating a 0.5 Sharpe difference at 5% significance would need far more data than either agent has produced.',
  resolutionPlan:
    'Roughly 6 more weeks of live operation, or 120 additional paired-replay scenarios, would separate these.',
}

// ── quote & mandate ──────────────────────────────────────────────────────────

export const QUOTE: Quote = {
  quoteId: 'qt_01J8',
  agent: AGENT_GUARDIAN,
  price: money('120000000000000000'),
  platformFee: money('6000000000000000'),
  estimatedGas: money('5500000000000000'),
  total: money('131500000000000000'),
  settlementAsset: {
    symbol: 'U',
    address: U_TOKEN,
    decimals: 18,
    supportsEip3009: true,
    requiresPermit2Approval: false,
  },
  expiresAt: '2026-08-19T12:45:00Z',
  protocol: 'erc8183',
}

export const AUTHORIZATION: Authorization = {
  authorizationId: 'auth_01J8',
  agent: AGENT_GUARDIAN,
  status: 'active',
  constraints: [
    {
      kind: 'contract_allowlist',
      label: 'May only call Venus and PancakeSwap',
      value: ['0xfD36E2c2a6789Db23113685031d7F16329158384'],
      enforcement: {
        tier: 'T0',
        enforcedBy: 'SmartSession:UniversalActionPolicy',
        contractAddress: '0x00000000008bDABA73cD9815d79069c247Eb4bDA',
        verified: true,
      },
    },
    {
      kind: 'session_total_cap',
      label: 'Maximum total spend',
      value: money('250000000000000000000'),
      // Lifetime, not renewing — the shipping policy module has no time window.
      period: 'total',
      enforcement: {
        tier: 'T0',
        enforcedBy: 'SmartSession:ERC20SpendingLimitPolicy',
        verified: true,
        caveat: 'Lifetime cap. Does not renew — a new session is required after depletion.',
      },
    },
    {
      kind: 'condition',
      label: 'Only acts when health factor drops below 1.25',
      value: { metric: 'health_factor', op: 'lt', threshold: 1.25 },
      enforcement: {
        tier: 'T2',
        enforcedBy: 'aiki:policy-service',
        verified: true,
        caveat: 'Trigger condition is evaluated by AiKi, not by a contract.',
      },
    },
  ],
  weakestTier: 'T2',
  spent: money('18000000000000000000'),
  remaining: money('232000000000000000000'),
  sessionKey: {
    address: '0x9a1f…',
    module: 'SmartSession',
    txHash: '0xabc123…',
  },
  revokePath: { available: true, immediate: true, requiresVendor: false },
  createdAt: '2026-08-19T09:00:00Z',
  expiresAt: '2026-09-18T09:00:00Z',
}

// ── job events — includes a DENY and an approval ─────────────────────────────

export const JOB_EVENTS: JobEvent[] = [
  { type: 'status', at: '2026-08-19T12:30:00Z', status: 'DISPATCHED' },
  { type: 'step', at: '2026-08-19T12:30:02Z', label: 'Reading Venus position' },
  { type: 'step', at: '2026-08-19T12:30:05Z', label: 'Health factor 1.21 — below threshold' },
  {
    type: 'policy',
    at: '2026-08-19T12:30:07Z',
    decision: 'deny',
    rule: 'contract_allowlist',
    reason: 'Agent attempted to call an address outside the allowlist. Blocked on-chain.',
  },
  { type: 'step', at: '2026-08-19T12:30:09Z', label: 'Retrying via allowed route' },
  {
    type: 'policy',
    at: '2026-08-19T12:30:11Z',
    decision: 'allow',
    rule: 'per_action_cap',
    reason: 'Repay 180 U is within the 250 U session cap.',
  },
  {
    type: 'approval_required',
    at: '2026-08-19T12:30:12Z',
    approvalId: 'apr_01J8',
    prompt: 'Repay 180 U to restore health factor above 1.25?',
    amount: money('180000000000000000000'),
    expiresAt: '2026-08-19T12:40:12Z',
  },
  {
    type: 'onchain',
    at: '2026-08-19T12:31:40Z',
    txHash: '0xdef456…',
    action: 'Venus.repayBorrow',
    gas: money('5500000000000000', 'BNB'),
  },
  {
    type: 'spend',
    at: '2026-08-19T12:31:41Z',
    amount: money('180000000000000000000'),
    runningTotal: money('198000000000000000000'),
  },
  { type: 'status', at: '2026-08-19T12:31:45Z', status: 'COMPLETED' },
]

// ── receipt ──────────────────────────────────────────────────────────────────

export const RECEIPT: Receipt = {
  receiptId: 'rcpt_01J8',
  jobId: 'job_01J8',
  agent: AGENT_GUARDIAN,
  agentVersion: '2.4.1',
  mandateHash: '0x7f3a…',
  authorizationId: 'auth_01J8',
  actions: [
    {
      type: 'Venus.repayBorrow',
      txHash: '0xdef456…',
      policyDecision: 'allow',
      at: '2026-08-19T12:31:40Z',
      gas: money('5500000000000000', 'BNB'),
    },
  ],
  cost: {
    provider: money('120000000000000000'),
    platform: money('6000000000000000'),
    network: money('5500000000000000', 'BNB'),
    total: money('131500000000000000'),
  },
  output: {
    artifactHash: '0x9c2b…',
    summary: 'Health factor restored from 1.21 to 1.42. Liquidation avoided.',
  },
  evaluation: {
    status: 'accepted',
    evaluator: 'objective:health_factor_check',
    evaluatorVersion: '1.2.0',
  },
  settlement: { status: 'settled', txHash: '0xfeed…', amount: money('126000000000000000') },
  signature: {
    alg: 'ES256',
    value: 'MEUCIQ…',
    verifyUrl: 'https://aiki.xyz/verify/rcpt_01J8',
  },
  startedAt: '2026-08-19T12:30:00Z',
  completedAt: '2026-08-19T12:31:45Z',
}

// ── ecosystem stats — real numbers from 19 Aug 2026 ──────────────────────────

export const ECOSYSTEM_STATS: EcosystemStats = {
  indexed: {
    totalAgents: 736076,
    bscAgents: 270263,
    firstIndexedBlock: 79027200,
    lastIndexedBlock: 116864993,
    lastIndexedAt: NOW,
    complete: true,
  },
  probed: {
    agentsProbed: 400,
    byState: {
      LIVE: 0,
      IMPOSTOR_STATIC: 141,
      NOT_REMOTE: 5,
      PLACEHOLDER_URL: 13,
      UNREACHABLE: 1,
      DECLARED_ONLY: 240,
    },
    lastProbeSweepAt: NOW,
  },
  reputation: {
    totalFeedback: 3555861,
    withPaymentProof: 0,
    sybilFlaggedPct: 59.2,
    uniqueReviewers: 402040,
  },
  categories: {
    yield_optimisation: { agents: 132, live: 0 },
    rebalancing: { agents: 40, live: 0 },
    grid_trading: { agents: 10, live: 0 },
    health_factor: { agents: 4, live: 0 },
  },
  corrections: [
    {
      claim: 'BSC accounts for ~60% of ERC-8004 agents across 26 networks',
      actual: '270,263 of 736,076 = 36.7%, across 60 indexed chains',
      source: 'https://8004scan.io/api/v1/public/stats — measured 19 Aug 2026',
    },
  ],
}
