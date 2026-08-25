/**
 * AiKi API contract — v1
 *
 * This file is THE SEAM between apps/web and apps/api. Both build against it.
 * Changing it requires a `contract:` PR and both engineers' agreement.
 *
 * Design rules encoded structurally here, so they cannot be violated by accident:
 *  - No bare numbers. Every measured value carries confidence, sample size and provenance.
 *  - Liveness is an enum, never a boolean. HTTP 200 is not "live".
 *  - Every mandate constraint carries its enforcement tier.
 *  - Money carries explicit decimals. USDT on BSC is 18, not 6.
 *
 * See docs/01-api-contract.md for the prose version and the reasoning.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** ISO 8601 UTC timestamp. */
export type Timestamp = string

/** Opaque server-minted id. Never parse it. */
export type Id = string

/**
 * How strongly a fact is evidenced.
 *  A — cryptographic / on-chain
 *  B — AiKi observed it directly (our probes, our benchmark runs)
 *  C — independent third-party attestation
 *  D — someone claimed it, unverified
 *
 * NOTE: evidence class is not the same as evidence VALUE. On-chain ERC-8004
 * feedback is nominally class A but empirically worthless — 100% of BSC feedback
 * carries no payment proof, and moving an agent past a trust threshold costs
 * about $0.0042. Class A feedback is ingested and weighted near zero.
 */
export type EvidenceClass = 'A' | 'B' | 'C' | 'D'

/** Chain-derived facts carry finality. Only `finalized` feeds scoring unweighted. */
export type Finality = 'provisional' | 'safe' | 'finalized'

/** Where a fact came from. Attached to anything a user could act on. */
export interface Provenance {
  /** e.g. "aiki:prober" | "chain:bsc" | "8004scan" | "arena" | "provider" */
  source: string
  /** Exact procedure and version, e.g. "capability-probe/v2" */
  method: string
  /** When we observed it. */
  observedAt: Timestamp
  /** When it was true in the world, if different from observedAt. */
  validAt?: Timestamp
  evidenceClass: EvidenceClass
  blockNumber?: number
  finality?: Finality
  sourceUrl?: string
}

/**
 * A measured quantity with its uncertainty.
 *
 * NEVER render `value` without also rendering confidence. The UI encodes
 * confidence by changing HOW the number is drawn (precision clamping + interval),
 * never as a second number beside it — users read two numbers as two scores.
 */
export interface Measure {
  value: number
  /** 0..1, derived from interval width. Not a hand-tuned coefficient. */
  confidence: number
  /** Wilson lower/upper bound. */
  interval?: [number, number]
  sampleSize: number
  /** e.g. "wilson-lb;z=1.96" — z is pinned in config and recorded here. */
  method: string
  provenance: Provenance
}

/**
 * Money. Never a float, never a bare number.
 * `amount` is integer minor units as a STRING; `decimals` comes from the payload.
 */
export interface Money {
  amount: string
  /** "U" | "USDT" | "BNB" — $U is AiKi's default settlement asset on BSC. */
  asset: string
  /** From config per token. USDT-BSC is 18. Assuming 6 is wrong by 10^12. */
  decimals: number
  assetAddress?: string
  /** Convenience for display only. Never used for arithmetic. */
  displayUsd?: string
}

export interface AgentRef {
  id: Id
  chainId: number
  /** ERC-8004 IdentityRegistry, e.g. 0x8004A169… on chain 56. */
  registry: string
  /** ERC-721 tokenId as a string. */
  agentId: string
  name: string
  iconUrl?: string
}

export type Category =
  | 'health_factor'
  | 'rebalancing'
  | 'grid_trading'
  | 'yield_optimisation'
  | 'other'

// ─────────────────────────────────────────────────────────────────────────────
// Liveness — the enum that matters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Is this agent online" has seven answers, and the difference between them is
 * the most valuable thing AiKi knows.
 *
 * IMPOSTOR_STATIC is the flagship: an endpoint returning 200 with byte-identical
 * responses regardless of input. It affects roughly 30% of the BSC registry and
 * no competitor detects it. In the UI this is a DISCOVERY, not an error.
 */
export type LivenessState =
  | 'LIVE'
  | 'DEGRADED'
  | 'UNREACHABLE'
  | 'IMPOSTOR_STATIC'
  | 'PLACEHOLDER_URL'
  | 'NOT_REMOTE'
  | 'DECLARED_ONLY'
  | 'UNPROBED'

export interface Liveness {
  state: LivenessState
  /** Wilson lower bound over probes. Never a raw success ratio. */
  uptime?: Measure
  lastProbeAt?: Timestamp
  lastSuccessAt?: Timestamp
  p95LatencyMs?: number
  /** Multi-region quorum: distinguishes network failure from service failure. */
  regionsProbed: number
  /** Human-readable reason for this state. */
  detail?: string
  provenance: Provenance
}

// ─────────────────────────────────────────────────────────────────────────────
// Enforcement — the mandate honesty model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a constraint is actually enforced.
 *  T0 — the chain rejects the call. Survives a compromised AiKi AND agent.
 *  T1 — a signer we control refuses. Survives a compromised agent only.
 *  T2 — backend check before relay. Survives an honest-but-buggy agent.
 *  T3 — detected after the fact. Survives nothing.
 *
 * UI rule (from research: Chrome removed the padlock after only ~11% of users
 * understood it): positive trust badges get ignored, negative indicators change
 * behaviour. So render the STRONG tier quiet and the WEAK tier loud.
 */
export type EnforcementTier = 'T0' | 'T1' | 'T2' | 'T3'

export interface EnforcementInfo {
  tier: EnforcementTier
  /** e.g. "SmartSession:UniversalActionPolicy" | "altana:KeyStore" | "aiki:policy-service" */
  enforcedBy: string
  contractAddress?: string
  /** Did WE verify the enforcing code, or is this vendor-claimed? */
  verified: boolean
  /** e.g. "spend cap documented on-chain but unread at source level" */
  caveat?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent
// ─────────────────────────────────────────────────────────────────────────────

export interface IntentRequest {
  text: string
  context?: { chainId?: number; walletAddress?: string }
}

export interface ParsedIntent {
  category: Category
  protocols: string[]
  assets: string[]
  budget?: { maxPerDay?: Money; maxTotal?: Money }
  risk?: { minConfidence?: number }
  autonomy?: 'manual' | 'bounded' | 'autonomous'
  requiredPermissions: string[]
  successCriteria?: string
}

export interface IntentResponse {
  intentId: Id
  parsed: ParsedIntent
  /** The typed query is inspectable and editable by the user, never a black box. */
  editable: true
  ambiguities?: { field: string; question: string; options?: string[] }[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchFilters {
  category?: Category
  protocols?: string[]
  assets?: string[]
  /** Defaults to ['LIVE','DEGRADED'] — unverified agents are hidden but counted. */
  liveness?: LivenessState[]
  minConfidence?: number
  maxPricePerTask?: Money
  requiredEnforcementTier?: EnforcementTier
}

export interface SearchRequest {
  intentId?: Id
  query?: string
  filters?: SearchFilters
  sort?: 'relevance' | 'proof_score' | 'price' | 'liveness'
  cursor?: string
  /** Default 20, max 100. */
  limit?: number
}

export interface RankReason {
  code: string
  label: string
  weight: number
}

export interface SearchResult {
  agent: AgentRef
  category: Category
  proofScore: Measure
  liveness: Liveness
  priceFrom?: Money
  /** Machine-readable reason codes plus human strings. Never "AI picked this". */
  reasons: RankReason[]
  warnings?: { code: string; label: string; severity: 'info' | 'warn' | 'critical' }[]
  /** If this ever becomes true it MUST be visually distinct and must not affect score. */
  sponsored: false
}

/** Rendered in the UI, not hidden in a tooltip. This is the honesty block. */
export interface SearchCoverage {
  indexedAgents: number
  matchedBeforeFilters: number
  excludedUnverified: number
  exclusionReasons: Partial<Record<LivenessState, number>>
}

export interface SearchResponse {
  results: SearchResult[]
  nextCursor?: string
  total: number
  coverage: SearchCoverage
}

// ─────────────────────────────────────────────────────────────────────────────
// Passport
// ─────────────────────────────────────────────────────────────────────────────

export interface PassportIdentity {
  registry: string
  tokenId: string
  registrationFile: {
    resolved: boolean
    /** `data:` URIs resolve with zero network I/O — a weak signal, not evidence. */
    uriScheme: 'https' | 'ipfs' | 'data'
    /** /.well-known/agent-registration.json bidirectional proof. Only ~0.04% have this. */
    reciprocalProofVerified: boolean
    /** Empty ⇒ ERC-8004 used for discovery only, not trust. */
    supportedTrust: string[]
  }
  /** Identity is a transferable ERC-721. Transfers reset evidence confidence. */
  ownershipTransfers: number
  createdAt: Timestamp
}

export interface PassportCapability {
  name: string
  category: Category
  protocols: string[]
  inputSchema?: unknown
  outputSchema?: unknown
  requiredPermissions: string[]
}

export interface CategoryPerformance {
  category: Category
  metrics: Record<string, Measure>
  /** ALWAYS relative to a baseline. A bare PnL figure is a claim about the month. */
  baselineComparison?: { baseline: string; delta: Measure }
}

export interface Passport {
  agent: AgentRef
  owner: {
    address: string
    verified: boolean
    /** The ONLY cryptographically proven field in ERC-8004 (EIP-712 / ERC-1271). */
    agentWalletProven: boolean
  }
  proofScore: Measure
  components: {
    liveness: Measure
    executionReliability: Measure
    outcomeQuality: Measure
    reputation: Measure
    safety: Measure
  }
  liveness: Liveness
  identity: PassportIdentity
  capabilities: PassportCapability[]
  economics: {
    priceModel: 'per_task' | 'per_call' | 'subscription' | 'escrow' | 'unknown'
    price?: Money
    settlementAsset: string
    supportsX402: boolean
  }
  performance?: CategoryPerformance[]
  evidence: { class: EvidenceClass; count: number; latestAt: Timestamp; summary: string }[]
  /** e.g. "commerce proxy is upgradeable, pausable and owner-controlled" */
  risks: { code: string; label: string; severity: 'info' | 'warn' | 'critical'; detail: string }[]
  updatedAt: Timestamp
}

// ─────────────────────────────────────────────────────────────────────────────
// Compare & Arena
// ─────────────────────────────────────────────────────────────────────────────

export interface CompareRequest {
  agentIds: Id[]
  category: Category
}

export interface CompareRow {
  metric: string
  label: string
  unit?: string
  /** null means no evidence. Render it as such — do not coerce to 0. */
  values: (Measure | null)[]
  better: 'higher' | 'lower'
}

export interface CompareResponse {
  category: Category
  agents: AgentRef[]
  rows: CompareRow[]
  /**
   * THE critical field. Separating two agents differing by 0.5 Sharpe needs ~63
   * years of data. When true the UI must say so rather than imply a winner.
   * Modelled on LMArena's Rank(UB): tied entries share a rank.
   */
  indistinguishable: boolean
  indistinguishableReason?: string
  /** What would break the tie. Turns a non-answer into rigour. */
  resolutionPlan?: string
}

export interface ArenaRun {
  runId: Id
  agent: AgentRef
  scenarioId: string
  scenarioVersion: string
  forkBlock: number
  /**
   * Honest reproducibility. Chain state, prices and clock are pinnable;
   * the agent's own LLM sampling is a third-party endpoint and is NOT.
   */
  pinned: {
    chainState: boolean
    prices: boolean
    clock: boolean
    externalHttp: boolean
    agentInternals: false
  }
  trials: number
  result: {
    metrics: Record<string, Measure>
    baseline: Record<string, number>
    vsBaseline: Record<string, Measure>
  }
  costUsd: string
  startedAt: Timestamp
  completedAt: Timestamp
}

// ─────────────────────────────────────────────────────────────────────────────
// Quote → Mandate → Job
// ─────────────────────────────────────────────────────────────────────────────

export interface SettlementAsset {
  symbol: string
  address: string
  decimals: number
  /** USDT on BSC is false. $U is true. This decides which payment path works. */
  supportsEip3009: boolean
  requiresPermit2Approval: boolean
}

export interface Quote {
  quoteId: Id
  agent: AgentRef
  price: Money
  platformFee: Money
  estimatedGas: Money
  total: Money
  /** MUST be shown before authorization. Do not promise USDT then demand $U. */
  settlementAsset: SettlementAsset
  /** ERC-8183 quotes are typically ~5 minutes. */
  expiresAt: Timestamp
  protocol: 'erc8183' | 'x402' | 'offchain'
}

export type ConstraintKind =
  | 'contract_allowlist'
  | 'selector_allowlist'
  | 'asset_scope'
  | 'per_action_cap'
  | 'session_total_cap'
  | 'expiry'
  | 'condition'

/**
 * Cap period vocabulary borrowed from Privacy.com, which has shipped this to
 * consumers since 2016. `total` is a LIFETIME cap that never refills — visually
 * distinct from a renewing one.
 *
 * All four periods are enforceable at T0 on BSC via the MetaMask Delegation
 * Framework's ERC20PeriodTransferEnforcer, which genuinely resets per period.
 * (Rhinestone's SmartSession policy is lifetime-only — if that path is used
 * instead, only `total` is honest. The enforcement tier carries the difference.)
 */
export type CapPeriod = 'per_transaction' | 'per_month' | 'per_year' | 'total'

export interface MandateConstraint {
  kind: ConstraintKind
  /** Plain language, shown directly to the user. */
  label: string
  value: unknown
  period?: CapPeriod
  /** Per constraint, not per mandate. There is no empty state for this. */
  enforcement: EnforcementInfo
}

export type ApprovalMode = 'automatic' | 'notify' | 'approve_above_threshold' | 'approve_every'

export interface CreateAuthorizationRequest {
  quoteId: Id
  constraints: MandateConstraint[]
  approvalMode: ApprovalMode
  approvalThreshold?: Money
}

export interface Authorization {
  authorizationId: Id
  agent: AgentRef
  status: 'pending' | 'active' | 'revoked' | 'expired'
  constraints: MandateConstraint[]
  /** The weakest tier across all constraints. The headline honesty number. */
  weakestTier: EnforcementTier
  spent: Money
  remaining: Money
  sessionKey?: { address: string; module: string; txHash: string }
  /** Two-speed revoke: pause is instant and weak; revoke is on-chain and strong. */
  revokePath: { available: boolean; immediate: boolean; requiresVendor: boolean }
  createdAt: Timestamp
  expiresAt: Timestamp
}

export type JobStatus =
  | 'DRAFT'
  | 'QUOTED'
  | 'AUTHORIZED'
  | 'FUNDED'
  | 'DISPATCHED'
  | 'RUNNING'
  | 'SUBMITTED'
  | 'EVALUATING'
  | 'COMPLETED'
  | 'SETTLED'
  | 'REJECTED'
  | 'DISPUTED'
  | 'REFUNDED'
  | 'EXPIRED'
  | 'CANCELLED'

export interface Job {
  jobId: Id
  status: JobStatus
  agent: AgentRef
  authorizationId: Id
  quote: Quote
  onchain?: { protocol: 'erc8183'; contractJobId: string; txHashes: string[] }
  spent: Money
  currentStep?: string
  nextTrigger?: { kind: 'schedule' | 'condition'; description: string; at?: Timestamp }
  receiptId?: Id
  createdAt: Timestamp
  updatedAt: Timestamp
}

/**
 * Mission Control's event stream (SSE).
 * A `policy` event with decision 'deny' is the most valuable thing on screen —
 * it is the safety layer visibly working. Design for it, don't bury it.
 */
export type JobEvent =
  | { type: 'status'; at: Timestamp; status: JobStatus }
  | { type: 'step'; at: Timestamp; label: string; detail?: string }
  | {
      type: 'policy'
      at: Timestamp
      decision: 'allow' | 'deny'
      rule: string
      reason: string
    }
  | { type: 'onchain'; at: Timestamp; txHash: string; action: string; gas: Money }
  | { type: 'spend'; at: Timestamp; amount: Money; runningTotal: Money }
  | {
      type: 'approval_required'
      at: Timestamp
      approvalId: Id
      prompt: string
      amount: Money
      expiresAt: Timestamp
    }
  | { type: 'error'; at: Timestamp; code: string; message: string; retryable: boolean }

// ─────────────────────────────────────────────────────────────────────────────
// Receipt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Profile of SCITT (RFC 9943) / COSE Receipts (RFC 9942) rather than a bespoke
 * format, so third parties can verify with off-the-shelf tooling.
 * `mandateHash` binds the work to the authority it acted under (the AP2 pattern).
 */
export interface Receipt {
  receiptId: Id
  jobId: Id
  agent: AgentRef
  agentVersion: string
  mandateHash: string
  authorizationId: Id
  actions: {
    type: string
    txHash?: string
    policyDecision: 'allow' | 'deny'
    at: Timestamp
    gas?: Money
  }[]
  cost: { provider: Money; platform: Money; network: Money; total: Money }
  output?: { artifactHash: string; artifactUrl?: string; summary: string }
  evaluation?: {
    status: 'accepted' | 'rejected'
    evaluator: string
    evaluatorVersion: string
    score?: Measure
  }
  settlement?: { status: string; txHash?: string; amount: Money }
  signature: { alg: string; value: string; verifyUrl: string }
  startedAt: Timestamp
  completedAt: Timestamp
}

// ─────────────────────────────────────────────────────────────────────────────
// Ecosystem stats — the honesty dashboard
// ─────────────────────────────────────────────────────────────────────────────

export interface EcosystemStats {
  /** Null until chain-indexer evidence exists — never derived from probe rows. */
  indexed: {
    totalAgents: number
    bscAgents: number
    lastIndexedBlock: number
    lastIndexedAt: Timestamp
  } | null
  probed: {
    agentsProbed: number
    /** The headline finding. */
    byState: Partial<Record<LivenessState, number>>
    /** Null when nothing has been probed — never an epoch sentinel. */
    lastProbeSweepAt: Timestamp | null
  }
  /** Null until feedback is actually ingested; zeros would claim a measurement. */
  reputation: {
    totalFeedback: number
    withPaymentProof: number
    sybilFlaggedPct: number
    uniqueReviewers: number
  } | null
  categories: Partial<Record<Category, { agents: number; live: number }>>
  /** We correct stale ecosystem statistics here, with sources. */
  corrections?: { claim: string; actual: string; source: string }[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors & freshness
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiError {
  error: {
    code: string
    message: string
    retryable: boolean
    details?: unknown
    requestId: string
  }
}

/**
 * Four data states, not two (modelled on Datadog's NO DATA monitor state).
 * Once a number has been rendered it may NEVER be replaced by a spinner —
 * only by a newer number, or by a demoted state that still shows the old value.
 */
export type DataState = 'LIVE' | 'STALE' | 'NO_DATA' | 'DEGRADED'

export interface Freshness {
  state: DataState
  observedAt?: Timestamp
  /** The source's declared heartbeat — freshness is a contract it publishes. */
  heartbeatMs?: number
  ageMs?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Projected passport — what the evidence API can actually serve today
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The passport as projected purely from stored observations. This is the wire
 * shape of GET /v1/agents/:id/passport and of search results, shared by the
 * API and the frontend so neither can drift from the other.
 *
 * Distinct from `Passport` above deliberately: `Passport` is the full product
 * contract, and serving it today would require inventing the fields we have no
 * evidence for. Every nullable field here is null exactly when unmeasured.
 */
export interface ProjectedCounts {
  successes: number
  trials: number
}

export interface ProjectedRisk {
  code: string
  label: string
  severity: 'info' | 'warn' | 'critical'
  detail: string
}

export interface ProjectedPassport {
  agentId: string
  chainId: number | null
  registry: string | null
  /** From the resolved registration manifest; agents without one have no name. */
  name: string | null
  liveness: LivenessState
  livenessDetail: string | null
  lastProbeAt: Timestamp | null
  p95LatencyMs: number | null
  proofScore: {
    value: number
    confidence: number
    interval: [number, number]
    sampleSize: number
    method: string
  }
  /** Overall: did it answer as an agent, across every probe we ran. */
  checks: ProjectedCounts
  components: {
    liveness: ProjectedCounts
    executionReliability: ProjectedCounts | null
    outcomeQuality: ProjectedCounts | null
    reputation: ProjectedCounts | null
    safety: ProjectedCounts | null
  }
  identity: {
    tokenId: string
    owner: string | null
    createdAt: Timestamp | null
    registrationFile: {
      resolved: boolean | null
      uriScheme: 'https' | 'ipfs' | 'data' | null
      /** True = proven, false = evaluated and absent, null = never evaluated. */
      reciprocalProofVerified: boolean | null
      zeroCost: boolean | null
    }
  }
  risks: ProjectedRisk[]
  evidence: { predicate: string; count: number; latestAt: Timestamp }[]
  /** Null when we hold no observations at all — never an epoch sentinel. */
  updatedAt: Timestamp | null
  insufficientEvidence: boolean
}

export interface ProjectedSearchResponse {
  results: ProjectedPassport[]
  total: number
  coverage: SearchCoverage
}
