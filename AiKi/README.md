# AiKi

> **AiKi** (EYE-kee) — from the Hausa *aiki*: work, deed, job, craft, duty. The word also carries the verb sense *to send, to command*.
>
> **Find the right agent. Know it works. Give it exactly enough power. Let it execute. Prove what happened.**

---

## What this repository is right now

This is the **engineering foundation** for AiKi — the technical research, verified protocol ground truth, system architecture and feasibility analysis that sits underneath the product specification.

It is deliberately not code yet. The product documents (`../docs/`) define *what* AiKi is with unusual clarity. What did not exist was a verified answer to *whether the substrate it assumes is real, how it behaves, and what it costs to build on*. That is what lives here.

The governing rule is stated in the [Research Charter](research/00-method/00-research-charter.md):

> AiKi's product thesis is literally "evidence over claims." A platform that ranks agents by evidence quality, while itself being architected on unverified assertions, would be incoherent at the root.

So every technical fact in this repository is tagged **VERIFIED** (fetched from a primary source, with URL and date), **ASSUMED** (labelled, and only ever built on behind an adapter), or **UNKNOWN** (may not be built on).

## Layout

```
AiKi/
├── research/
│   ├── 00-method/          how we know things, and what is already decided
│   │   ├── 00-research-charter.md    epistemic standard + the questions
│   │   ├── 01-decision-register.md   LOCKED vs DIRECTION vs OPEN
│   │   ├── 02-hard-problems.md       the seven genuinely hard problems
│   │   └── 03-status.md              verified / unknown ledger
│   ├── 01-protocols/
│   │   ├── 01-erc8004-trustless-agents.md   identity spec, verbatim interfaces
│   │   ├── 02-bsc-infrastructure.md         measured live against mainnet
│   │   ├── 03-mcp-2026-07-28.md             the machine surface
│   │   ├── 04-adjacent-standards.md         A2A / AP2 / ACP / SCITT
│   │   ├── 05-erc8183-commerce.md           escrow, deployed and busy
│   │   ├── 06-x402-payments.md              and why USDT does not work
│   │   └── 07-mandate-enforcement.md        what the chain actually guarantees
│   ├── 02-ecosystem/
│   │   ├── 01-erc8004-reality-on-bsc.md     the 400-agent probe
│   │   ├── 02-build-the-era-competition.md  verified mechanics
│   │   ├── 03-bnb-agent-studio.md           the supply question
│   │   └── 04-competitive-teardown.md       your differentiators, already shipped
│   ├── 03-architecture/
│   │   ├── 01-measurement-science.md        Proof Score + Arena math
│   │   └── 02-system-architecture.md        the design
│   ├── 04-feasibility/
│   │   └── 01-feasibility-and-sequence.md   critical path, cost, risk
│   └── _raw/               structured research output + adversarial verdicts
└── docs/
```

## Start here

1. **[Status ledger](research/00-method/03-status.md)** — what is VERIFIED and may be built on, what is UNKNOWN and may not.
2. **[The Seven Hard Problems](research/00-method/02-hard-problems.md)** — the part of AiKi that is actually difficult.
3. **[System architecture](research/03-architecture/02-system-architecture.md)** — the design, with each decision traced to the fact that forced it.
4. **[Feasibility and sequence](research/04-feasibility/01-feasibility-and-sequence.md)** — critical path, cost, risk register.

### The four findings that shaped everything

- **There is no supply.** Zero of 400 sampled BSC agents exposed an invocable endpoint; 30% of the registry points at one static marketing page. [→](research/02-ecosystem/01-erc8004-reality-on-bsc.md)
- **The scoring layer is already commoditised.** trust8004 and 8004scan ship confidence-weighted explainable scores today, free. [→](research/02-ecosystem/04-competitive-teardown.md)
- **Cryptographic mandates are achievable.** EIP-7702 has been live on BSC for 17 months; T0 enforcement is real. [→](research/01-protocols/07-mandate-enforcement.md)
- **Trading leaderboards are statistically void.** Separating 0.5 Sharpe needs ~63 years of data. [→](research/03-architecture/01-measurement-science.md)

## Context

- **Launch ecosystem:** BNB Smart Chain. Explicitly *not* BNB-locked — every chain, registry, wallet, payment rail, runtime and data source is an adapter behind a canonical internal model.
- **Scope:** a complete product suite, not an MVP. Implementation is sequenced; scope is not reduced.
- **Distribution wedge:** BNB Chain's *Build the Era* (submission 9 Sep 2026). A wedge, not the product boundary — AiKi must make sense if the competition vanished tomorrow.

## Source documents

The canonical product definition lives outside this directory, in the workspace `docs/`:

| Document | Role |
|---|---|
| `agent-commerce-master-product-system-spec.docx` | Master Product & System Specification (MPSS v0.1) — 35 sections + appendices |
| `initial_agent_context.md` | Project context and agent handoff |
| `name-lore.txt`, `ideation.txt` | Brand origin and founding notes |

This repository serves those documents. Where research contradicts an assumption in them, the contradiction is recorded explicitly rather than quietly designed around.

---

**AiKi puts agents to work.**
