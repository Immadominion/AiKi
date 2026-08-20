# AiKi System Architecture

**Status:** derived from verified research. Every design decision below cites the fact that forced it.
**Written:** 18 August 2026, after 15 research topics and three adversarial verification rounds.

---

## 0. The shape of the problem, after research

Research changed three things about the design.

**1. There is no supply.** Zero of 400 sampled BSC agents exposed an invocable endpoint. The four judged categories have 132 / 40 / 10 / **4** matching agents. So AiKi is not primarily a *discovery* problem — it is an *evidence generation* problem with a discovery surface on top.

**2. The scoring layer is already commoditised.** trust8004 and 8004scan both ship confidence-weighted, explainable, multi-dimension scores today, for free. Re-weighting the same worthless inputs is not a product.

**3. The enforcement layer is genuinely achievable.** EIP-7702 has been live on BSC for 17 months; SmartSession and Altana's KeyStore are deployed and audited. T0 cryptographic mandates are real.

> **Therefore the architecture is organised around producing evidence that costs real money to fake, and around authority that the chain — not our backend — enforces.**

---

## 1. Planes

```
┌──────────────────────────────────────────────────────────────┐
│  SURFACES        Web · MCP(2026-07-28) · REST · Telegram      │
└───────────────────────────┬──────────────────────────────────┘
                            │  one canonical backend
┌───────────────────────────▼──────────────────────────────────┐
│  DECISION      Intent → Retrieval → Ranking → Explanation     │
│                Proof Score projection (Wilson/Beta)           │
└───────────────────────────┬──────────────────────────────────┘
┌───────────────────────────▼──────────────────────────────────┐
│  EVIDENCE      append-only bitemporal fact store              │
│                Prober · Arena · Receipt · Provenance          │
└───────────────────────────┬──────────────────────────────────┘
┌───────────────────────────▼──────────────────────────────────┐
│  AUTHORITY     Policy compiler → enforcement tier →           │
│                session grant · revoke · audit                 │
└───────────────────────────┬──────────────────────────────────┘
┌───────────────────────────▼──────────────────────────────────┐
│  COMMERCE      Work order · quote · escrow · settle · receipt │
└───────────────────────────┬──────────────────────────────────┘
┌───────────────────────────▼──────────────────────────────────┐
│  ADAPTERS   Registry · Commerce · Payment · Wallet · Runtime  │
│             Indexer · DeFi · Data                             │
└──────────────────────────────────────────────────────────────┘
```

The **evidence plane is the moat**. Everything above it is a projection; everything below it is replaceable.

---

## 2. Ingestion — constrained by what the chain actually allows

### 2.1 Three hard constraints discovered by measurement

| Constraint | Consequence |
|---|---|
| **`totalSupply()` reverts** — the canonical IdentityRegistry is **not** ERC721Enumerable | A `1..totalSupply()` scan is impossible. **Index `Registered` events.** |
| **`Registered` DOES index agentId and owner** (verified by decoding a live log: `topics=3`) | `Registered(uint256 indexed agentId, string agentURI, address indexed owner)` — agentId is `topics[1]`, owner is `topics[2]`. Per-agent filters DO work. `NewFeedback` still indexes only `tag1`. |
| **`NewFeedback` indexes only `tag1`** — not `agentId`, not `clientAddress` | **Per-agent log filters are impossible.** Index the full stream and shard downstream. |

Plus: `eth_getLogs` is **disabled** on public dataseeds; caps elsewhere run 5k–50k blocks — and at 0.45s/block a 10,000-block window is **75 minutes**.

### 2.2 Design

```
NodeReal archive ($39/mo, archive on all tiers)
   │
   ├─ backfill: chunked, resumable, cap-probing (parse provider error strings
   │            to auto-tune chunk size; caps are a provider property)
   └─ tip: follow `finalized` (lag 2 blocks); reorg bound 8 (turnLength)
   │
   ▼
raw log store ──► decode ──► Observation (append-only)
```

**Canonical topics:**

| Event | topic0 |
|---|---|
| `Registered(uint256,string,address)` | `0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a` |
| `NewFeedback` | `0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc` |

**Contracts (chain 56):**

| | Address |
|---|---|
| IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| AgenticCommerce (8183) | `0xEa4DAa3100A767e86FDed867729ae7446476EBA6` |
| `$U` settlement token | `0xcE24439F2D9C6a2289F741120FE202248B666666` |

⚠️ **Never store a registry address as a chain-agnostic constant.** Adversarial verification flagged this on Altana: addresses differ per chain and a global constant *corrupts silently*. All addresses live in a per-chain config keyed by chain ID, asserted at startup.

**Ordering:** key every event by `(blockNumber, logIndex)`. Use BSC's non-standard **`milliTimestamp`** for wall-clock — the standard `timestamp` is second-resolution and now spans ~2.2 blocks, so 2–3 blocks share a value. Generic EVM indexers drop this field silently.

**Scale:** ~272,500 agents (20 Aug 2026). Registration is BURSTY — a 75-minute window implied ~27,000/day while the agentId delta over 11.5 hours implied ~4,400/day. Never extrapolate a rate from a short window.

---

## 3. Evidence graph — the moat (HP-4)

### 3.1 Bitemporal, append-only

```
Observation {
  observation_id     uuid
  subject            AgentRef            -- (chain_id, registry, agent_id)
  predicate          enum                -- liveness_probe | job_settled | benchmark_run | …
  value              jsonb
  -- three distinct times, never conflated
  valid_at           timestamptz         -- when it was true in the world
  observed_at        timestamptz         -- when we saw it
  recorded_at        timestamptz         -- when we wrote it
  -- provenance
  source             SourceRef           -- who/what observed it
  method             text                -- exact procedure + version
  evidence_class     enum                -- A | B | C | D
  -- chain facts only
  block_number       bigint  NULL
  finality           enum    NULL        -- provisional | safe | finalized
  -- corrections
  supersedes         uuid    NULL
  superseded_reason  text    NULL
}
```

**Invariants:**
1. `INSERT` only. No `UPDATE`, no `DELETE`. A correction is a new row with `supersedes` set.
2. Every fact carries `source` + `method` + `evidence_class`. A fact without provenance is rejected at write time.
3. Chain facts carry `finality`. Only `finalized` facts feed Proof Score unweighted; `provisional` facts are visible but flagged.
4. A reorg **supersedes**; it never mutates.

**Evidence classes** (from the MPSS, now with measured meaning):

| Class | Meaning | On BSC today |
|---|---|---|
| **A** | Cryptographic / on-chain | ERC-8183 settlement, `agentWallet` proof |
| **B** | AiKi-observed | Probes, Arena runs — **the class AiKi manufactures** |
| **C** | Independent attestation | Validator responses, A2A card JWS |
| **D** | Claims | Registration files, self-reported metrics |

> On-chain ERC-8004 feedback is *nominally* Class A but is **empirically worthless** — 100% lacks interaction proof, $0.0042 to forge. It is ingested, and it is weighted near zero. **Evidence class is not the same as evidence value**, and the model must carry both.

### 3.2 Projections

Passport and Proof Score are **materialised views**, rebuildable from the log. Every projection records `scoring_version`. The invariant: *recomputing with pinned `scoring_version` and evidence-as-of-time reproduces a historical score exactly.* That is what makes appeals, audits and ranking debugging possible.

---

## 4. Verification — the differentiator

The competitive teardown is blunt: scoring is commoditised, **evidence generation is not**. This subsystem is the product.

### 4.1 Detection rules — each derived from an observed failure

| # | Rule | Catches |
|---|---|---|
| **D1** | Probe with a **valid ID and a nonsense ID**. Byte-identical response ⇒ `IMPOSTOR_STATIC`. | 141/147 "live" endpoints — **30% of BSC** |
| **D2** | Reject endpoints containing unexpanded `{…}` **before indexing** | The `{agentId}` template bug — a *documented-workflow* hazard |
| **D3** | `transport: "stdio"` ⇒ declared-but-not-invocable. A distinct state from live. | q402 descriptors |
| **D4** | `data:` URIs resolve with zero I/O — **exclude from "resolvable" metrics** | 58.3% inflation |
| **D5** | Require content-type + capability handshake. **HTTP 200 is not liveness.** | all of the above |
| **D6** | Reviewer concentration, first-funder clustering, **degenerate score distributions** (66% identical value) | wash reputation |
| **D7** | Weight feedback by payment proof / task linkage — **which zeroes 100% of BSC feedback** | ungrounded reputation |
| **D8** | **Reciprocal proof**: fetch `/.well-known/agent-registration.json`, require `agentRegistry` + `agentId` to match on-chain | **0.04% adoption — near-free, high-signal** |
| **D9** | **Verify A2A card JWS** (detached, RFC 8785 canonical, defaults removed, `signatures` excluded) | unsigned/forged cards |

**D1 is the flagship.** It was discovered by measurement, it invalidates the headline liveness number of every competitor doing naive 200-checks, and it is cheap.

### 4.2 Prober

- Multi-region quorum — distinguishes *network* failure from *service* failure so agents aren't penalised for our connectivity.
- Availability reported at the **Wilson lower bound**, not the point estimate.
- Every probe writes an Observation. Failures are evidence (MPSS §10.4).

### 4.3 Wash-trade detection

Iterative SCC counting on the counterparty multigraph (threshold: SCCs occurring ≥100), then linear-time volume matching. Strictly better than the arXiv first-funder heuristic, which over-counts exchange-funded accounts. **AiKi can do better sybil detection than the research it cites.**

---

## 5. Proof Score

```
component_score = WilsonLB(successes, trials, z)      -- z PINNED in config
accumulated     = Beta(α₀+s, β₀+f) with λ forgetting  -- composes, ages
stabilised      = EB_shrink(accumulated, cohort_prior) -- required at n<10
confidence      = 1 - interval_width
```

⚠️ **Pin `z` explicitly and record it in `scoring_version`.** Adversarial verification flagged a real hazard: a spec saying `z=1.6449` against a golden table computed at `z=1.96` deadlocks the test suite on day one with every fixture off by 3–9 points.

| Component | Method | Class |
|---|---|---|
| Liveness | Wilson LB over probes, Beta-decayed | B |
| Execution reliability | Wilson LB over settled jobs | A/B |
| **Outcome quality** | **paired-replay win rate + interval** | **B** |
| Reputation | Beta over sybil-filtered clients via `getSummary(agentId, clientAddresses, …)` | A, heavily discounted |
| Safety | policy denials, escalation attempts | B |

**Publish the method, withhold the weights and the held-out set** (HP-6). Wilson and Beta have no free parameters, so publishing the method costs nothing — an agent can only raise its score by actually being more reliable.

`getSummary`'s `clientAddresses` filter is the on-chain hook for sybil-filtered reputation. Use it.

---

## 6. Authority — the mandate layer (HP-3)

### 6.1 Every constraint carries its enforcement tier

| Tier | Enforced by | Survives | Available on BSC |
|---|---|---|---|
| **T0** | the chain | compromised AiKi **and** agent | Altana KeyStore; SmartSession + policies |
| **T1** | a signer AiKi controls | compromised agent | BNB Agent Studio pattern |
| **T2** | backend check pre-relay | buggy agent | naive relayers |
| **T3** | after-the-fact detection | nothing | TWAK |

**The UI renders the tier with the same visual weight as the number.** No competitor will tell a user their "on-chain cap" is a process that can crash. This is credible *only because* T0 is genuinely achievable here.

### 6.2 What is enforceable today

| Constraint | Status |
|---|---|
| Per-action value cap | ✅ T0 |
| Target/contract allowlist | ✅ T0 (`UniversalActionPolicy`) |
| Function-selector allowlist | ✅ T0 |
| **Lifetime session cap** | ✅ T0 (`ERC20SpendingLimitPolicy`) |
| Expiry | ⚠️ `TimeFramePolicy` **not deployed on 56 — AiKi must deploy it** |
| **Rolling window ("$250/month renewing")** | ❌ **needs custom policy** |
| Instant revocation | ✅ T0 — single userOp, no off-chain coordination |

**`ERC20SpendingLimitPolicy` stores `alreadySpent` as a monotonic counter with no `block.timestamp` and never resets.** It is a lifetime cap.

**Decision (recommendation):** ship lifetime caps — *"this session may spend at most $250 total, expiring 18 Sep"* — which is fully enforceable and arguably a clearer promise. Treat a `RollingWindowSpendPolicy` as a separate funded, audited workstream. Writing unaudited fund-holding code under a three-week deadline is how marketplaces lose money.

**Do not claim "per month" until it is enforced.**

### 6.3 Policy language: superset of AP2

AP2 v0.2's open/closed model is adopted as the base (ADR-005): user signs a **constraint set**; agent signs a **concrete instance** within it. Its constraint algebra (`payment.budget`, `payment.amount_range`, `payment.agent_recurrence`, `payment.allowed_payees`, execution windows) is normatively specified and explicitly intended to generalise beyond payments.

AiKi extends it with what DeFi execution needs and AP2 lacks: contract/selector allowlists, slippage bounds, and on-chain trigger conditions (health-factor thresholds, price bands).

**The payment-shaped subset *is* an AP2 mandate.** Compilation targets: SmartSession policies, Altana session grants, or a T1 signer — selected by adapter capability, with the resulting tier surfaced.

---

## 7. Commerce and payments

### 7.1 Canonical job model, ERC-8183 as one adapter

AiKi's lifecycle is richer than ERC-8183's six states (it must cover off-chain jobs, recurring work and workflows). ERC-8183 maps as a projection:

```
AiKi:  DRAFT→QUOTED→AUTHORIZED→FUNDED→DISPATCHED→RUNNING→SUBMITTED→EVALUATING→COMPLETED→SETTLED
8183:                            Open→Funded→        Submitted→               Completed
```

**⚠️ Generate the adapter from the deployed ABI, not the EIP text.** Verified divergences:

| Deployed | Spec |
|---|---|
| `fund(uint256,uint256,bytes)` | `fund(uint256,bytes)` |
| `setProvider(uint256,address,bytes)` | `setProvider(uint256,address)` |

Adversarial verification confirmed **the spec contradicts its own reference implementation on `fund`**. Pin the implementation address (`0xd5f9b570…`) and assert it at startup — the proxy is upgradeable.

Inherited trust assumptions to surface in the Passport risk section: the commerce proxy is **upgradeable, pausable, owner-controlled**, and the **EvaluatorRouter is both evaluator of record and `IACPHook`** — a single point of extension and centralisation.

Adopt ERC-8183's invariant: **no extension point may trap user funds** (`claimRefund` is deliberately not hookable).

### 7.2 Payments — `$U`, not USDT

```
supports_eip3009 | supports_permit2612 | requires_permit2_approval | decimals
```

| Token | EIP-3009 | Decimals |
|---|---|---|
| **USDT-BSC** | ❌ | **18 — not 6** |
| Binance-Peg USDC | ❌ | |
| **`$U` United Stables** | ✅ | 18 |

**The 18-decimals trap is the highest-frequency bug risk in the codebase.** Porting a Base/Arbitrum USDC assumption of 6 decimals makes every amount wrong by **10¹²**. Decimals come from config per token, never from a constant.

Chain 56 is absent from x402's `DEFAULT_STABLECOINS`, so the `price: "$0.10"` sugar throws — always specify `asset` + `amount`. Pin `@x402/*` v2 with CAIP-2 network ids.

**Settlement asset must be visible in the quote, before authorization.**

### 7.3 Exactly-once money (HP-5)

- Idempotency keys required on every money/job/authorization mutation.
- Double-entry ledger is the source of truth; chain settlement is **reconciled against** it, never inferred from it.
- **A transaction timeout is not a failure.** One intent → one nonce; resubmission is replacement, never duplication.
- Outbox/inbox so DB and event bus cannot diverge.
- Continuous three-way reconciliation: ledger ↔ adapter ↔ chain, with a defined procedure for disagreement.

---

## 8. Arena (HP-1, HP-2)

### 8.1 Replay is feasible — with declared limits

```bash
anvil --fork-url <NodeReal archive> \
      --fork-block-number <pinned> \
      --evm-version prague          # REQUIRED: ~1.5% of BSC txs are type-4
```

Gas reproduces exactly (34,515 measured == on-chain).

| Input | Control |
|---|---|
| Chain state | ✅ forked at pinned block |
| Gas | ✅ exact |
| Prices | ✅ frozen snapshot (Binance klines, 6,000 weight/min) |
| Wall clock | ✅ virtualised |
| AiKi-mediated HTTP | ✅ recorded/replayed |
| **Agent-internal LLM sampling** | ❌ **third-party endpoint — uncontrollable** |

**The run manifest states which inputs were pinned and which were not.** Agent-internal nondeterminism is handled by **N trials with a reported interval**, never a single run presented as fact.

### 8.2 The statistical rules — non-negotiable

> **Separating two agents differing by 0.5 annualised Sharpe at 5%/80% power requires ~63 years of returns. Sampling more frequently does not help — the required duration is frequency-invariant.**
>
> With 100 zero-skill agents and σ(SR)=0.5, the *winner* averages **SR ≈ mean + 1.27 from pure noise**.

**R1.** Never rank trading agents by realized Sharpe or PnL across different periods. Not with caveats.
**R2.** **Paired replay on identical scenarios is the only honest comparison** — it removes the cross-sectional noise term entirely.
**R3.** Report intervals with multiple-testing deflation. *"These three agents are statistically indistinguishable on current evidence"* is a **designed first-class state**, not an error.

**Arena's honest claim:** *"On these 40 identical replayed scenarios, agent A outperformed agent B in 31, interval [x, y]."* Narrower than a leaderboard, far stronger, and not copyable without building the same harness.

### 8.3 Integrity

Per-season uuid4 canary embedded in held-out tasks; **publish its hash on-chain with the season commitment** — tamper-evident and dated without disclosure. Tripwire: prompt a candidate model with a truncated GUID prefix; completion ⇒ contamination. Public preview tasks stay separate from hidden scoring tasks.

**For AiKi's four launch categories evaluation is almost entirely objective** — did the health factor hold, did the LP stay in range. No LLM judge needed. Where a judge is unavoidable: ≥2 judges of different families, swap-and-require-consistency (GPT-4 position-bias consistency is 65.0%, Claude-v1 **23.8%**), length normalisation, agreement reported.

---

## 9. Validator role

The ValidationRegistry is deployed with **zero validators and zero validations, globally, across 743K agents.**

AiKi writes Arena results and liveness verdicts as `validationResponse(requestHash, response 0–100, responseURI, responseHash, tag)` — producing on-chain, portable, third-party-consumable Class-A evidence. `tag` scopes the verdict (`liveness`, `arena:health-factor`), and `getSummary(agentId, validatorAddresses, tag)` lets consumers filter to validators they trust.

⚠️ **Validation is owner-initiated** — a provider must open the request. AiKi cannot unilaterally publish verdicts about unwilling agents; unsolicited findings stay in AiKi's own graph.

---

## 10. Machine surface — MCP `2026-07-28`

Stateless; `server/discover` replaces the handshake; routing headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) let the gateway authorize, price and shard without parsing bodies.

Long-running jobs ride the **`io.modelcontextprotocol/tasks`** extension — statuses `working | input_required | completed | failed | cancelled` map onto AiKi's lifecycle, and `input_required` is the natural carrier for human spend approval. ⚠️ It is a **draft extension**: the canonical job model stays AiKi's; MCP is a projection (ADR-010).

🔒 **`requestState` in MRTR is attacker-controlled.** It MUST be a MAC'd envelope binding `{principal, job_id, authorization_id, nonce, expiry}`, verified before any economically meaningful action. Unbound, it is a direct replay and privilege-escalation vector on spend approval.

Auth: OAuth 2.1 + RFC 9728 PRM + RFC 8707 resource indicators, all mandatory. Rate limiting is **unspecified by the protocol** — AiKi defines and documents its own.

---

## 11. Receipts — profile SCITT, don't invent

`Execution Receipt` = a profile of **SCITT (RFC 9943)** + **COSE Receipts (RFC 9942)**, both Proposed Standard since June 2026.

Adopt AP2's binding pattern: the receipt's `reference` is **the hash of the closed mandate it acted under** — cryptographically tying work to authority. Transparency-log inclusion proofs give append-only guarantees without a bespoke log, and third parties can verify with off-the-shelf tooling. That is what "prove what happened" requires.

---

## 12. ADR decisions taken here

| ADR | Decision | Forced by |
|---|---|---|
| 001 | Canonical identity = `(chain_id, registry, agent_id)`. Ownership transfer is an **evidence-continuity event** (confidence reset). | Identity is a transferable ERC-721 |
| 002 | Append-only bitemporal Observations + rebuildable projections | HP-4 |
| 003 | Wilson LB + Beta + EB shrinkage. **`z` pinned in `scoring_version`.** | Measurement science |
| 005 | Policy DSL = AP2 superset, compiled per adapter, **tier surfaced** | AP2 v0.2 + T0 availability |
| 006 | ⚠️ **BLOCKED** — no bundler/paymaster verified on chain 56 | O-3 |
| 007 | Double-entry ledger authoritative; chain reconciled against it | HP-5 |
| 009 | anvil + `--evm-version prague` + NodeReal archive; paired replay | HP-1/HP-2 |
| 010 | Canonical job model is AiKi's; MCP Tasks is a projection | draft extension |
| 013 *(new)* | **Execution Receipt = SCITT/COSE profile**, not a new format | RFC 9943/9942 |
| 014 *(new)* | **Ship lifetime caps; rolling-window is an audited workstream** | `ERC20SpendingLimitPolicy` is monotonic |

---

## 13. What blocks what

| Blocker | Blocks | Owner |
|---|---|---|
| **O-3** no verified bundler/paymaster on 56 | ADR-006, entire T0 execution path | **research — do first** |
| **O-2** Altana spend-cap not read at source | the T0 claim in the UI | research |
| **O-1** Terms of Participation | submission, IP posture | **founder** |
| `TimeFramePolicy` not deployed on 56 | mandate expiry | engineering |
| `$U` liquidity unknown | checkout UX | product |

**A smart-account architecture with no verified bundler has no execution path.** O-3 is the top of the queue.
