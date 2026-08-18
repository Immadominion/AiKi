# The Measured State of ERC-8004 on BNB Smart Chain

**Research verdict:** SOLID
**Measured:** 18 August 2026 (first-party) + arXiv 2606.26028v2 (study window to 13 May 2026)
**Answers:** Charter question **C1**
**Status of every number below:** VERIFIED unless explicitly marked

---

## The headline

> **257,865 ERC-8004 agents are registered on BSC — 61.3% of all mainnet registrations across every chain. In a 400-agent sample spread across that registry, the number exposing a remotely invocable agent endpoint was zero.**

Not "few". Zero.

This is the single most important empirical fact in the AiKi programme. It simultaneously validates the product thesis beyond what the founding documents claimed, and creates the hardest problem the product faces.

---

## 1. The founding claim checks out — and is an upper bound

`initial_agent_context.md` §4 asserts that ~4% of BSC registrations expose a valid registration file with a live service endpoint, and ~59.2% of reviewers show coordinated sybil behaviour.

**Both are verbatim correct.** From arXiv 2606.26028v2 (*Can Trustless Agents Be Trusted?*, Xiong, Li, Wei, Wang, Knottenbelt, Wang — v1 24 Jun 2026, v2 8 Jul 2026), abstract, verbatim:

> "only a small fraction (3%, 4%, and 15% across Ethereum, BSC, and Base) exposing a valid ERC-8004 registration file with at least one live service endpoint"

> "a substantial fraction of reviewers (73.5%, 59.2%, and 90.6% across Ethereum, BSC, and Base) exhibit coordinated Sybil behavior. After removing Sybil-flagged feedback, 15.8%, 77.9%, and 86.8% of rated agents, respectively, are left with no valid feedback."

**Two scope caveats that matter more than the numbers.**

The 4% is a **declaration-based** metric: valid registration file AND ≥1 declared service. It does not mean 4% of agents work. It means 4% *claimed* an endpoint that answered.

The sybil method is a **first-funder heuristic** — a directed funding graph where A→B means A was the first native-token funder of B, with clusters traced to a common root. That over-counts agents funded from a shared exchange or faucet, and under-counts sybils funded independently. It is a reasonable proxy, not ground truth. AiKi should not reproduce this method uncritically (see §6).

## 2. First-party measurement: the 4% is generous

We did not stop at citation. Method:

- Sampled token IDs at 16 offsets (0 → 255,000) across BSC's full registry via the 8004scan API, deduplicated to **400 agents**
- Fetched each agent's full detail record
- **Live-probed every declared service endpoint** (curl, follow redirects, 12s timeout, browser UA)

| Measurement | N=400 | Share |
|---|---:|---:|
| `offchain_uri` present | 400 | 100.0% |
| Registration file resolved | 393 | 98.2% |
| Canonical `registration-v1` type | 369 | 92.2% |
| **Declares ≥1 service** | **161** | **40.2%** |
| Endpoints returning HTTP 200 | 147 / 160 | 91.9% of declared |
| **Genuinely invocable agent services** | **0** | **0.0%** |
| `is_endpoint_verified == true` | 0 | 0.0% |

The 147 HTTP 200s naively read as "36.8% live." That number is an **artifact**, and it decomposes into three distinct failure modes — each of which is a detection rule AiKi can implement.

### 2.1 The static-SPA impostor (141 of 147)

141 endpoints are of the form `https://evoevo.ai/agent/detail?id=<n>`. Response bodies were hashed:

| Request | MD5 |
|---|---|
| `id=4538784` | `2067c4db4f3e15616e96894ef3f89cc0` |
| `id=999999999` | `2067c4db4f3e15616e96894ef3f89cc0` |
| `id=abc` | `2067c4db4f3e15616e96894ef3f89cc0` |

Byte-identical for a valid ID, a nonsense ID, and a non-numeric ID. It is a client-rendered Next.js marketing shell, not a machine-callable service.

**Scale:** `search=evoevo&chain_id=56` returns **77,265 agents — 30.0% of the entire BSC registry** points at this one domain.

Any crawler doing a naive 200-check counts all of them as live. **This is the single largest source of inflation in every ERC-8004 liveness statistic on BSC.**

### 2.2 The unsubstituted template (13 of 400)

13 agents published this on-chain, verbatim, as their A2A endpoint:

```
https://platform-backend.prod.termix.live/api/v1/a2a/agents/{agentId}/card
```

The literal characters `{agentId}` — never interpolated. All 13 return 404. A shipped template bug in a bulk registration pipeline, now permanently recorded on BSC. That was **100% of A2A declarations in the sample.**

### 2.3 The non-remote descriptor (5 of 400)

5 agents declared MCP at `https://q402.quackai.ai/api/mcp/info`. The descriptor is genuine, well-formed, real work:

```json
{"type":"https://eips.ethereum.org/EIPS/eip-8004#service.mcp",
 "name":"@quackai/q402-mcp","version":"0.11.15",
 "transport":"stdio",
 "install":{"npx":"npx -y @quackai/q402-mcp@latest"},
 "tools":[{"name":"q402_pay"},{"name":"q402_batch_pay"},
          {"name":"q402_balance"},{"name":"q402_quote"}]}
```

But `transport: "stdio"`. A POST of a JSON-RPC `initialize` returns **405 Method Not Allowed**. It is a local npm package, not a network-callable agent. Credit where due — this is the highest-quality descriptor in the sample. It still cannot be hired over the wire.

### 2.4 The `data:` URI inflation

**58.3%** of sampled agents inline their registration file as `data:application/json;base64,…`. A `data:` URI resolves with **zero network I/O** — so any "has a resolvable registration file" metric is trivially inflated on BSC and carries no information about operational status.

A handful of `offchain_uri` values are neither URI nor data — they are raw LLM prompt fragments committed on-chain: *"Gluon + ε₀ → Ordinal"*, *"4 forces × 17 particles × 13.8"*, *"Higgs × Sumerian → G"*.

## 3. Reputation on BSC is not thin — it is degenerate

| Chain | Feedbacks | Agents | Per agent |
|---|---:|---:|---:|
| Base (8453) | 438,609 | 43,227 | 10.1 |
| Ethereum (1) | 3,217 | 30,588 | 0.11 |
| **BSC (56)** | **11,705** | **257,865** | **0.045** |

A 100-record BSC feedback sample:

- **21 unique reviewer addresses.** Top reviewer authored 23 of 100; second 12 of 100.
- **0 of 100** carried a comment. 30 of 100 had an empty `feedback_uri`.
- Score distribution is degenerate: **66 of 100 scored exactly 70**, then 60(×10), 80(×7), 100(×5), 85(×3), 82(×3).

The paper's chain-wide figures are worse. BSC: 29,444 feedback records from **76 unique reviewers — 387.4 reviews per reviewer.** (Ethereum: 4.9. Base: 40.0.) That ratio is the clearest wash-reputation signature in the dataset.

And, verbatim from the paper:

> "The share of records with no payment proof and no task linkage reaches 98.7% on ETH, **100.0% on BSC**, and 99.3% on Base."

**Not one BSC feedback record in the study window was grounded in a verifiable interaction.**

Cost to move an agent past a τ=90 trust threshold — median, from the paper's Table 6:

| Chain | Cost |
|---|---:|
| Ethereum | $0.055 |
| **BSC** | **$0.0042** |
| Base | $0.0027 |

> "the median agent reaches τ with a single ceiling-valued feedback"

**BSC reputation costs less than half a cent to fake.** Any product that renders an ERC-8004 reputation average as a trust signal is knowingly showing users a number that costs $0.0042 to forge.

## 4. Cross-chain reputation does not transfer

Among agents declaring multi-chain registration, reputation scores are **uncorrelated** across chain pairs:

| Pair | n | Spearman ρ | p |
|---|---:|---:|---:|
| BSC–Base | 159 | 0.05 | 0.56 |
| ETH–Base | 28 | 0.14 | 0.48 |

> "each chain constitutes an isolated reputation silo."

Small samples, so treat as *suggestive of null* rather than proven — but there is certainly no evidence of portability. **Reputation portability is an open product opportunity, not a solved primitive.**

## 5. Corroboration from an independent study

arXiv 2606.12128 (*From Agent Identity to Agent Economy*, Mafrur & Khusumanegara, 10 Jun 2026) studied 10,000 Ethereum agents, blocks 24,339,925–24,839,925:

- agents with service records: **67 (0.67%)**
- agents with feedback: **628 (6.28%)**
- **full evidence across all four layers: 19 (0.19%)**
- top client authored 645 of 980 feedback records (**65.82%**), HHI 0.436, Gini 0.783
- ownership: 394 wallets for 10,000 agents; largest single wallet held **779**; top-10 = 51.40%; Gini 0.863

*Caveat: this paper reuses a third-party dataset rather than crawling independently.*

Two independent studies plus our own probe converge on the same conclusion: **registration-heavy, operationally empty.**

## 6. What this means for AiKi

### 6.1 The thesis is not just validated — it is understated

The founding documents argued identity ≠ trust. The measurement is stronger than that: **on BSC, identity ≠ existence.** 30% of the registry points at one static marketing page. Reputation costs $0.0042 to forge and 100% of it is ungrounded.

The positioning writes itself, and it is now defensible with first-party evidence rather than borrowed statistics:

> Everyone else counts registrations. We probe them.

### 6.2 …and it creates the hardest problem in the programme

**If zero of 400 sampled agents are hireable, AiKi has no supply.** A marketplace whose honest evidence layer correctly reports "nothing here works" is a beautifully engineered empty room.

This is **HP-7 (cold start)** in its sharpest possible form, and it escalates from a launch risk to *the* strategic problem. It forces a decision the founding documents did not anticipate:

| Path | What it means |
|---|---|
| **A. Supply acquisition** | AiKi recruits and onboards real agents directly — provider platform becomes launch-critical, not phase-two |
| **B. Supply creation** | AiKi ships first-party reference agents for the four categories, proving the loop with real work |
| **C. Ecosystem-wide honesty** | AiKi indexes everything and is the only surface that tells the truth about it — value is the *filter*, not the catalogue |

These are not exclusive, and C is essentially free given the ingestion work. **B is likely mandatory for a working demo** — you cannot demonstrate intent → mandate → execution → receipt against an ecosystem where nothing answers. This directly affects build order and should be an explicit decision, not a discovery made in week four.

*Recommendation (labelled as such): B + C. Ship first-party agents in each of the four judged categories to make the loop real, while indexing the full ecosystem and being the only product that reports its actual state. That satisfies the competition's "Agent Diversity" and "Data Quality" criteria simultaneously — and the honesty is the differentiator, not a caveat.*

### 6.3 Detection rules to implement on day one

Each derived from an observed failure, not theorised:

| # | Rule | Catches |
|---|---|---|
| **D1** | Probe each endpoint with a **valid ID and a nonsense ID**; if responses are byte-identical, it is not agent-specific. Flag `IMPOSTOR_STATIC`. | The 141 evoevo shells — 30% of BSC |
| **D2** | Reject endpoints containing unexpanded `{…}` placeholders **before indexing**. | The `{agentId}` template bug |
| **D3** | Treat `transport: "stdio"` as **declared-but-not-remotely-invocable**. A distinct state from "live". | The q402 descriptors |
| **D4** | `data:` URIs resolve trivially — **exclude from any "resolvable" metric**. | 58.3% inflation |
| **D5** | Require content-type and a capability handshake, not HTTP 200. **200 is not liveness.** | All of the above |
| **D6** | Reviewer concentration: reviews-per-unique-reviewer, first-funder clustering, and **degenerate score distributions** (66% identical value is a signature). | Wash reputation |
| **D7** | Weight feedback by **payment proof / task linkage**. On BSC that zeroes 100% of existing feedback — which is the correct answer. | Ungrounded reputation |

D1 deserves emphasis: **it is a genuinely novel liveness test**, it was discovered by measurement rather than reasoning, and it invalidates the headline statistic of every competitor doing naive 200-checks. It belongs in the Proof Score from the first commit.

### 6.4 The open position

> Across 400 agents: `is_endpoint_verified` true for **0**. `endpoint_verified_at`, `endpoint_verified_domain`, `endpoint_verification_error` all null. `health_status` null for 352/400 (88%). Where populated, one record's `checked_at` was **2026-05-08 — three months stale**, with status `"skip"`.

The fields exist as schema. Nobody has populated them.

**Nobody in this ecosystem is running continuous liveness verification.** That is not a solved problem AiKi would be duplicating — it is an unoccupied position, and it is precisely the "Data Quality" criterion the competition scores.

## 7. Data sources AiKi can ingest

### 7.1 8004scan REST API — open, unauthenticated, undocumented

Found by probing. `/api/v1/openapi.json`, `/api/v1/docs` → 404, so it is undocumented rather than absent. FastAPI backend (422 errors leak path param types). No API key, no rate limit encountered at 12 concurrent requests.

```
GET /api/v1/agents?limit=&offset=&chain_id=&is_testnet=&search=
    → {items:[…], total, limit, offset}
GET /api/v1/agents/{chain_id}/{token_id}
GET /api/v1/agents/{chain_id}/{contract_address}/{token_id}
GET /api/v1/chains          → 60 chains with provider status
GET /api/v1/feedbacks?limit=&chain_id=
```

404 on: `/stats`, `/networks`, `/leaderboard`, `/validations`, `/search`, `/agents/stats`, `/protocol/stats`. `sort=` / `order=` are accepted but appeared to be **ignored** — do not rely on them.

> ⚠️ **Dependency risk.** This is an undocumented API on a third party's infrastructure with no contract, no SLA and no versioning. It is excellent for bootstrapping and unacceptable as a permanent single point of failure. AiKi must index the registry contracts directly and treat 8004scan as one `IndexerSourceAdapter` among several — exactly the posture the MPSS already mandates.

> ⚠️ **Counting trap.** The homepage's "420,666+ Registered Agents" is the **mainnet-only** figure. The raw API total (740,449) includes 319,426 testnet registrations. Always pass `is_testnet`.

### 7.2 The Graph — Agent0 subgraphs (structured alternative)

`github.com/agent0lab/subgraph`. Requires an API key (unauthenticated POST → `auth error: missing authorization header`).

```
https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>
```

| Chain | Subgraph ID |
|---|---|
| Ethereum (1) | `FV6RR6y13rsnCxBAicKuQEwDp8ioEGiNaWaZUmvr1F8k` |
| **BSC (56)** | **`D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K`** |
| Base (8453) | `43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb` |
| Polygon (137) | `9q16PZv1JudvtnCAf44cBoxg82yK9SSsFvrjCY9xnneF` |
| Monad (143) | `4tvLxkczjhSaMiqRrCV1EyheYHyJ7Ad8jub1UUyukBjg` |
| BSC Chapel (97) | `BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z` |
| Sepolia (11155111) | `6wQRC7geo9XYAhckfmfo8kbMRLeWU8KQd3XsJqFKmZLT` |
| Base Sepolia (84532) | `4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u` |
| Monad Testnet (10143) | `8iiMH9sj471jbp7AwUuuyBXvPJqCEsobuHBeUEKQSxhU` |

Entities: `Agent`, `Feedback` (score 0–100, tags, revocation), `Validation`, `Protocol`.

### 7.3 Registry contracts — deterministic across all chains

| Registry | Address (identical on every chain) |
|---|---|
| Identity | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Reputation | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

Vanity-prefixed `0x8004…` deterministic deployment across Ethereum, BSC, Base, Arbitrum, Optimism, Polygon, Linea, Scroll, Avalanche, Celo, Gnosis, Monad, Abstract, Mantle, Soneium, Taiko. Corroborated three ways: the paper's Table 1, the `awesome-erc8004` deployment table, and every live BSC agent record carrying `contract_address 0x8004a169…`.

*Independent verification of these addresses against BscScan is in flight (round-2 research, `erc8004-deployments`). Do not write a migration against them until that lands.*

BSC indexing range per the paper: blocks **79,027,200 – 98,121,735**.

## 8. Standing caveats

- **EIP-8004 is still `Draft`** (created 2025-08-13). Claims that it was "finalized in October 2025" are contradicted by the EIP page itself. **The spec can change under anyone building on it.** Version every adapter.
- The EIP page does not publish consolidated `IIdentityRegistry` / `IReputationRegistry` blocks. Parameter types and ordering **must** be read from `github.com/erc-8004/erc-8004-contracts` before integration code is written. *(Round-2 research owns this.)*
- Our 400-agent sample is 0.16% of BSC. It **understates ownership concentration** — a whale holding thousands would appear only a few times. The EvoEvo 30.0% platform share is the more reliable concentration signal.
- Framework-attribution counts (olas 5,005; virtuals 570; eliza 8) are substring searches over name/description. Order-of-magnitude only. The reliable signal: **BSC's agents are not coming from established agent frameworks** — they are bulk registrations from EvoEvo, Termix and QuackAI.
- Third-party aggregate claims (RNWY "150K+ agents", Agent0 "106,996 indexed") could not be confirmed at primary sources and are **UNVERIFIED**.

---

## Sources

| Source | URL |
|---|---|
| Xiong et al., *Can Trustless Agents Be Trusted?* | https://arxiv.org/abs/2606.26028 · https://arxiv.org/html/2606.26028 |
| Mafrur & Khusumanegara, *From Agent Identity to Agent Economy* | https://arxiv.org/abs/2606.12128 |
| EIP-8004 | https://eips.ethereum.org/EIPS/eip-8004 |
| 8004scan API | https://8004scan.io/api/v1/agents · /chains · /feedbacks |
| Agent0 subgraphs | https://github.com/agent0lab/subgraph |
| awesome-erc8004 | https://github.com/sudeepb02/awesome-erc8004 |
| EvoEvo endpoint probe | https://evoevo.ai/agent/detail?id=… |
| QuackAI MCP descriptor | https://q402.quackai.ai/api/mcp/info |
