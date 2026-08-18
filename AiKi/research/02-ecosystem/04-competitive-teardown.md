# Competitive Teardown — Your Differentiators Are Already Shipped

**Research verdict:** SOLID
**Verified:** 18 August 2026
**Answers:** Charter question **D2**

---

## Read this first

> **Four of AiKi's five stated differentiators are already shipped, live, and free — by third parties.**

This is the finding the decision register's "research competitors before claiming novelty" rule exists to surface. It is uncomfortable and it is better to learn it now than in the judging round.

| AiKi differentiator | Already shipped by | Evidence |
|---|---|---|
| **Confidence-weighted scoring** | **trust8004.xyz** | `/api/v2/agents/{id}/score` returns per-dimension scores each with an explicit `confidence` float — availability 0.55, activity 0.3, wallet 0.6, popularity 0.2. **Queryable today, no API key.** |
| **Explainable multi-dimension ranking + liveness** | **8004scan `scores/v5`** | v5.2 `v5_leaderboard_policy`: five weighted dimensions, human-readable `explanation` strings, `health_status`, integrity tiers |
| **Mandate enforcement tiers** | **winsznx/mandate** | On-chain `testedAuthorityHash` acting as a **ceiling** on every derived authority; `ReceiptDidNotPass` **reverts on-chain** so a failed trial can never back a live mandate. Contract **deployed and Sourcify-verified** on BSC testnet. |
| **Staked, typed evaluators** | **TermiX AACP** | `PROGRAM` / `RUBRIC` / `HYBRID` / `CEX_CAPITAL` strategy types, including **TEE + Groth16 zkVM** |

The one that is *not* shipped: **independent, adversarial liveness verification with a published methodology** — and the empty ValidationRegistry that would anchor it.

---

## 1. The competitive frontier is not the six repos you were tracking

All six named repos exist and are public — none 404'd. But GitHub search surfaced **three entrants materially ahead of them**:

| Repo | What makes it serious |
|---|---|
| **winsznx/mandate** | 369 files. Contract **DEPLOYED and Sourcify-verified on BSC testnet.** Implements trial → authority-ceiling → mandate enforcement. This is the closest thing to AiKi's thesis anyone has shipped. |
| **kaizenbnb/bnb-agent-marketplace** | Real BSC-testnet **work transactions, independently verified on-chain.** Actual completed jobs, not scaffolding. |
| **gilbertsahumada** | Hexagonal TypeScript, 100+ files, **trust8004 integration** |

**→ Basic marketplace implementation was already table stakes. Now evidence-layer implementation is approaching table stakes too.**

`winsznx/mandate` deserves particular attention. Its `testedAuthorityHash`-as-ceiling with an on-chain revert is a genuinely elegant idea: **an agent's live authority can never exceed what it demonstrably passed a trial with, and the chain enforces it.** That is a stronger, more falsifiable statement than "we score agents on safety." It is worth understanding deeply — and it is exactly the sort of thing the MPSS's "call out ideas redundant with existing infrastructure" principle demands we acknowledge rather than reinvent.

---

## 2. What nobody has solved — the real opening

| Gap | Measurement |
|---|---|
| **ValidationRegistry is empty** | `total_validations: 0`, `total_validators: 0` — **globally**, across 743K agents |
| **No feedback has interaction proof** | **100%** of BSC feedback lacks any payment proof or task linkage |
| **Sybil-flagged feedback on BSC** | **96.3%** |
| **Cost to cross a τ=90 trust threshold** | **$0.0042** |

> **Reputation on BSC is not weak. It is worthless.**

That is the opening, and it is a different opening than the founding documents assumed. The gap is **not** "nobody scores agents" — several products do, some with genuine sophistication. The gap is that **every existing score is computed over inputs that cost half a cent to forge**, and nobody is generating independent evidence to replace them.

### What this repositions AiKi toward

Three positions survive this teardown:

1. **Be the first ERC-8004 validator.** The registry is deployed, specified, and has literally never been used. Writing Arena results and liveness verdicts as `validationResponse` produces on-chain, portable, third-party-consumable Class-A evidence. Nobody else has done it. *(Constraint: validation is owner-initiated — see [ERC-8004 spec §5](../01-protocols/01-erc8004-trustless-agents.md).)*

2. **Generate evidence, don't re-weight it.** trust8004 and 8004scan compute confidence over the *same* worthless on-chain feedback. A more elegant weighting of forged inputs is still forged. **Arena is the differentiator** — it manufactures inputs that cost real money and real compute to fake. This confirms, from a second direction, that Arena is load-bearing rather than a nice-to-have.

3. **Adversarial liveness with a published methodology.** The [400-agent probe](01-erc8004-reality-on-bsc.md) already found what naive 200-checks miss — the byte-identical-response test (D1) invalidates the headline number of every competitor doing HTTP-200 liveness. **8004scan's own `health_status` was null for 88% of sampled agents and one record was three months stale.** Nobody is actually running this.

**→ The honest differentiation claim narrows from "we score agents better" to "we are the only ones producing evidence worth scoring."** That is a smaller claim and a much more defensible one.

---

## 3. Consequences for build order

- **Do not build a scoring API as the flagship.** Two exist and are free. AiKi's scoring is table stakes; its *inputs* are the product.
- **Study `winsznx/mandate` before designing the mandate layer.** Authority-ceiling-bound-to-trial-result is a better primitive than a static policy, and it composes with the T0 enforcement now confirmed available ([mandate enforcement](../01-protocols/07-mandate-enforcement.md)).
- **Integrate trust8004 and 8004scan scores as *inputs*, labelled by source.** Rendering a competitor's score alongside AiKi's own, with provenance, is more credible than pretending they don't exist — and it directly serves the "Data Quality" criterion.
- **Weight the roadmap toward Arena and the validator role**, away from re-implementing ranking others have shipped.

---

## Sources

GitHub: `winsznx/mandate`, `kaizenbnb/bnb-agent-marketplace`, `gilbertsahumada`, and the six previously-tracked repos (`Ai-Rook/bnb-agent-marketplace`, `0xConsole/bnb-agent-marketplace`, `airway/bnb-era-marketplace`, `daluoboda/agentlens`, `alogotron/assay-bsc`, `Lutviansyah/AgentEra`) · `trust8004.xyz/api/v2` · 8004scan `scores/v5` · TermiX AACP docs · Sourcify.
