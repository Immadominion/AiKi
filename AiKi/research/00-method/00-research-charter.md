# AiKi — Research Charter

**Status:** canonical
**Opened:** 18 August 2026
**Owner:** engineering

---

## 1. Why this charter exists

AiKi already has two strong documents:

- `docs/agent-commerce-master-product-system-spec.docx` — the Master Product & System Specification (MPSS), 35 sections + appendices.
- `docs/initial_agent_context.md` — the project handoff / context document.

Both are **product** documents. They are unusually good ones: they define the thesis, the surfaces, the entities, the principles, the boundaries. What they deliberately do *not* do is establish whether the technical substrate they assume actually exists, how it behaves, and what it costs to build on.

That gap is the entire subject of this research programme. The MPSS itself flags it:

> "its integration assumptions were checked against current primary/official documentation on 18 August 2026. **These references are a snapshot and should be revalidated during implementation** because protocols and provider capabilities evolve."

This charter revalidates them, and then goes several layers below where the MPSS stops.

## 2. The standard we are holding ourselves to

The instruction driving this work is: build it so that a serious systems engineer reading the design says *"that's good."* Concretely that means four things, and they are all falsifiable.

### 2.1 No fact enters the architecture without provenance

Every load-bearing technical claim in AiKi's design must be traceable to a primary source that was actually fetched, with a URL and a date. Not a blog summary of a spec — the spec. Not a memory of an interface — the interface.

This is not pedantry. AiKi's *product thesis is literally "evidence over claims."* A platform that ranks agents by evidence quality, while itself being architected on unverified assertions about ERC-8183 or x402, would be incoherent at the root. The engineering method has to match the product philosophy or the product is a lie.

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

- exact schemas with types, nullability and invariants — not "an evidence object"
- concurrency, consistency and failure semantics — what happens on partial failure, duplicate delivery, reorg, clock skew
- the actual formulas, with their statistical justification — not "a weighted score"
- the enforcement boundary — what is guaranteed cryptographically vs. enforced by our backend vs. merely convention
- cost and latency budgets with arithmetic behind them

If a design decision cannot be stated precisely enough to be wrong, it has not been made.

## 3. The questions this programme must answer

Grouped by what they block.

### Group A — Does the substrate exist? (blocks: everything)

| # | Question | Blocks |
|---|---|---|
| A1 | ERC-8004: current status, exact registry interfaces, what is stored on- vs off-chain, canonical deployments on BSC | Identity ingestion, Passport identity section |
| A2 | ERC-8183: is this a real, deployed commerce standard or a paper draft? Exact escrow state machine and roles | The entire commerce adapter, job lifecycle |
| A3 | x402 / B402: exact HTTP contract, payload schema, signing scheme, facilitator trust model | Payment Router, machine-to-machine hire |
| A4 | BNB Agent Studio: is there a public API/registry a third party can ingest? | Whether AiKi has *any* supply at launch |
| A5 | MCP 2026 spec: does long-running Task support exist? What is the auth model for a remote server? | Machine Marketplace, Claude/IDE integration |

**A4 is the highest-stakes question in the programme.** A marketplace with no ingestible supply is a UI demo. If no public registry exists, supply acquisition becomes a product problem, not an integration problem, and that changes the build order.

### Group B — Can authority actually be constrained? (blocks: the safety thesis)

| # | Question | Blocks |
|---|---|---|
| B1 | Is EIP-7702 live on BSC? Which fork, which block? | Delegation UX; whether EOAs can carry session logic |
| B2 | What session-key / permission systems are live on BSC (4337 stacks, Altana, TWAK, 7579/6900 modules)? | Mandate enforcement |
| B3 | For each option: what is enforced **on-chain** vs merely in a vendor backend? | Honesty of every "the agent cannot exceed this cap" claim in the UI |
| B4 | Does USDT-on-BSC support EIP-3009 `transferWithAuthorization`? | Whether x402's `exact` scheme even works with the dominant BSC stablecoin |

B3 is where most agent-wallet marketing collapses. AiKi's mandate builder makes a *security promise* to the user. We must know, per adapter, whether that promise is cryptographic or a pinky-swear — and the UI must render the difference.

### Group C — Is the evidence layer buildable? (blocks: the moat)

| # | Question | Blocks |
|---|---|---|
| C1 | What is the real, measured state of ERC-8004 on BSC — live endpoints, sybil rates, agent counts? | The "these agents are actually ready to work" positioning |
| C2 | Can BSC be forked deterministically at a historical block for benchmark replay? | Agent Arena's entire reproducibility claim |
| C3 | Which indexing framework survives BSC's block rate, `eth_getLogs` caps and reorg depth? | Evidence ingestion |
| C4 | What are the correct formulas for score-with-confidence, and for comparing trading agents without rewarding market beta? | Proof Score credibility |

C2 and C4 are where Agent Arena either becomes a genuine differentiator or degenerates into a leaderboard that measures luck. A PnL leaderboard over a bull month ranks agents by beta exposure, not skill. If we cannot solve attribution honestly, we must say so in the UI rather than ship a misleading number.

### Group D — What already exists that we must not rebuild? (blocks: scope)

| # | Question | Blocks |
|---|---|---|
| D1 | A2A AgentCard, AP2 mandates, ACP checkout — do these already define what AiKi calls a Capability Manifest and a Mandate? | Schema design; NIH risk |
| D2 | What have Build-the-Era competitors actually shipped? | Differentiation claims |
| D3 | Does a signed "execution receipt" standard already exist? | Receipt schema |

D1 matters more than it looks. The MPSS proposes AiKi-defined schemas for Agent Evidence, Execution Receipt and Capability Manifest. If Google's AP2 already has a rigorous mandate model, inventing a parallel one is a strict loss — we would carry the maintenance cost of a standard *and* the integration cost of theirs.

### Group E — Feasibility (blocks: the plan)

E1. What does the complete MPSS scope actually cost in engineering time?
E2. What is the critical path to the 9 September 2026 deadline, and what subset of the *complete* product is coherent on its own?
E3. Where are the irreversible decisions (the ADR set), and which must be made before which line of code?

## 4. Method

1. **Primary-source sweep.** Parallel researchers, one per domain, each required to fetch specs/docs/repos directly, copy interfaces verbatim, and record gaps honestly. Fabrication of a signature or endpoint is treated as total failure of that agent's output.
2. **Adversarial verification.** Every load-bearing claim is handed to an independent agent instructed to *refute* it, defaulting to REFUTED/UNVERIFIABLE absent independent confirmation. Claims that survive are marked CONFIRMED; the rest are corrected or demoted to UNKNOWN.
3. **Architecture derivation.** Only after 1–2 do we design. Each design document states which verified facts it depends on, so that when a protocol changes we know exactly what to revisit.
4. **Feasibility and sequencing.** Cost the design, find the critical path, and separate *complete product scope* from *implementation order* — a distinction the founder has been explicit about and which this programme preserves.

## 5. Standing constraints inherited from the product documents

These are decisions already made. Research does not relitigate them; it serves them.

- **Complete product, not an MVP.** Sequencing is not scope reduction.
- **BNB-first, not BNB-locked.** Every chain, registry, wallet, rail, runtime and data source is an adapter behind a canonical internal model.
- **Do not build a custom blockchain protocol** unless a genuinely missing primitive is identified. Open schemas are fine; a new L1/L2 is not.
- **Do not rebuild what exists.** Agent Studio is supply infrastructure, not a competitor to clone.
- **Evidence over claims; receipts over reviews; least authority by default.**
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
