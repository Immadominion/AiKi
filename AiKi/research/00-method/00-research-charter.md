# AiKi research charter

**Status:** current research method; product scope is defined in [PRODUCT.md](../../docs/PRODUCT.md)
**Opened:** 18 August 2026
**Scope clarified:** 8 September 2026
**Owner:** engineering

---

## 1. Why this charter exists

AiKi is a marketplace for humans and AI agents to get work done together. Research supports the full workflow: discover and hire, define the work, deliver it, review it and pay. Handoffs between people and agents belong in that workflow. Fast and Manual are two ways to use the same marketplace.

[PRODUCT.md](../../docs/PRODUCT.md) is the current product definition. This programme began from two earlier documents:

- `docs/agent-commerce-master-product-system-spec.docx` - the Master Product & System Specification (MPSS), 35 sections + appendices.
- [Archived 18 August context](../../../docs/archive/2026-08-18-initial-agent-context.md), originally `docs/initial_agent_context.md`, the founding project handoff.

Those documents record the original product and system proposal. Their full feature list is not an automatic commitment to build every proposed subsystem. Research must establish which capabilities the marketplace needs, whether the technical substrate exists, how it behaves, and what it costs to build on.

That gap is the entire subject of this research programme. The MPSS itself flags it:

> "its integration assumptions were checked against current primary/official documentation on 18 August 2026. **These references are a snapshot and should be revalidated during implementation** because protocols and provider capabilities evolve."

The studies in this folder record that investigation at their stated dates. A research verdict does not establish that the current implementation has shipped or passed an end-to-end test.

## 2. The standard we are holding ourselves to

The instruction driving this work is: build it so that a serious systems engineer reading the design says *"that's good."* Concretely that means four things, and they are all falsifiable.

### 2.1 No fact enters the architecture without provenance

Every load-bearing technical claim in AiKi's design must be traceable to a primary source that was actually fetched, with a URL and a date. Not a blog summary of a spec - the spec. Not a memory of an interface - the interface.

People need reliable information when choosing who to hire and deciding what to approve. Probes, identity records and receipts help provide that information. They are supporting quality and control systems, not AiKi's product identity. The same standard applies to claims about delivery, payment and human-agent handoffs.

### 2.2 Three states of knowledge, never blurred

| State | Meaning | How it may be used |
|---|---|---|
| **VERIFIED** | Read in a primary source, URL + date recorded | May be built on |
| **ASSUMED** | Reasonable, unconfirmed, explicitly labelled | May be built on *behind an adapter*, with the assumption recorded as a risk |
| **UNKNOWN** | We looked and could not establish it | May **not** be built on. Blocks the decision or forces a spike. |

Any document in this repo that states a fact without one of these states attached is defective.

### 2.3 Spec ≠ deployment ≠ marketing

A recurring failure mode in this ecosystem is conflating:

- what a standard **says** (the EIP text),
- what is **deployed and live** (contract addresses with real state, endpoints that answer),
- what a **blog post claims** exists.

Every protocol finding is tagged with which of the three it is. A standard that is a Draft EIP with no production deployment is a *design input*, not *infrastructure*. We will say so plainly even when it is inconvenient for the pitch.

### 2.4 Down to the low level

"Architecture" here does not stop at a boxes-and-arrows diagram. For each subsystem the target artefact is the level at which an engineer could disagree with us on technical grounds:

- exact schemas with types, nullability and invariants - not "an evidence object"
- concurrency, consistency and failure semantics - what happens on partial failure, duplicate delivery, reorg, clock skew
- the actual formulas, with their statistical justification - not "a weighted score"
- the enforcement boundary - what is guaranteed cryptographically vs. enforced by our backend vs. merely convention
- cost and latency budgets with arithmetic behind them

If a design decision cannot be stated precisely enough to be wrong, it has not been made.

## 3. The questions this programme must answer

Start with the work someone needs to get done. For each supported path, establish who can hire whom, how they agree on scope and price, how the provider receives the work, what counts as delivery, who reviews it, how payment settles, and how either party recovers from failure. Treat agent-to-agent, agent-to-human and human-to-agent handoffs as explicit paths to test, not capabilities implied by an API or a participant label.

The original question IDs below are retained so the dated studies remain traceable. Their grouping does not set the current implementation order.

### Group A - Does the substrate exist? (blocks: everything)

| # | Question | Blocks |
|---|---|---|
| A1 | ERC-8004: current status, exact registry interfaces, what is stored on- vs off-chain, canonical deployments on BSC | Identity ingestion, Passport identity section |
| A2 | ERC-8183: is this a real, deployed commerce standard or a paper draft? Exact escrow state machine and roles | The entire commerce adapter, job lifecycle |
| A3 | x402 / B402: exact HTTP contract, payload schema, signing scheme, facilitator trust model | Payment Router, machine-to-machine hire |
| A4 | BNB Agent Studio: is there a public API/registry a third party can ingest? | Whether AiKi has *any* supply at launch |
| A5 | MCP 2026 spec: does long-running Task support exist? What is the auth model for a remote server? | Machine Marketplace, Claude/IDE integration |

Provider availability is a marketplace requirement. A4 examines one source of agent supply; it does not cover human providers or every route by which a provider can join. If registry data does not lead to usable services, investigate provider onboarding and actual work completion rather than treating more indexing as the solution.

### Group B: can authority be constrained? (blocks: work requiring delegated permissions)

| # | Question | Blocks |
|---|---|---|
| B1 | Is EIP-7702 live on BSC? Which fork, which block? | Delegation UX; whether EOAs can carry session logic |
| B2 | What session-key / permission systems are live on BSC (4337 stacks, Altana, TWAK, 7579/6900 modules)? | Mandate enforcement |
| B3 | For each option: what is enforced **on-chain** vs merely in a vendor backend? | Honesty of every "the agent cannot exceed this cap" claim in the UI |
| B4 | Does USDT-on-BSC support EIP-3009 `transferWithAuthorization`? | Whether x402's `exact` scheme even works with the dominant BSC stablecoin |

B3 is where most agent-wallet marketing collapses. AiKi's mandate builder makes a *security promise* to the user. We must know, per adapter, whether that promise is cryptographic or a pinky-swear - and the UI must render the difference.

### Group C: what evidence helps a hiring decision? (supports: discovery and quality)

| # | Question | Blocks |
|---|---|---|
| C1 | What is the real, measured state of ERC-8004 on BSC - live endpoints, sybil rates, agent counts? | Availability and capability information used in agent discovery; not proof of completed work |
| C2 | Can BSC be forked deterministically at a historical block for benchmark replay? | Agent Arena's entire reproducibility claim |
| C3 | Which indexing framework survives BSC's block rate, `eth_getLogs` caps and reorg depth? | Evidence ingestion |
| C4 | What are the correct formulas for score-with-confidence, and for comparing trading agents without rewarding market beta? | Proof Score credibility |

C2 and C4 constrain any benchmark or ranking AiKi offers. A PnL leaderboard over a bull month can rank exposure rather than skill. If attribution is unresolved, state the limitation. A benchmark programme is not a prerequisite for every job, and it must not displace the work needed to make hiring, delivery, review and payment usable.

### Group D - What already exists that we must not rebuild? (blocks: scope)

| # | Question | Blocks |
|---|---|---|
| D1 | A2A AgentCard, AP2 mandates, ACP checkout - do these already define what AiKi calls a Capability Manifest and a Mandate? | Schema design; NIH risk |
| D2 | What have Build-the-Era competitors actually shipped? | Differentiation claims |
| D3 | Does a signed "execution receipt" standard already exist? | Receipt schema |

D1 matters more than it looks. The MPSS proposes AiKi-defined schemas for Agent Evidence, Execution Receipt and Capability Manifest. If Google's AP2 already has a rigorous mandate model, inventing a parallel one is a strict loss - we would carry the maintenance cost of a standard *and* the integration cost of theirs.

### Group E - Feasibility (blocks: the plan)

E1. Which proposed features are necessary for the current marketplace scope, and what does each cost to build and operate reliably?
E2. What prevents a user or agent from completing a real job, and which fixes unblock that workflow? For the 9 September 2026 competition, assess the four required categories separately.
E3. Where are the irreversible decisions (the ADR set), and which must be made before which line of code?

## 4. Method

1. **Primary-source sweep.** Parallel researchers, one per domain, each required to fetch specs/docs/repos directly, copy interfaces verbatim, and record gaps honestly. Fabrication of a signature or endpoint is treated as total failure of that agent's output.
2. **Adversarial verification.** Every load-bearing claim is handed to an independent agent instructed to *refute* it, defaulting to REFUTED/UNVERIFIABLE absent independent confirmation. Claims that survive are marked CONFIRMED; the rest are corrected or demoted to UNKNOWN.
3. **Architecture derivation.** Only after 1–2 do we design. Each design document states which verified facts it depends on, so that when a protocol changes we know exactly what to revisit.
4. **Feasibility and sequencing.** Cost the design, find the critical path, and separate *complete product scope* from *implementation order* - a distinction the founder has been explicit about and which this programme preserves.

## 5. Standing constraints inherited from the product documents

These constraints follow the current [product definition](../../docs/PRODUCT.md). The [decision register](01-decision-register.md) preserves earlier commitments and their later clarification.

- Build production-quality marketplace workflows. Completeness does not require every speculative feature in the original MPSS.
- **BNB-first, not BNB-locked.** Every chain, registry, wallet, rail, runtime and data source is an adapter behind a canonical internal model.
- **Do not build a custom blockchain protocol** unless a genuinely missing primitive is identified. Open schemas are fine; a new L1/L2 is not.
- **Do not rebuild what exists.** Agent Studio is supply infrastructure, not a competitor to clone.
- Use evidence to support claims and grant only the authority a job needs. Delivery records and buyer reviews serve different purposes; a receipt does not replace review.
- **The competition is a distribution wedge, not the product boundary.** AiKi must make sense if Build the Era vanished tomorrow.

## 6. Output artefacts

```
AiKi/research/
  00-method/        this charter, source ledger, epistemic status register
  01-protocols/     ERC-8004, ERC-8183, x402/B402, MCP, wallets/delegation, adjacent standards
  02-ecosystem/     Agent Studio, competition, measured ecosystem reality, competitor teardown
  03-architecture/  system design down to schemas, formulas, failure semantics, ADRs
  04-feasibility/   cost, critical path, risk register, build sequence
```

Every protocol document ends with an **Impact on AiKi** section stating what to build, what to adapt, and what to avoid. A research document that does not change a build decision was not worth writing.

---

*This charter is itself falsifiable. If a document in this repo violates §2, that document is wrong, not the charter.*
