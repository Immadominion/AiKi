# Build the Era — Verified Competition Mechanics

**Research verdict:** SOLID
**Verified:** 18 August 2026
**Answers:** Charter question group D
**Adversarial verification:** 11 claims re-checked; most returned PARTIALLY_TRUE with nuance corrections, recorded inline

---

## The three things that matter most

1. **The deadline is 12:00 UTC on 9 September 2026 — midday, not midnight.** That is **~3 weeks** from today. Anything not merged and publicly deployed by 11:00 UTC that day does not exist.
2. **The Terms of Participation are not publicly fetchable.** IP assignment, licensing and open-source obligations are therefore *entirely unknown*. This is the single largest commercial risk in the programme and it is blocking.
3. **"Agent Diversity" is a supply trap, not a UI problem.** Health Factor Monitoring has ~4 matching agents on all of BSC. Grid Trading has ~10. You cannot satisfy "all four categories with equal depth" by indexing.

---

## 1. Dates and mechanics

| Item | Verified value |
|---|---|
| Build window | **12:00 UTC 5 Aug 2026 → 12:00 UTC 9 Sep 2026** |
| Judging | 9–23 Sep 2026 |
| Shortlist | Top 3 announced **publicly** after submissions close |
| Phase 2 | Exists, criteria **[REDACTED]** on the page |
| Winner announced | 5 Nov 2026 |
| Intake | A single **Google Form**. No DoraHacks, no Devfolio, no public leaderboard. |
| Judges | "Three judges, scored independently" — **none named anywhere** |

The exact UTC time appears *only* in the registration form's availability-confirmation field. The hackathon page says "5 Aug - 9 Sep, 2026 (UTC +0)" with no time of day; the blog gives no year and no timezone. **Plan to the midday cutoff.**

## 2. The rubric, verbatim

Three criteria, presented without percentages, all main-track:

> **Functionality** — "The full journey works end to end: land, find an agent by category, understand what it does, activate it, with minimal friction. Someone with zero Agent Studio knowledge should be able to get through it without hitting a dead end."

> **Data Quality** — "Real-time, accurate data that goes beyond basic counts. A user should be able to look at what you're showing and make a genuinely informed call on which agent to hire."

> **Agent Diversity** — "All four categories (rebalancing, grid trading, yield, health factor) surfaced with equal depth. A submission that treats one category as the main event and the rest as an afterthought won't score well here."

> "We'all also assess more criterias in the second phase, stay tuned to find out!" *[sic]*

**⚠️ A fourth criterion exists in the press release but not on the rubric page.** Chainwire, verbatim: *"Submissions will be scored against published criteria covering functionality, data quality, agent diversity, **and real-world usage**."* That is the most likely content of the redacted Phase 2.

→ **Instrument usage telemetry from day one.** Unique wallets, activations, completed hires, retained sessions. Cheap now, impossible to backfill after 9 Sep.

*Verification note: "explicitly equally weighted" was rated PARTIALLY_TRUE — the page states no numeric weights for the main track. Equal thirds is a reasonable reading, not a published fact. Only the TermiX partner track publishes weights (30/30/20/20).*

## 3. Categories — note the discrepancy

The hackathon page (the operative rules surface) lists:

| Category | Description, verbatim |
|---|---|
| Rebalancing | "Manages LP ranges, resets positions automatically" |
| Grid Trading | "Places and manages automated grid orders" |
| Yield Optimisation | "Routes liquidity to the highest available APR" |
| Health Factor Monitoring | "Protects lending positions from liquidation" |

**The blog and press release substitute "Monitoring agents" for "Rebalancing."** Build to the hackathon page — it carries the Agent Diversity criterion — but consider surfacing generic monitoring as a fifth facet to cover both framings.

## 4. Supply in the judged categories is nearly nonexistent

Keyword counts via `/agents?chainId=56&search=`, 18 Aug 2026, against 257,865 total BSC agents:

| Category | Matching agents on BSC |
|---|---:|
| yield | 132 |
| rebalanc | 40 |
| grid | 10 |
| **health factor** | **4** |

*(Naive substring matching over name/description; the semantic `/agents/search` endpoint returned **HTTP 502** during cross-checking. Treat as a lower bound and order-of-magnitude.)*

Sampled results are visibly hackathon-seeded and very recent:

- **"BNB Grid Trader (test)"** — created 2026-08-17T20:10:38Z — *"TEST DEPLOYMENT — not for production use. Autonomous PancakeSwap V3 BNB/USDT grid trader… priced in $U via ERC-8183"*
- **"GridMaster Ops (Agent Studio)"** — 2026-08-14 — *"Hires and transacts inside Altana sessions with onchain spend caps and revocable authority"*
- "Portfolio Rebalancer", "Yield Allocator" — both 2026-08-17

**This is live competitive intelligence.** Intake is a private form with no public leaderboard until the shortlist, so the *only* observable competitor signal is on-chain: poll `GET /agents?chainId=56` sorted by `created_at` for hackathon-themed registrations. Competitors building on Altana sessions are already visible.

→ **Publishing AiKi-operated reference agents in the thin categories is mandatory scope, not optional polish.** This independently confirms the conclusion reached from the ecosystem measurement (see [ERC-8004 reality](01-erc8004-reality-on-bsc.md) §6.2, path B).

## 5. The registry is metadata-dark — which is the opening

From `/stats`, 18 Aug 2026:

| Metric | Value |
|---|---:|
| `total_agents` | 733,946 |
| `protocol_distribution.unknown` | **674,773 (91.9%)** |
| `protocol_distribution.a2a` | 34,961 |
| `protocol_distribution.mcp` | 24,213 |
| `registration_stats.resolved` | **4,272** |
| `registration_stats.owner_verified` | **2,951** |
| **`total_validators`** | **0** |
| **`total_validations`** | **0** |
| `total_feedbacks` | 3,549,334 (avg 80.99, 400,763 users) |
| `daily_new_agents` | 1,358 |

Two conclusions with direct product consequences:

**The Data Quality criterion cannot be won by proxying 8004scan.** 91.9% of agents have unknown protocol and only 4,272 of 733,946 have resolved registration metadata. A marketplace that renders 8004scan's fields will look identical to every other entrant. Independent enrichment — liveness probing, capability verification, classification, provenance — *is* the criterion.

**The ERC-8004 Validation Registry is specified and entirely unused: zero validators, zero validations, network-wide.** That is the clearest open niche on the chain. AiKi could be the first validator — a rubric differentiator and a durable product position simultaneously. *(Weigh against Draft status: the Validation interface may still change.)*

## 6. Correct a marketing figure — and score points doing it

Blog and press release claim:

> "Over 200,000 AI Agents registered on BNB Smart Chain… account for approximately **60%** of all such agents across **26 networks**."

Live data, 18 Aug 2026: **257,865 of 733,946 = 35.1%**, across **60** chains (`/chains`).

The absolute count is accurate and understated; the share and network count are stale. **Do not repeat the 60%/26-network figure in any AiKi material.** Citing the corrected figure in the submission is itself a Data Quality signal to judges.

## 7. Prizes and the adoption question

| Track | Prize |
|---|---|
| **Main** | **$30,000** + "official adoption as the BNB Agent Studio marketplace" |
| TermiX | $10,000 split 6/3/1 |
| PancakeSwap | 1,000 CAKE |
| Altana / AltLayer | additional partner tracks |

**⚠️ The adoption promise is worded two different ways.**

- Hackathon page: *"$30,000 equivalent, **plus official adoption** as the BNB Agent Studio marketplace, the canonical front door for every agent on BSC."*
- BNB Chain's own press release: *"The winning submission will have **the opportunity to become** the officially adopted BNB Agent Studio marketplace, backed by BNB Chain as a standalone product with its own brand and team."*

No contract, no grant figure, no incubation stipend, no equity or token terms are published anywhere.

→ **Treat the $30,000 as the only certain consideration and adoption as an unpriced option.** Settlement asset is also unpinned — the page says "$30,000 equivalent", the blog says "$30,000 USDT".

### The TermiX track is unusually high expected value

It is the only track with published weights — Value of services 30%, Proven agent advantage 30%, High-stakes categories & track record 20%, Marketplace quality 20% — and the deliverable is concrete and checkable: an **Agent Advantage Report** with ≥3 real tasks run *both ways* (with agent vs. without), time/cost/quality metrics per task, actual outputs attached, and ≥1 task from trading/stock/security/equities.

**TermiX states it will actually hire from your marketplace and evaluate results.** That artifact doubles as the "real-world usage" evidence the press release names. One piece of work, two scoring surfaces, largely orthogonal to the main-track build.

### The Altana track is a spec for what AiKi should build anyway

Its requirements: per-agent wallets, sessions with call allowlist + spend cap + expiry, Keystore registration, real on-chain transactions via session key, user-facing revocation. That is AiKi's mandate layer, described by someone else. See §8.3.

## 8. Substrate facts surfaced by this research

These properly belong to the protocol documents (round-2 research is verifying them independently), but they are recorded here because they emerged from the competition sweep and several are decision-changing.

### 8.1 ERC-8183 is real, deployed infrastructure — not a paper spec

This answers charter question **A2**, and the answer is more favourable than expected.

**EIP-8183 "Agentic Commerce"** — Status **Draft**, Standards Track: Interface, created **2026-02-25**.

```
JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }
lifecycle: createJob / setBudget / fund / submit / complete / reject / claimRefund
IACPHook: beforeAction / afterAction
```

**APEX contract deployments** (from the `apex-contracts` README — ⚠️ **verify on BscScan before mainnet use; a README is not a source of truth for an address**):

| Contract | BSC Mainnet (56) |
|---|---|
| AgenticCommerceUpgradeable | `0xEa4DAa3100A767e86FDed867729ae7446476EBA6` |
| EvaluatorRouterUpgradeable | `0x51895229E12F9876011789B04f8698af06cCD6DA` |
| OptimisticPolicy | `0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5` |
| Payment token | `0xcE24439F2D9C6a2289F741120FE202248B666666` |

| Contract | BSC Testnet (97) |
|---|---|
| AgenticCommerceUpgradeable | `0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE` |
| EvaluatorRouterUpgradeable | `0xd7d36d66d2f1b608a0f943f722d27e3744f66f25` |
| OptimisticPolicy | `0x4f4678d4439fec812ac7674bb3efb4c8f5fb78a6` |
| Payment token (USDC) | `0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565` |

Architecture is a kernel / router / policy pattern.

### 8.2 BNB Agent Studio — and a security pattern worth copying

Live on BSC **mainnet since ~1 July 2026**. Six layers: user code → IDE (Claude Code / Cursor) → Studio surfaces (`bag` CLI, MCP server, recipes, skills) → `bnbagent_studio_core` (wallet factories, Policy, ERC-8004/8183 workflows, x402, audit logging) → `bnbagent-sdk` (`ERC8004Agent`, `ERC8183Client`, `EVMWalletProvider`) → BSC.

Studio registers an ERC-8004 identity per agent and binds its wallet to that identity. Settlement is **x402 in $U on BSC**, with gasless transfers via **EIP-3009**. Default LLM aggregator is Pieverse; primary wallet integration is TWAK.

> **x402 + $U is DEPLOYED. B402 (Binance Pay merchants) is explicitly still ROADMAP.** Do not build on B402 as though it were live.

**⚠️ The free tier is testnet-only and does not support mainnet.** A free-tier Studio deployment cannot back a mainnet posture. Budget for paid infrastructure or self-hosted agents.

**The two-tier deployment boundary is worth adopting wholesale.** Layer A (Agent) holds keys, runs the LLM, handles quote/fulfil/settle, deploys to AWS Bedrock AgentCore. Layer B (Service) is keyless, runs no LLM, deploys to EC2/Fargate. Verbatim:

> "Service → Agent. The public Service can only ask the Agent to sign; the Agent re-validates on chain before signing."

Signing lives in fixed entrypoint code and is **never an LLM-callable tool**. For a platform handling third-party funds that separation is the correct default — and it is the pattern BNB Chain's judges will recognise. This maps directly onto **HP-3** (the enforcement gap).

### 8.3 Altana already implements delegated agent hiring on BSC

```
hireErc8183Agent(wallet, signer, { provider, task, budget }, { network: BNB }) → { jobId }
getErc8183Job(...)                  // OPEN → FUNDED → SUBMITTED → COMPLETED
getErc8183DeliverableUrl(...)       // manifest URL after submission
settleErc8183Job(wallet, signer, { jobId, action?: "dispute" }, { network: BNB })
buildClaimRefundCall(chainId, jobId)
ERC8183_ADDRESSES                   // kernel, EvaluatorRouter, OptimisticPolicy,
                                    // ERC-8004 registry, $U — for chainId 56 and 97
```

`budget` is a bigint at 18 decimals. **Session keys are accepted as the signer**, giving a scoped key with an on-chain spend limit.

→ **Evaluate adopting or interoperating with this rather than rebuilding escrowed agent hiring from scratch.** This is precisely the "do not rebuild what exists" principle from the decision register. Round-2 research is verifying what Altana enforces *on-chain* versus in its backend — the HP-3 tier question — before we commit.

### 8.4 8004scan has a *documented public* API tier

Distinct from the undocumented `/api/v1` found by probing. Base URL **`https://8004scan.io/api/v1/public`**, OpenAPI 3.0 at `/api/v1/public/docs/openapi.json`, CORS enabled.

```
GET /agents          GET /agents/{chainId}/{tokenId}     GET /agents/search
GET /accounts/{address}/agents                            GET /stats
GET /feedbacks       GET /chains
```

| Tier | Rate limit |
|---|---|
| Anonymous | 10/min · 100/day |
| Free | 30/min · 1,000/day |
| Basic+ | 100/min · 10,000/day |
| **Pro+** | **500/min · 100,000/day** |

Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

**Pro tier is free for hackathon participants** via `https://forms.gle/jQevEPCAacBXaKG79` — worth claiming immediately.

⚠️ Reliability caveat: `/agents/search` returned **HTTP 502** during testing. Never place it on the critical path during judging, when "functional and publicly accessible" is an eligibility condition. Ingest and cache behind a circuit breaker.

## 9. Open gaps — with commercial consequence

| Gap | Consequence |
|---|---|
| **Terms of Participation not fetchable** | IP ownership, license obligations, open-source requirement, warranty, dispute resolution, and the actual legal meaning of "official adoption" are all unknown. **Request this document from BNB Chain before submitting.** Other BNB hackathons have required work to be "open source and free for others to use" — if that carries over, submitting AiKi's trust/verification core could force it under a permissive license. |
| Phase 2 criteria redacted | Format, weights, whether it involves live demo/interview/user-testing — unknown. "Real-world usage" is inference, not stated fact. |
| Judges unnamed | Cannot calibrate to audience. |
| Mainnet vs testnet ambiguous | Main track says only "live on BSC" without a chain ID. Only Altana's track carries "testnet counts, mainnet is stronger". |
| No demo-video or deployed-URL field in the form | Unclear how judges receive the live URL — plausibly the free-text Project Description, or a later follow-up step. |
| Prior-work rule unpublished | Neither permitted nor prohibited in any source. Permission is *inferred* from the form's "Working MVP" prototype-stage option. |
| Team size | Form dropdown ends at "5+" — a UI limit, not a stated rule. |
| Prize settlement asset | "$30,000 equivalent" vs "$30,000 USDT". |
| Whether an adopted marketplace is exclusive | Entirely unaddressed. Relevant if AiKi is a company, not an entry. |

## 10. Strategic reading

**The rubric and AiKi's thesis are unusually well aligned — this is not a case of bending the product to fit a competition.**

Data Quality asks for exactly what the ecosystem lacks and what AiKi was already going to build: liveness probing, verification, provenance, reputation independent of a feedback blob that costs $0.0042 to forge. The measurement work in [ERC-8004 reality](01-erc8004-reality-on-bsc.md) *is* the Data Quality submission.

Three concrete positions follow:

1. **Enrich, never proxy.** Independent ingestion, classification and probing over `GET /agents`, with 8004scan as a seed source behind a circuit breaker.
2. **Publish reference agents in the thin categories.** Health factor (4 agents) and grid (10) cannot be satisfied by indexing. This is forced scope.
3. **Consider becoming the first ERC-8004 validator.** Zero validators exist network-wide. It is a rubric differentiator and a durable product position.

And one caution: **the competition's shape rewards a working end-to-end journey over architectural depth.** The MPSS's complete-product scope is correct as a *product* commitment, but the three-week window means the judged surface must be a coherent, genuinely working loop — not a broad, shallow footprint. Sequencing matters more than usual here, and that is a build-order decision, not a scope reduction.

---

## Sources

| Source | URL |
|---|---|
| Hackathon page (operative rules) | https://www.bnbchain.org/en/hackathons/smart-money-era |
| Blog announcement | https://www.bnbchain.org/en/blog/build-the-era-build-the-official-bnb-agent-studio-marketplace |
| Press release (adds "real-world usage") | https://chainwire.org/2026/08/05/bnb-chain-launches-build-the-era-hackathon-to-find-the-official-bnb-agent-studio-marketplace/ |
| Registration form (exact UTC deadline) | https://docs.google.com/forms/d/e/1FAIpQLSdFb30r24sZcFJVDbMqXNJ1_45BJHanc7eFqwUniScDYZfX9A/viewform |
| 8004scan Pro tier for participants | https://forms.gle/jQevEPCAacBXaKG79 |
| EIP-8004 | https://eips.ethereum.org/EIPS/eip-8004 |
| EIP-8183 | https://eips.ethereum.org/EIPS/eip-8183 |
