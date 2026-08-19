# API Contract — the seam

**Status:** FROZEN. Changes require a `contract:` PR and both sides' agreement.
**Version:** `v1`
**Base:** `/v1`

> This document is the boundary between the two of us. The frontend builds against
> these shapes using fixtures from hour one. The backend implements them. Neither
> waits for the other.
>
> **If the UI needs something that isn't here, the contract is wrong — change it,
> don't work around it.**

---

## 0. Rules

- **Nothing is a bare number.** Every score, metric and status carries provenance and confidence. This is the product, not decoration.
- **Money is never a float.** `{ amount: string, asset, decimals }`. Decimals come from the payload, never a constant. *(USDT-BSC is 18, not 6.)*
- **Liveness is an enum, never a boolean.** HTTP 200 is not "live".
- **Every mandate constraint carries its enforcement tier.**
- **Timestamps** are ISO 8601 UTC.
- **IDs** are opaque strings. Never parse them.
- Errors use one envelope (§9).

---

## 1. Shared primitives

```ts
/** Where a fact came from. Attached to anything a user could act on. */
export interface Provenance {
  source: string;            // "aiki:prober" | "chain:bsc" | "8004scan" | "arena" | "provider"
  method: string;            // "capability-probe/v2", "erc8183:JobCompleted"
  observedAt: string;        // ISO 8601 — when we saw it
  validAt?: string;          // when it was true in the world, if different
  evidenceClass: 'A' | 'B' | 'C' | 'D';
  // A = cryptographic/on-chain   B = AiKi-observed
  // C = independent attestation  D = unverified claim
  blockNumber?: number;
  finality?: 'provisional' | 'safe' | 'finalized';
  sourceUrl?: string;
}

/**
 * A measured quantity with its uncertainty. NEVER render `value` without `confidence`.
 * confidence is derived from interval width, not hand-tuned.
 */
export interface Measure {
  value: number;
  confidence: number;            // 0..1
  interval?: [number, number];   // Wilson LB/UB
  sampleSize: number;
  method: string;                // "wilson-lb;z=1.96" — z is pinned
  provenance: Provenance;
}

export interface Money {
  amount: string;      // integer minor units, as a STRING. never a float.
  asset: string;       // "U" | "USDT" | "BNB"
  decimals: number;    // from payload. USDT-BSC = 18.
  assetAddress?: string;
  displayUsd?: string; // convenience only. never used for arithmetic.
}

export interface AgentRef {
  id: string;              // opaque AiKi id
  chainId: number;         // 56
  registry: string;        // 0x8004A169…
  agentId: string;         // ERC-721 tokenId as string
  name: string;
  iconUrl?: string;
}

export type Category =
  | 'health_factor' | 'rebalancing' | 'grid_trading' | 'yield_optimisation' | 'other';
```

### Liveness — the enum that matters

```ts
export type LivenessState =
  | 'LIVE'            // capability handshake succeeded
  | 'DEGRADED'        // reachable, failing some probes
  | 'UNREACHABLE'     // declared endpoint, no response
  | 'IMPOSTOR_STATIC' // identical bytes for valid vs nonsense ID  ← 30% of BSC
  | 'PLACEHOLDER_URL' // unexpanded {template} in the endpoint
  | 'NOT_REMOTE'      // declared, but stdio-only — not network-callable
  | 'DECLARED_ONLY'   // registered, no service declared
  | 'UNPROBED';

export interface Liveness {
  state: LivenessState;
  uptime?: Measure;          // Wilson LB over probes, never a raw ratio
  lastProbeAt?: string;
  lastSuccessAt?: string;
  p95LatencyMs?: number;
  regionsProbed: number;     // multi-region quorum
  detail?: string;           // human-readable reason for the state
  provenance: Provenance;
}
```

> **UI note:** every non-`LIVE` state needs a designed presentation. `IMPOSTOR_STATIC` is a *finding we are proud of*, not an error — it is the thing no competitor detects.

### Enforcement tier — the mandate honesty model

```ts
export type EnforcementTier =
  | 'T0'  // chain enforces. survives compromised AiKi AND compromised agent.
  | 'T1'  // a signer we control refuses. survives a compromised agent only.
  | 'T2'  // backend check before relay. survives an honest-but-buggy agent.
  | 'T3'; // detected after the fact. survives nothing.

export interface EnforcementInfo {
  tier: EnforcementTier;
  enforcedBy: string;     // "SmartSession:UniversalActionPolicy" | "altana:KeyStore" | "aiki:policy-service"
  contractAddress?: string;
  verified: boolean;      // did WE verify the enforcing code, or is it vendor-claimed?
  caveat?: string;        // "spend cap is documented on-chain but unread at source level"
}
```

> **UI note:** render the tier with the same visual weight as the number. A `T1` cap and a `T0` cap must not look identical. This is a differentiator — no competitor will tell a user their cap is a process that can crash.

---

## 2. Intent

```http
POST /v1/intent
```
```ts
interface IntentRequest { text: string; context?: { chainId?: number; walletAddress?: string } }

interface IntentResponse {
  intentId: string;
  parsed: {
    category: Category;
    protocols: string[];         // ["Venus"]
    assets: string[];
    budget?: { maxPerDay?: Money; maxTotal?: Money };
    risk?: { minConfidence?: number };
    autonomy?: 'manual' | 'bounded' | 'autonomous';
    requiredPermissions: string[];
    successCriteria?: string;
  };
  /** Editable by the user. The typed query is inspectable, not a black box. */
  editable: true;
  ambiguities?: { field: string; question: string; options?: string[] }[];
}
```

---

## 3. Discovery

```http
POST /v1/search
```
```ts
interface SearchRequest {
  intentId?: string;
  query?: string;
  filters?: {
    category?: Category; protocols?: string[]; assets?: string[];
    liveness?: LivenessState[];      // default: ['LIVE','DEGRADED']
    minConfidence?: number;
    maxPricePerTask?: Money;
    requiredEnforcementTier?: EnforcementTier;
  };
  sort?: 'relevance' | 'proof_score' | 'price' | 'liveness';
  cursor?: string; limit?: number;   // default 20, max 100
}

interface SearchResponse {
  results: SearchResult[];
  nextCursor?: string;
  total: number;
  /** Honesty block — rendered in the UI, not hidden in a tooltip. */
  coverage: {
    indexedAgents: number;      // ~269,718
    matchedBeforeFilters: number;
    excludedUnverified: number; // how many we hid, and why
    exclusionReasons: Record<LivenessState, number>;
  };
}

interface SearchResult {
  agent: AgentRef;
  category: Category;
  proofScore: Measure;
  liveness: Liveness;
  priceFrom?: Money;
  /** Why this ranked here. Machine-readable + human string. */
  reasons: { code: string; label: string; weight: number }[];
  warnings?: { code: string; label: string; severity: 'info'|'warn'|'critical' }[];
  sponsored: false;   // if this ever becomes true it MUST be visually distinct
}
```

---

## 4. Passport

```http
GET /v1/agents/{agentId}/passport
```
```ts
interface Passport {
  agent: AgentRef;
  owner: { address: string; verified: boolean; agentWalletProven: boolean };
  // agentWalletProven is the ONLY cryptographically proven field in ERC-8004

  proofScore: Measure;
  components: {
    liveness: Measure; executionReliability: Measure; outcomeQuality: Measure;
    reputation: Measure; safety: Measure;
  };

  liveness: Liveness;

  identity: {
    registry: string; tokenId: string;
    registrationFile: {
      resolved: boolean;
      uriScheme: 'https' | 'ipfs' | 'data';   // 'data' resolves with zero I/O — weak signal
      reciprocalProofVerified: boolean;       // /.well-known — only 0.04% of agents have this
      supportedTrust: string[];               // empty ⇒ discovery only, not trust
    };
    ownershipTransfers: number;   // transfers reset evidence confidence
    createdAt: string;
  };

  capabilities: { name: string; category: Category; protocols: string[];
                  inputSchema?: unknown; outputSchema?: unknown;
                  requiredPermissions: string[]; }[];

  economics: { priceModel: 'per_task'|'per_call'|'subscription'|'escrow'|'unknown';
               price?: Money; settlementAsset: string; supportsX402: boolean; };

  performance?: { category: Category; metrics: Record<string, Measure>;
                  baselineComparison?: { baseline: string; delta: Measure }; }[];
                  // ALWAYS relative to a baseline. never absolute PnL.

  evidence: { class: 'A'|'B'|'C'|'D'; count: number; latestAt: string; summary: string }[];
  risks: { code: string; label: string; severity: 'info'|'warn'|'critical'; detail: string }[];
  // e.g. commerce proxy is upgradeable/pausable/owner-controlled

  updatedAt: string;
}
```

---

## 5. Compare & Arena

```http
POST /v1/compare        { agentIds: string[]; category: Category }
GET  /v1/arena/leaderboards?category=…
GET  /v1/arena/runs/{runId}
```
```ts
interface CompareResponse {
  category: Category;
  agents: AgentRef[];
  rows: { metric: string; label: string; unit?: string;
          values: (Measure | null)[];          // null = no evidence. render as such.
          better: 'higher' | 'lower'; }[];
  /** THE critical field. When true, the UI must say so instead of implying a winner. */
  indistinguishable: boolean;
  indistinguishableReason?: string;  // "overlapping intervals at n=12"
}

interface ArenaRun {
  runId: string; agent: AgentRef; scenarioId: string; scenarioVersion: string;
  forkBlock: number;
  /** Honest reproducibility. Agent-internal LLM sampling is NOT controllable. */
  pinned: { chainState: boolean; prices: boolean; clock: boolean;
            externalHttp: boolean; agentInternals: false };
  trials: number;
  result: { metrics: Record<string, Measure>;
            baseline: Record<string, number>;
            vsBaseline: Record<string, Measure> };
  costUsd: string;
  startedAt: string; completedAt: string;
}
```

---

## 6. Quote → Mandate → Job

```http
POST /v1/quotes
POST /v1/authorizations
POST /v1/authorizations/{id}/revoke
POST /v1/jobs
GET  /v1/jobs/{id}
GET  /v1/jobs/{id}/events        (SSE)
```
```ts
interface Quote {
  quoteId: string; agent: AgentRef;
  price: Money; platformFee: Money; estimatedGas: Money; total: Money;
  settlementAsset: { symbol: string; address: string; decimals: number;
                     supportsEip3009: boolean; requiresPermit2Approval: boolean };
  // ↑ MUST be shown before authorization. Do not promise USDT then demand $U.
  expiresAt: string;             // ERC-8183 quotes are ~5 min
  protocol: 'erc8183' | 'x402' | 'offchain';
}

interface MandateConstraint {
  kind: 'contract_allowlist' | 'selector_allowlist' | 'asset_scope'
      | 'per_action_cap' | 'session_total_cap' | 'expiry' | 'condition';
  label: string;                 // plain language, shown to the user
  value: unknown;
  enforcement: EnforcementInfo;  // ← per constraint, not per mandate
}

interface CreateAuthorizationRequest {
  quoteId: string;
  constraints: MandateConstraint[];
  approvalMode: 'automatic' | 'notify' | 'approve_above_threshold' | 'approve_every';
  approvalThreshold?: Money;
}

interface Authorization {
  authorizationId: string; agent: AgentRef; status: 'pending'|'active'|'revoked'|'expired';
  constraints: MandateConstraint[];
  /** The weakest tier across all constraints. Headline honesty number. */
  weakestTier: EnforcementTier;
  spent: Money; remaining: Money;
  sessionKey?: { address: string; module: string; txHash: string };
  revokePath: { available: boolean; immediate: boolean; requiresVendor: boolean };
  createdAt: string; expiresAt: string;
}

type JobStatus =
  | 'DRAFT'|'QUOTED'|'AUTHORIZED'|'FUNDED'|'DISPATCHED'|'RUNNING'
  | 'SUBMITTED'|'EVALUATING'|'COMPLETED'|'SETTLED'
  | 'REJECTED'|'DISPUTED'|'REFUNDED'|'EXPIRED'|'CANCELLED';

interface Job {
  jobId: string; status: JobStatus; agent: AgentRef;
  authorizationId: string; quote: Quote;
  onchain?: { protocol: 'erc8183'; contractJobId: string; txHashes: string[] };
  spent: Money;
  currentStep?: string;
  nextTrigger?: { kind: 'schedule'|'condition'; description: string; at?: string };
  receiptId?: string;
  createdAt: string; updatedAt: string;
}
```

### Job event stream (SSE)

```ts
type JobEvent =
  | { type: 'status';   at: string; status: JobStatus }
  | { type: 'step';     at: string; label: string; detail?: string }
  | { type: 'policy';   at: string; decision: 'allow'|'deny'; rule: string; reason: string }
  | { type: 'onchain';  at: string; txHash: string; action: string; gas: Money }
  | { type: 'spend';    at: string; amount: Money; runningTotal: Money }
  | { type: 'approval_required'; at: string; approvalId: string;
      prompt: string; amount: Money; expiresAt: string }
  | { type: 'error';    at: string; code: string; message: string; retryable: boolean };
```

> **UI note:** this stream *is* Mission Control. `policy` events showing a **denial** are the most valuable thing on screen — they are the safety layer visibly working. Design for them, don't hide them.

---

## 7. Receipt

```ts
interface Receipt {
  receiptId: string; jobId: string;
  agent: AgentRef; agentVersion: string;
  /** Cryptographically binds the work to the authority it acted under (AP2 pattern). */
  mandateHash: string;
  authorizationId: string;
  actions: { type: string; txHash?: string; policyDecision: 'allow'|'deny';
             at: string; gas?: Money }[];
  cost: { provider: Money; platform: Money; network: Money; total: Money };
  output?: { artifactHash: string; artifactUrl?: string; summary: string };
  evaluation?: { status: 'accepted'|'rejected'; evaluator: string;
                 evaluatorVersion: string; score?: Measure };
  settlement?: { status: string; txHash?: string; amount: Money };
  /** SCITT (RFC 9943) / COSE Receipts (RFC 9942) profile — externally verifiable. */
  signature: { alg: string; value: string; verifyUrl: string };
  startedAt: string; completedAt: string;
}
```

---

## 8. Ecosystem stats — the honesty dashboard

```http
GET /v1/stats
```
```ts
interface EcosystemStats {
  indexed: { totalAgents: number; bscAgents: number; lastIndexedBlock: number;
             lastIndexedAt: string };
  probed:  { agentsProbed: number;
             byState: Record<LivenessState, number>;   // the headline finding
             lastProbeSweepAt: string };
  reputation: { totalFeedback: number; withPaymentProof: number;
                sybilFlaggedPct: number; uniqueReviewers: number };
  categories: Record<Category, { agents: number; live: number }>;
  /** We correct BNB's own stale stat here. Scores Data Quality points. */
  corrections?: { claim: string; actual: string; source: string }[];
}
```

---

## 9. Errors, auth, conventions

```ts
interface ApiError {
  error: { code: string; message: string; retryable: boolean;
           details?: unknown; requestId: string };
}
```

| HTTP | When |
|---|---|
| 400 | validation |
| 401 / 403 | auth |
| 404 | not found |
| 409 | state conflict (e.g. job already funded) |
| 422 | policy rejected the request |
| 429 | rate limited — `Retry-After` set |
| 503 | adapter down — response includes last-known data + `staleAt` |

**503 is not a failure page.** Degrade to last-known evidence with a visible freshness timestamp. Never fabricate "live".

- **Idempotency:** `Idempotency-Key` header **required** on `POST /v1/jobs`, `/v1/authorizations`, `/v1/payments`.
- **Auth:** `Authorization: Bearer <jwt>`. Public reads (search, passport, stats) need no auth.
- **Pagination:** opaque `cursor`. Never numbered pages.
- **Correlation:** every response carries `X-Request-Id`.

---

## 10. Fixtures — how the frontend never blocks

`packages/contracts/` ships types **and** fixtures:

```
packages/contracts/
  src/types.ts          ← this document, as code
  src/fixtures/
    search.ts           realistic results incl. IMPOSTOR_STATIC and low-confidence
    passport.ts         one strong agent, one thin-evidence agent, one risky
    compare.ts          includes an `indistinguishable: true` case
    job-events.ts       full SSE sequence incl. a policy DENY and an approval
    receipt.ts
  src/mock-server.ts    serves every endpoint from fixtures
```

```bash
pnpm mock            # localhost:4000, full API from fixtures
pnpm dev             # web app pointed at the mock
```

**Fixtures deliberately include the ugly cases** — thin evidence, impostor endpoints, statistically indistinguishable comparisons, policy denials. Those states are the product. If the UI only looks good on the happy path, it is not finished.

---

## 11. Build order for this contract

| Endpoint | Needed by | Priority |
|---|---|---|
| `GET /v1/stats` | honesty dashboard | **1** — cheapest, highest demo value |
| `POST /v1/search` | Discover | **1** |
| `GET /v1/agents/{id}/passport` | Passport | **1** |
| `POST /v1/compare` | Compare | 2 |
| `POST /v1/quotes` + `/authorizations` | Mandate Builder | 2 |
| `POST /v1/jobs` + SSE | Mission Control | 3 |
| `GET /v1/receipts/{id}` | Receipt | 3 |
| `/v1/arena/*` | Arena | 4 |
| `POST /v1/intent` | Intent router | 4 — UI can ship with category browse first |
