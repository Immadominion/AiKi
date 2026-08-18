# AiKi — Decision Register

**Purpose:** separate what is *already decided* from what is *still open*, so that no agent, engineer or collaborator silently promotes a guess into a commitment.

**Sources:** `docs/agent-commerce-master-product-system-spec.docx` (MPSS v0.1, 18 Aug 2026), `docs/initial_agent_context.md`, `docs/ideation.txt`, `docs/name-lore.txt`.

**Legend**

| Mark | Meaning |
|---|---|
| 🔒 **LOCKED** | Decided by the founder / MPSS. Do not relitigate without an explicit reversal. |
| 🧭 **DIRECTION** | Strong stated lean, not yet a commitment. Can be refined with evidence. |
| ❓ **OPEN** | Genuinely undecided. Must be labelled as a recommendation when proposed. |

---

## 1. Identity and positioning

| # | Item | State | Detail |
|---|---|---|---|
| 1.1 | Name is **AiKi**, pronounced EYE-kee | 🔒 | Hausa *aiki* — work, deed, job, craft, duty; verb sense *to send / to command*. Not an acronym; do not back-form one. |
| 1.2 | Tagline direction: *"AiKi — put agents to work."* | 🧭 | Under consideration, not final. |
| 1.3 | Category **today**: agent marketplace / agent commerce platform | 🔒 | |
| 1.4 | Category **long-term**: infrastructure for delegated autonomous work | 🔒 | "Agent" is one possible worker; the durable abstraction is *delegated work*. Do not hard-code `agent = BSC DeFi bot` into the core model. |
| 1.5 | Product loop: **intent → evidence-backed selection → constrained authority → execution → verifiable receipt** | 🔒 | The single sentence that must survive everything: *Find the right agent. Know it works. Give it exactly enough power. Let it execute. Prove what happened.* |
| 1.6 | **Not** an MVP. Complete product suite. | 🔒 | Sequencing ≠ scope reduction. Stated twice, emphatically, in both documents. |
| 1.7 | Launch ecosystem: **BNB Smart Chain**. Not BNB-locked. | 🔒 | Chain/registry/wallet/rail/runtime/data-source are all adapters. |
| 1.8 | Build the Era is a **distribution wedge**, not the product boundary | 🔒 | AiKi must make sense if the competition disappeared. Do not reshape the vision around the rubric. |

## 2. What AiKi explicitly is *not*

All 🔒. From `initial_agent_context.md` §0 and §21.

- Not a directory of agents, not a prettier ERC-8004 explorer, not a chat UI over an LLM, not a single-purpose DeFi bot, not a sponsor-bounty Frankenstein.
- **Do not build a custom blockchain protocol** for optics. Existing standards cover the useful seams. Differentiate in evidence, routing, evaluation, policy, UX, operational data.
- **Do not ship fake metrics.** If data is unavailable, show that honestly.
- **Do not ship a 200k-card database dump.** Coverage is not usefulness.
- "AI Agent Marketplace" is a current category description, not the company's ceiling.

## 3. Signature product concepts

All 🔒 as *concepts*; their internals are ❓.

| Concept | Locked meaning | Open internals |
|---|---|---|
| **Agent Passport** | Evidence-backed decision view for one agent/version; a projection over the evidence graph, not a static profile | exact section set, snapshot cadence |
| **Proof Score** | Composite decision score **paired with explicit confidence**; every sub-score explainable and traceable | exact formula, weights, confidence math |
| **Agent Arena** | Independent benchmark harness producing evidence not controlled by providers | task definitions, replay determinism, evaluator model |
| **Agent Checkout / Mandate Builder** | Authority granted as a readable *policy*, never a vague "connect wallet" | policy DSL, compilation target |
| **Mission Control** | The operating surface after activation; AiKi does not hand the user off | event model, streaming transport |
| **Agent Workspace** | Persistent threads/artifacts/context per hired agent | — |
| **Workflow Studio** | Typed multi-agent composition with per-step policy and aggregate ceiling | DAG format, versioning semantics |
| **Receipts, not reviews** | Every material job yields a verifiable receipt that feeds the evidence graph | signing, anchoring, schema |

## 4. Engineering principles

All 🔒.

1. Evidence over claims — every material trust assertion traceable to a source, observation, benchmark, transaction or attestation.
2. Intent over taxonomy — categories aid browsing; intent + constraints drive matching.
3. Least authority by default.
4. Receipts everywhere — anything that spends value, changes permission, executes work, updates reputation or affects ranking is inspectable after the fact.
5. Humans and machines are sibling first-class clients over one canonical backend (UI, API, MCP, SDK).
6. Protocol-open — no product logic depending on one registry/wallet/runtime/chain.
7. Operational truth beats static metadata.
8. Explain ranking — decomposable into reason codes, never "AI picked this".
9. Safety is product, not compliance. Caps, expiry, simulation, approvals, revoke must be excellent UX.
10. Do not hide failure — failed jobs and degraded endpoints stay in the evidence history.
11. Score and confidence are separate quantities. Sparse evidence must never render as false precision.
12. Raw observations are append-only; corrections supersede rather than mutate.

## 5. Protocol posture

| Protocol | Posture | State |
|---|---|---|
| ERC-8004 | Identity + discovery metadata + reputation/validation **inputs**. Identity ≠ trust. | 🔒 posture; ❓ technical reality (Group A1) |
| ERC-8183 | Escrowed job commerce, behind a `CommerceProtocolAdapter`. Do not weld product UX to one contract state machine. | 🔒 posture; ❓ whether it is real infrastructure (Group A2) |
| x402 / B402 | Machine-to-machine paid HTTP, one adapter in a broader Payment Router. | 🔒 posture; ❓ mechanics (A3) |
| BNB Agent Studio | Supply-side infrastructure to ingest, **not** the product boundary; not all agents must originate there. | 🔒 |
| Agentic wallets (Altana, TWAK, …) | Normalize into *capabilities* (`supports_spend_cap`, `supports_expiry`, `supports_revoke`), never code against one vendor. | 🔒 |
| 8004scan / indexers | Data source. AiKi must not become "8004scan with prettier cards". | 🔒 |
| MCP | A machine surface, not the product. Claude integration is interesting as a *client of AiKi*, not as "Connect Claude" the feature. | 🔒 |
| PancakeSwap / Venus | Initial DeFi execution + evidence environment. | 🔒 |

## 6. The empirical premise the whole thesis rests on

🧭 **DIRECTION, pending verification (Group C1).**

`initial_agent_context.md` §4 asserts, from a June 2026 study of ERC-8004 across Ethereum/BSC/Base:

- ~**4%** of BSC registrations exposed a valid registration file with ≥1 live service endpoint,
- ~**59.2%** of reviewers exhibited coordinated sybil behaviour,
- after removing sybil-flagged feedback, a large fraction of rated BSC agents had no valid reputation baseline.

This is load-bearing. It is the justification for the entire evidence layer and for the positioning *"these are the agents that are actually ready to work"* over *"200,000+ agents!"*.

**It must be independently verified before it is used in any external-facing claim.** If the numbers are wrong, the thesis still stands on first principles (identity ≠ capability), but the marketing claim does not.

## 7. Open decisions — must be labelled as recommendations

From `initial_agent_context.md` §24. Nothing here is settled; anyone proposing an answer must mark it as a recommendation.

**Product ❓** — final information architecture; consumer navigation; chat vs direct manipulation ratio; workflow authoring UX; dispute model; marketplace take rate; Proof Score formula; ranking weights.

**Technical ❓** — frontend framework; backend language(s); database; queue/event infrastructure; chain indexing strategy; telemetry stack; custody/key provider mix; secret vault; LLM provider strategy; mobile timing.

**Brand ❓** — final logo; complete colour system; typography; icon language; mascot/illustration; final tagline. *(Current exploration: chunky rounded wordmark, retro-sticker energy, thick dark outline, cream fill, bright orange dominant, yellow "AGENT MARKET" badge. This is a direction for the mark — it is explicitly **not** a commitment that every UI surface looks like a comic sticker.)*

**Business ❓** — provider verification tiers; enterprise pricing; API monetization; insurance/staking; dispute economics.

## 8. Architecture Decision Records still to be written

The MPSS §34 names these. Each must be written before its subject becomes hard to reverse.

| ADR | Decision |
|---|---|
| 001 | Canonical agent identity across registry IDs, chains, owners, versions |
| 002 | Evidence storage: append-only model and object retention |
| 003 | Proof Score: features, confidence math, category weighting, transparency |
| 004 | Workflow engine + idempotency model |
| 005 | Policy language: permission DSL and compilation to wallet capabilities |
| 006 | Wallet custody boundary and signing isolation |
| 007 | Payment routing: ledger source of truth vs on-chain settlement |
| 008 | Search/ranking: hybrid lexical + vector retrieval and reranking |
| 009 | Benchmark sandbox: isolation, chain replay, evaluator reproducibility |
| 010 | MCP/API versioning for machine clients |
| 010A | Workflow definition format: DAG/state-machine, typed context, version semantics |
| 010B | Connector credential boundary: proxy/token exchange, keeping secrets out of model context |
| 011 | Multi-region write model for job/payment/policy state |
| 012 | Enterprise tenancy and data retention |

## 9. Working-style constraints

🔒 From `initial_agent_context.md` §26 and the founder's direct instruction.

- Do not artificially shrink scope into an MVP unless asked.
- No generic hackathon shortcuts.
- Research competitors before claiming novelty.
- Prefer concrete architecture over AI buzzwords; avoid generic startup copy.
- Optimise for exceptional UI and product coherence; treat trust/safety as core UX.
- **Call out ideas that are redundant with existing infrastructure.** Do not rebuild what exists.
- Distinguish complete vision from implementation order.
- Preserve the culturally rooted brand story.

## 10. Known deadline

🔒 **9 September 2026** — Build the Era submission. Judging 9–23 Sep; winner announced 5 Nov 2026. *(Dates per `initial_agent_context.md` §3.1; being independently verified — Group A/D research.)*

A build-in-public sprint into that date is 🧭 intended but unplanned; it is explicitly *not* to read as "Day 7 building for the BNB hackathon 🚀" content, but as a real company/product story.

---

**Maintenance rule:** when research resolves an ❓ or contradicts a 🧭, update this file in the same change that acts on the finding. This register is the reason we will not drift.
