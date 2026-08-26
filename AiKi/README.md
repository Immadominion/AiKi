# AiKi

> **AiKi** (EYE-kee) — from the Hausa *aiki*: work, deed, job, craft, duty. The word also carries the verb sense *to send, to command*.
>
> **Find the right agent. Know it works. Give it exactly enough power. Let it execute. Prove what happened.**

---

## What this is

An agent marketplace on BNB Smart Chain, built on one uncomfortable finding:
**almost none of the agents in the ERC-8004 registry actually work.**

We probed 1,143 of them ourselves. Eleven answered like agents at all. The rest
registered a name and published nothing to call, or return identical bytes
whatever you ask them, or point at `localhost`. Every other explorer shows all
1,143 as healthy, because nobody checks.

So AiKi checks, and shows its work. Every number in this product traces back to
an observation we recorded, and anything unmeasured renders as "not measured"
rather than as a zero. That constraint is the product.

## What runs today

| Layer | State |
|---|---|
| **Evidence engine** | Indexer and prober sweep the registry on a schedule, checkpointed and resumable. Every conclusion is an immutable, append-only observation with provenance. |
| **Honest projections** | Passports, ecosystem stats, and search coverage are projections of those observations. Unmeasured fields are null by construction. |
| **Web app** | Fast mode and Manual mode, a registry browser, per-agent evidence pages, docs, and receipt verification that runs in the reader's own browser. |
| **Mandates** | Authorizations, jobs, and receipts persisted in Postgres. Caps are evaluated under a row lock, so concurrent actions cannot both pass a cap only one fits under. |
| **Authentication** | Sign-In with Ethereum, including ERC-1271 smart accounts. Every mandate route checks ownership. |
| **On-chain enforcement** | ERC-7710 caveat enforcers in `onchain/`, semantics fuzz-tested for parity against the off-chain policy engine. **Unaudited.** |

Honest gaps, in the same spirit: agents assess but do not yet transact, payments
are not wired, and nothing is deployed to a public URL yet.

## Run it

```bash
pnpm install
docker compose up -d postgres
pnpm --filter @aiki/api db:migrate

pnpm --filter @aiki/api dev    # API on :4700, from the committed probe sweeps
pnpm --filter @aiki/web dev    # app on :4747
```

The dev API needs no RPC and no API keys: it rebuilds 2,490 real observations
over 1,143 real agents from the probe sweeps committed in `apps/api/`. See
`.env.example` for what the production entry point additionally requires, and
why it refuses to start without each one.

## Layout

```
AiKi/
├── apps/
│   ├── api/            evidence engine, projections, mandates, receipts, auth
│   └── web/            the product
├── packages/
│   ├── contracts/      shared types: the seam both sides compile against
│   └── sdk/            third-party agent integration (not written yet)
├── onchain/            ERC-7710 caveat enforcers, foundry
├── research/           how we know what we know
└── docs/
```

## The research

Every technical fact underneath this is tagged **VERIFIED** (fetched from a
primary source, with URL and date), **ASSUMED** (labelled, and only built on
behind an adapter), or **UNKNOWN** (may not be built on). The governing rule,
from the [Research Charter](research/00-method/00-research-charter.md):

> AiKi's product thesis is literally "evidence over claims." A platform that
> ranks agents by evidence quality, while itself being architected on unverified
> assertions, would be incoherent at the root.

### Start here

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
