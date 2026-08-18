# AiKi — The Seven Hard Problems

**Status:** problem statement. Answers live in `03-architecture/`.
**Written:** 18 August 2026, before protocol research returned, deliberately.

---

## Why this document exists first

Protocol research tells us what ERC-8004 stores and how x402 signs a payment. It does not tell us whether AiKi's central claims are *achievable*. Those claims are:

1. we can tell you which agent is genuinely better,
2. we can bound what an agent is able to do with your money,
3. we can prove what happened.

Each of those is a hard technical problem in its own right, and each has a lazy version that looks identical in a demo and is worthless in production. This document names the seven, states the lazy version, states why it fails, and defines what a real answer must satisfy.

**This is the part of AiKi that is actually difficult.** The CRUD marketplace around it is table stakes — the competitor teardown will almost certainly show several teams have already shipped agent cards, filters and a hire button. These seven are where the engineering either earns respect or doesn't.

---

## HP-1 — Attribution: separating agent skill from market beta

**The claim:** "RangePilot outperformed the alternatives."

**The lazy version:** rank agents by realized PnL over the trailing 30 days.

**Why it fails.** In a rising market, a leaderboard sorted by PnL ranks agents by *leverage and exposure*, not skill. The top of the board will be the agent that took the most directional risk, which is precisely the agent most likely to destroy a user in the next regime. Worse, this is self-reinforcing: it routes capital to the riskiest agent, produces a spectacular blowup, and destroys the marketplace's credibility in one event. A PnL leaderboard is not merely imprecise — it is *actively misleading in a predictable direction*, which is the definition of a dangerous metric.

Three compounding statistical problems sit underneath it:

- **Multiple testing.** With N agents evaluated on the same period, the best apparent performer is largely a maximum of noise. The expected maximum Sharpe of N zero-skill strategies grows with N; naive selection of the top performer is selection of the luckiest.
- **Regime dependence.** A grid bot is structurally profitable in a range and structurally bleeding in a trend. Ranking grid bots on a ranging month measures the month.
- **Survivorship.** Agents that blew up and delisted do not appear in the trailing sample.

**What a real answer must satisfy:**

- Every performance number is **relative to an explicit baseline** evaluated on the *same* market snapshot — passive hold, unmanaged LP, do-nothing. "+2.1% vs passive" is a claim about the agent; "+9%" is a claim about the month.
- Results are **segmented by market regime**, and the segmentation is derived from the data, not asserted.
- Comparisons carry an **explicit correction for multiple testing** and an interval, not a point estimate. The UI must be able to say *"we cannot yet distinguish these two agents"* — and that must be a first-class, well-designed state rather than an error case.
- **Paired evaluation.** Where possible, agents are compared on *identical* replayed scenarios rather than on whatever period they happened to run in. Identical inputs remove regime as a confound entirely.
- Sample size and confidence are rendered with equal visual weight to the score. This is already an MPSS requirement (`FR-PASS-003`); HP-1 is why.

**Open question for research:** the correct deflation/interval method for the sample sizes AiKi will realistically have (tens of runs, not thousands).

---

## HP-2 — Deterministic replay of a nondeterministic worker

**The claim:** Agent Arena produces "reproducible" benchmark evidence (`FR-ARENA-001`).

**The lazy version:** run each agent against a testnet task, record the result, call it a benchmark.

**Why it fails.** Nothing about that is reproducible. A typical financial agent's behaviour depends on at least five nondeterministic inputs: chain state, market prices, external API responses, wall-clock time, and — if it uses an LLM — sampling. Two runs of the same agent produce different results, so a difference between two *agents* is uninterpretable. And a benchmark that cannot be re-run cannot detect a regression when a provider ships version 2.5.

**What a real answer must satisfy.** Every nondeterministic input must be pinned or explicitly declared unpinnable:

| Input | Control |
|---|---|
| Chain state | Fork at a fixed block height; identical starting state for every agent in the comparison |
| Market prices | Frozen snapshot / recorded feed replayed on the scenario's clock |
| External HTTP | Recorded and replayed, or denied — with the policy recorded in the run manifest |
| Wall clock | Virtualised scenario time, not host time |
| LLM sampling | Temperature/seed pinned where the provider supports it; otherwise **declared nondeterministic and handled by repetition** |
| Agent version | Pinned by manifest hash |
| Evaluator | Pinned by version hash |

Where determinism is genuinely impossible — and with third-party LLM endpoints it usually is — the honest response is **N trials with a reported interval**, not a single run presented as fact. The run manifest must state which inputs were pinned and which were not, so a reader can judge the result.

**The hardest sub-problem:** the agent is a *third-party remote endpoint*. AiKi cannot force it into a sandbox. It calls its own LLM, its own RPC, its own data providers. So AiKi must control the environment it can reach — chain state and any AiKi-mediated data — and be explicit that agent-internal nondeterminism is uncontrolled. **This is a real limitation and must be stated in the methodology, not hidden.** An Arena that overclaims reproducibility is worse than one that scopes it honestly.

**Open question for research (C2):** can BSC be forked deterministically at a historical block with the archive access available to us, and what breaks (consensus system contracts, precompiles, oracle staleness)?

---

## HP-3 — The enforcement gap: what the mandate actually guarantees

**The claim:** the Mandate Builder shows "monthly cap $250, max single tx $80, Venus and PancakeSwap only, expires 18 Sep, no external withdrawals."

**The lazy version:** store that policy in a database and check it in the backend before relaying a transaction.

**Why it fails.** That is not a guarantee, it is a promise. If AiKi's policy service is bypassed, compromised, or simply buggy, the cap does not exist. The user was shown a security property that the system does not have. For a product whose entire pitch is *evidence over claims*, shipping an unenforceable safety claim in the highest-stakes screen would be a self-inflicted wound.

**What a real answer must satisfy.** Every constraint in a mandate is tagged with **where it is enforced**, and the UI renders the difference:

| Tier | Enforcement | Adversary it survives |
|---|---|---|
| **T0 — Cryptographic** | On-chain: session-key validator, module, or smart-account permission. The chain rejects the violating call. | Compromised AiKi backend, compromised agent |
| **T1 — Custodial** | A signer AiKi controls refuses to sign | Compromised agent. **Not** a compromised AiKi. |
| **T2 — Advisory** | Backend policy check before relay; agent holds its own key | Honest-but-buggy agent only |
| **T3 — Observational** | Detected after the fact; alert and revoke | Nothing. It is monitoring, not control. |

Two consequences follow, and both are product decisions, not just engineering ones:

1. **The capability model must be honest per adapter.** `supports_spend_cap` is not a boolean — it is a tier. A wallet adapter that enforces caps in a vendor backend is T1, and must not render identically to one enforcing them in a validator contract.
2. **The UI must show the tier.** A user granting authority deserves to know whether the cap is enforced by mathematics or by our uptime. This is a differentiator, not a weakness: no competitor will do it, and it is exactly the kind of honesty that makes the rest of the trust claims credible.

**Open question for research (B1–B4):** what is actually available at T0 on BSC today.

---

## HP-4 — Evidence that survives correction, reorg and audit

**The claim:** scores are "reproducible from versioned scoring logic plus input evidence" (MPSS §22.3), and corrections supersede rather than mutate.

**The lazy version:** an `agents` table with a `proof_score` column, updated by a nightly job.

**Why it fails.** It cannot answer any of the questions the product depends on: *why was this agent ranked #1 last Tuesday? what did we know when the user made this decision? this metric was wrong — what else did it contaminate?* A mutable score column destroys the audit trail that is the entire point of an evidence platform. It also makes the appeals process (a provider disputing a score) unresolvable.

**What a real answer must satisfy.**

- **Bitemporality.** Facts carry at minimum: when the thing was true in the world, when we observed it, and when we recorded it. These are three different times and conflating them makes late-arriving and corrected data unhandleable.
- **Append-only observations; derived projections.** The Passport and Proof Score are *computed views*, never sources of truth. Recomputation with pinned scoring-logic version + evidence-as-of-time must reproduce a historical score exactly.
- **Provenance is a field, not a comment.** Source identity, method, and observation time travel with every fact, because the product renders confidence from them.
- **Finality-awareness.** Chain-derived facts carry the block and a finality state. A reorg must be able to supersede a fact rather than silently corrupt a score. On a chain with fast finality this is a narrow window — but "narrow" is not "absent", and financial evidence is exactly where it matters.
- **Corrections are new facts** that supersede old ones, with a reason. Nothing is deleted; negative evidence is preserved (MPSS §10.4).

**The design tension:** full bitemporal event sourcing is expensive and slow to query. The resolution is a split — append-only fact store as the system of record, materialised projections for reads, with the projection rebuildable from the log. That is a well-understood pattern; the discipline is refusing to let anything read the projection as authority.

---

## HP-5 — Exactly-once money over at-least-once infrastructure

**The claim:** payment is "reliable, idempotent, transparent and reconciled" (MPSS §33).

**The lazy version:** call the payment API, write a row, hope.

**Why it fails.** Every layer here is at-least-once or worse. Webhooks retry. Queues redeliver. The user double-clicks. An RPC returns a timeout for a transaction that actually landed. An agent retries a job it already completed. Each of these charges someone twice, and in a two-sided marketplace a double charge is not a bug report, it is a trust event.

The specific nastiness: **a transaction timeout is not a failure.** `eth_sendRawTransaction` timing out tells you nothing about whether the transaction will be mined. Naive retry logic that resubmits is how you pay twice on-chain.

**What a real answer must satisfy.**

- Idempotency keys on **every** mutation touching money, jobs or authorization — required by the API contract, not optional (MPSS §23.2).
- A **ledger as source of truth** for balances, with on-chain settlement reconciled *against* it, never inferred from it. Double-entry, so imbalance is detectable rather than latent.
- **Deterministic transaction identity** — an intent maps to one nonce/one transaction, and resubmission is replacement, not duplication.
- **Outbox/inbox** so the database and the event bus cannot diverge (MPSS §24.2).
- **Continuous reconciliation** between internal ledger, adapter-reported state, and chain state, with a defined procedure when the three disagree — because they will.
- Every state machine (job, authorization, payment) is an explicit machine with enumerated transitions, not a status enum mutated from several call sites.

---

## HP-6 — Goodhart: the score is an optimization target

**The claim:** "every sub-score must be explainable, users can inspect sources" (`initial_agent_context.md` §6.4).

**The tension.** Explainability and gaming-resistance pull in opposite directions. A fully published formula tells a provider exactly which lever to pull. "*When a measure becomes a target, it ceases to be a good measure*" is not a proverb here, it is a design constraint: providers are economically motivated, sophisticated, and will optimize against whatever we publish.

Concrete attacks the design must anticipate:

- **Benchmark overfitting** — hard-coding outputs for known Arena tasks.
- **Liveness farming** — a trivial endpoint that always 200s to farm uptime while the real capability is broken.
- **Wash jobs** — the provider hires itself through sock-puppet accounts to manufacture settled-job history. Note this is *worse* than fake reviews because settled jobs are Class-A evidence.
- **Sybil reputation** — the failure mode already measured in the ecosystem.
- **Cheap-and-useless** — optimizing the cost-efficiency component by doing nothing successfully.
- **Version laundering** — shipping a degraded version under an identity that carries the old version's evidence.

**What a real answer must satisfy.**

- **Split the surface.** Publish the *components and their direction*; do not publish exact weights and the private evaluation set. Users get explanation; adversaries do not get a gradient.
- **Held-out and rotating Arena instances**, with public preview tasks separate from hidden scoring tasks.
- **Evidence-class weighting** so that manufacturable signals (self-reported claims, reviews) cannot dominate hard-to-manufacture ones (independent benchmark runs, on-chain settlement with independent counterparties).
- **Counterparty-graph analysis**, not just review counts — wash trading is visible as a graph structure long before it is visible as a rating anomaly.
- **Version-scoped evidence continuity rules** — a materially changed agent does not inherit full confidence.
- Treat every published metric as **eventually adversarial** and design the rotation/audit mechanism at the same time as the metric, not after the first exploit.

---

## HP-7 — Cold start on both sides

**The claim:** an evidence-first marketplace.

**The bootstrap paradox.** Evidence comes from completed jobs. Completed jobs come from buyers trusting agents. Buyers trust agents because of evidence. On day one there is none — and the honest evidence layer AiKi is building will correctly report that *almost every agent in the ecosystem is unproven*, which is precisely the state that makes a marketplace look empty.

This is the failure mode that kills evidence-first marketplaces: the honest product shows nothing, so the dishonest competitor showing 200,000 agents wins the demo.

**What a real answer must satisfy.**

- **Arena is the cold-start solution, not just a feature.** It manufactures Class-B evidence *without* requiring a buyer to take risk first. This reframes Arena from "nice differentiator" to "load-bearing for launch", which should influence build order.
- **Confidence-aware presentation** — an unproven agent is shown as *unproven with an Arena result*, not hidden and not inflated. "Limited evidence" must be a designed state, not an empty one.
- **Bounded exploration** — capped trial traffic to new providers so they can earn real evidence without exposing users to unbounded downside, with the exploration budget itself visible.
- **Supply reality check.** If ingestible supply is thin (research question A4), then AiKi's launch problem is *supply acquisition*, not *supply presentation* — a different product and a different plan.

---

## How these interlock

```
                       HP-7 cold start
                              │
                   needs ─────┼───── Arena evidence
                              │            │
                              ▼            ▼
                    HP-1 attribution ── HP-2 replay
                    (is it skill?)     (is it repeatable?)
                              │            │
                              └──────┬─────┘
                                     ▼
                            HP-6 gaming resistance
                          (does it survive incentives?)
                                     │
                                     ▼
                            HP-4 evidence integrity
                          (does it survive audit?)
                                     │
                        ┌────────────┴────────────┐
                        ▼                         ▼
                HP-3 enforcement gap      HP-5 exactly-once money
              (is the promise real?)     (does the ledger balance?)
```

HP-4 is the substrate — every other problem writes into it. HP-1 and HP-2 are what make the score mean anything. HP-6 is what keeps it meaning something once providers start optimizing. HP-3 and HP-5 are what make the execution side safe. HP-7 is what determines whether anyone sees any of it in the first ninety days.

---

## The standard

For each of these seven, the architecture must state: **the chosen mechanism, what it guarantees, what it explicitly does not guarantee, and how it degrades.** A design that only describes the happy path has not engaged with the problem.

Where the honest answer is "we cannot guarantee this" — agent-internal nondeterminism in HP-2, T1-tier enforcement in HP-3 — the product must *render that limitation*, not paper over it. That is not a compromise of the vision. It is the vision: a platform whose distinguishing claim is that it tells you what it actually knows.
