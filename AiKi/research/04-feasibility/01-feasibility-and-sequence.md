# Feasibility and build sequence: August proposal

**Written:** 18 August 2026 · **Deadline:** 12:00 UTC 9 September 2026 - **22 days**

**Status:** historical estimates and sequencing, not the current implementation plan. The 22-day window is measured from the written date. No cost or delivery estimate was revalidated in the 8 September framing update.

## Current scope and priorities

AiKi is a marketplace for humans and AI agents to get work done together. [PRODUCT.md](../../docs/PRODUCT.md) defines the current scope. Production quality means that participants can discover and hire, agree on the work, deliver it, review it and pay, with understandable handoffs and recovery when something fails. It does not require every proposed feature in the original MPSS.

The evidence-first sequence below is superseded as a product priority. Probing, identity, budgets and evidence support usable work; completing Arena, a composite score or a validator service is not a prerequisite for the marketplace workflow. Fast and Manual must lead into the same marketplace, and human participation must include actual work rather than only approvals.

For planning, first identify the broken or missing step in a real job. Check discovery and provider availability, the brief and quote, acceptance and handoff, delivery and review, then settlement and recovery. Apply authorization research when a job needs delegated permissions, and measurement research when a particular hiring claim needs support. This is a prioritisation rule, not a declaration that those steps have passed.

For the BNB competition, the four-category requirement remains separate from AiKi's broader participant model. The original acceptance list in section 6 proposed one category end to end; that is not sufficient evidence of equal depth across all four categories.

---

## 1. The honest assessment

**The complete MPSS scope is a 12–24 month build for a funded team.** That is not a criticism of the spec - it is a correct specification of a platform. It is not deliverable in 22 days by any team.

What *is* deliverable in 22 days is a **narrow, genuinely working vertical slice** that demonstrates the thesis end to end and is defensible on the rubric. The research has made the choice of slice unusually clear, because it eliminated the obvious options:

| Tempting slice | Why research kills it |
|---|---|
| Index 257k agents, show cards | Zero of 400 sampled are invocable. It's an empty catalogue with good typography. |
| Ship a better trust score | trust8004 and 8004scan already ship confidence-weighted, explainable scores **for free**. |
| Broad coverage of all four categories | Supply is 132/40/10/**4**. Coverage is not obtainable by indexing. |
| A leaderboard of trading agents | **~63 years of data to separate 0.5 Sharpe.** Statistically void. |

The August proposal chose evidence generation, replay and constrained authority as its focus. That recommendation is retained here as history, not the current definition of AiKi or a supported claim of market exclusivity.

---

## 2. The critical path proposed in August

```
O-3 bundler/paymaster verification   ← BLOCKS EVERYTHING BELOW
        │
        ▼
Ingestion (Registered events → Observations)
        │
        ├──► Prober + D1–D9 detection ──► Passport ──► Proof Score
        │                                                  │
        ▼                                                  ▼
Policy compiler → session grant (T0) ──► Mandate Builder UI
        │
        ▼
ERC-8183 adapter (deployed ABI) + $U settlement
        │
        ▼
Execution → Receipt (SCITT profile)
        │
        ▼
Arena paired replay (anvil --evm-version prague)
```

O-3 was treated as blocking when this sequence was written. The [19 August execution-path study](../01-protocols/08-execution-path.md) subsequently resolved it and revised the lifetime-cap recommendation. The diagram is preserved as the original dependency model, not an instruction to repeat that work.

---

## 3. Original phase estimates

The dates, deliverables and priorities below are proposals made on 18 August. They do not establish that a registry-wide sweep, mainnet settlement, benchmark or submission artifact was completed.

### Phase 0 - unblock (days 1–2)

| Task | Why |
|---|---|
| **Verify a bundler + paymaster on chain 56** (O-3) | Blocks the entire T0 path |
| **Read Altana's spend-cap validator source** (O-2) | The T0 claim in the UI must be true |
| **Request Terms of Participation** (O-1) | **Founder.** IP/licensing unknown and unbackfillable |
| Claim 8004scan Pro (`forms.gle/jQevEPCAacBXaKG79`) | 500 req/min, free for participants |
| Pin NodeReal archive ($39/mo) | Everything downstream needs it |
| Note **Pasteur hardfork 25 Aug** | Mandatory; pin client v1.7.7 |

### Phase 1 - evidence spine (days 3–8)

Ingestion over `Registered` events (**not** `totalSupply` - it reverts). Append-only Observations with provenance and finality. Prober with D1–D9. Passport projection. Wilson/Beta scoring with `z` pinned.

**Deliverable:** *"We probed all 269,718 BSC agents. Here is what actually works."* - that sentence alone is the Data Quality criterion, and nobody else can say it.

### Phase 2 - reference agents (days 6–12, parallel)

**Forced scope.** Health factor has 4 agents on all of BSC; grid has 10. Build AiKi-operated agents in the thin categories - health factor (Venus) and grid (PancakeSwap v3) first, since those are emptiest.

These serve four purposes simultaneously: they satisfy Agent Diversity, they make the demo real, they generate Class-A/B evidence, and they are the TermiX track's "3 real tasks run both ways."

### Phase 3 - authority + commerce (days 9–16)

Policy compiler → SmartSession/Altana session grant with **tier surfaced**. Deploy `TimeFramePolicy` (not on 56). **Lifetime caps only** - do not claim "per month". ERC-8183 adapter from the **deployed ABI** with implementation pinned. `$U` settlement, decimals from config.

### Phase 4 - loop + proof (days 14–19)

Mission Control. Execution Receipt as a SCITT profile bound to the mandate hash. Arena paired replay for one category, honest intervals.

### Phase 5 - submission (days 19–22)

Public deployment (an eligibility condition during judging). Telemetry for "real-world usage". Agent Advantage Report for TermiX. Submit early - the form accepts "Working MVP".

---

## 4. Cost estimate recorded in August

| Item | Monthly |
|---|---|
| NodeReal archive (Growth) | **$39** |
| 8004scan Pro | $0 (participant) |
| Hosting + DB | ~$50–150 |
| LLM (intent parsing, classification) | ~$50–200 |
| Chain gas (receipts, validations, agent execution) | **~$5–20** - a Venus repay is $0.0055 |
| **Total** | **~$150–400/month** |

Infrastructure cost is not a constraint. **Engineering time is the only real one.**

---

## 5. Original risk register

R8's custom-policy assumption was superseded by the execution-path follow-up. R2 describes the registry-supply concern at the time, not all possible human or agent supply. The remaining entries retain their original severity and need current review before use as an operational risk register.

| # | Risk | Severity | Response |
|---|---|---|---|
| R1 | **IP terms unknown** - could force the trust core open-source | **High** | Get the Terms. Fallback: open front end + documented API boundary, engine behind a service |
| R2 | **No supply** - nothing hireable exists | **High** | Reference agents (Phase 2). Non-negotiable. |
| R3 | **Differentiators already shipped** by trust8004/8004scan/winsznx | **High** | Compete on evidence *generation*, not scoring. Ingest theirs as labelled inputs. |
| R4 | Both standards are **Draft**; deployed ABI already diverges | Medium | Adapters + pinned implementation addresses + startup assertions |
| R5 | **`$U` liquidity unknown** | Medium | Answer before checkout UX. |
| R6 | 22 days | **High** | Narrow slice. Working loop over broad footprint. |
| R7 | Commerce proxy is **upgradeable/pausable/owner-controlled** | Medium | Surface in Passport risk. Monitor `Upgraded` events. |
| R8 | Rolling-window caps need custom fund-holding code | Medium | **Don't write it under deadline.** Lifetime caps ship. |
| R9 | 8004scan is undocumented, no SLA, `/agents/search` 502'd | Medium | Own indexer authoritative; 8004scan behind a circuit breaker |
| R10 | Pasteur hardfork **25 Aug**, mid-build | Medium | Pin v1.7.7; test the fork boundary |

---

## 6. Original proposed acceptance criteria

The original list emphasised proof and constrained execution:

1. Every agent shown has been **probed**, with the method published - including the byte-identical-response test that invalidates every naive liveness number in the ecosystem.
2. Every score shows **confidence**, and "we cannot yet distinguish these" is a designed state.
3. Every mandate shows **where it is enforced** - and the T0 ones are genuinely chain-enforced.
4. At least one category runs **end to end**: intent → mandate → execution → receipt, with real `$U` on mainnet.
5. Arena shows **paired replay** on identical scenarios with honest intervals - never a Sharpe leaderboard.
6. The submission **corrects BNB's own stale statistic** (35.1% across 60 chains, not 60% across 26) as a Data Quality signal.

These checks address only part of marketplace readiness. They do not establish complete hiring, human-agent handoffs, delivery, review, payment and recovery, or equal depth across the four competition categories. Use the current product definition to assess what is missing rather than treating this list as completion criteria.

---

## 7. Longer-term options

Workflow authoring, enterprise features, additional clients and multi-chain support were proposed in the original MPSS. Each needs a demonstrated marketplace use case and an implementation decision; completing the August sequence does not guarantee they can be added without rework.

The research also proposed an ERC-8004 validator service based on the empty-registry snapshot. It remains an optional quality-infrastructure direction to reassess against demand, provider cooperation and maintenance cost. The marketplace for humans and agents remains the product whether or not that service is built.
