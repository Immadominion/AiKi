# Protocol Engineer — Onboarding & Work Breakdown

Welcome. This gets you productive in about two hours of reading, and lists everything you own.

---

## 1. What AiKi is, in one paragraph

BNB Chain runs a competition to build the official marketplace for its Agent Studio agents. There are ~269,718 AI agents registered on BSC via ERC-8004. **We sampled 400 of them and probed every declared endpoint: none exposed a working service.** 30% of the registry points at a single static marketing page that returns byte-identical bytes for a valid ID, a nonsense ID, and a non-numeric ID. On-chain reputation costs **$0.0042** to forge, and 100% of BSC feedback records carry no proof that any work happened.

So AiKi is not a directory. **AiKi is the layer that finds out what is actually true, gives an agent exactly enough authority to do a job, and produces a receipt proving what happened.**

Product line: *Find the right agent. Know it works. Give it exactly enough power. Let it execute. Prove what happened.*

---

## 2. Read these, in this order (~2 hours)

| # | Document | Why |
|---|---|---|
| 1 | [`research/00-method/03-status.md`](../research/00-method/03-status.md) | **Start here.** What is VERIFIED vs UNKNOWN. Nothing marked UNKNOWN may be built on. |
| 2 | [`research/02-ecosystem/01-erc8004-reality-on-bsc.md`](../research/02-ecosystem/01-erc8004-reality-on-bsc.md) | The 400-agent probe. Explains why the product exists. |
| 3 | [`research/01-protocols/02-bsc-infrastructure.md`](../research/01-protocols/02-bsc-infrastructure.md) | Measured chain facts. Will save you a week of surprises. |
| 4 | [`docs/01-api-contract.md`](01-api-contract.md) | **The seam.** What you must produce. |
| 5 | [`research/03-architecture/02-system-architecture.md`](../research/03-architecture/02-system-architecture.md) | The design, each decision traced to the fact that forced it. |
| 6 | [`docs/00-ownership-and-workflow.md`](00-ownership-and-workflow.md) | How we work together. |

Then skim, as reference when you touch the area: `01-protocols/01` (ERC-8004 interfaces), `05` (ERC-8183), `06` (x402/`$U`), `07` (mandate enforcement).

**Everything is cited.** If a claim looks wrong, follow the source URL — and if it *is* wrong, say so loudly. That is how this repo is supposed to work.

---

## 3. The nine facts that will bite you

These cost real debugging time. All verified by direct RPC.

1. **`totalSupply()` reverts** on the canonical IdentityRegistry — it is not ERC721Enumerable. You cannot scan `1..totalSupply`. **Index `Registered` events.**
2. **No event params are indexed** on `Registered`/`URIUpdated`, and `NewFeedback` indexes only `tag1` — **per-agent log filters are impossible.** Index the full stream, shard downstream.
3. **`eth_getLogs` is disabled** on public BSC dataseeds. Caps elsewhere are 5k (publicnode) to 50k (NodeReal). At 0.45s/block, a 10k window is **75 minutes** of chain.
4. **USDT-BSC is 18 decimals, not 6**, and implements **neither** EIP-3009 nor EIP-2612. A 6-decimal assumption is wrong by 10¹². The working settlement asset is **`$U`**.
5. **The ERC-8183 deployed ABI diverges from the EIP**: `fund(uint256,uint256,bytes)` and `setProvider(uint256,address,bytes)`. Build from the deployed ABI.
6. **BSC block `timestamp` is second-resolution** and spans ~2.2 blocks. Use the non-standard **`milliTimestamp`** field. Generic EVM indexers drop it silently.
7. **`finalized` lags `latest` by 2 blocks**; worst-case honest reorg is 8 (`turnLength`). Index against `finalized`.
8. **anvil forks BSC fine but needs `--evm-version prague`** — ~1.5% of BSC txs are EIP-7702 type-4 and full-block replay dies without it.
9. **The spend-limit policy module is a LIFETIME cap**, not rolling — `alreadySpent` is monotonic with no `block.timestamp`. **Never render "per month".**

---

## 4. Verified addresses (chain 56)

⚠️ **Never store these as chain-agnostic constants.** Config keyed by chain ID, asserted at startup — a global constant corrupts silently when we add a chain.

| Contract | Address |
|---|---|
| ERC-8004 IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| ERC-8183 AgenticCommerce (proxy) | `0xEa4DAa3100A767e86FDed867729ae7446476EBA6` |
| ↳ implementation (pin + assert) | `0xd5f9b570c96b5d67702d508c0bfb8b3b09209787` |
| EvaluatorRouter (also the `IACPHook`) | `0x51895229E12F9876011789B04f8698af06cCD6DA` |
| `$U` "United Stables" (18dp, EIP-3009) | `0xcE24439F2D9C6a2289F741120FE202248B666666` |
| Rhinestone SmartSession | `0x00000000008bDABA73cD9815d79069c247Eb4bDA` |
| Altana KeyStore | `0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a` |
| Altana KeyStoreController | `0x0834Ee2C9BdC3E3efF0a2dC34393D4B0e546A555` |
| EntryPoint v0.8 | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` |

**Do NOT use** `0xfA09B3397fAC75424422C4D28b1729E3D4f659D7` — that is BRC8004, a dead community re-deployment with 26 agents, one of which is named "Test".

Event topics:
```
Registered   0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a
NewFeedback  0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc
```

---

## 5. Your work, in dependency order

### 🔴 P0 — Blocker, do first (half a day)

**T-01 · Verify a bundler and paymaster serving chain 56.**
Nobody has confirmed one. A smart-account architecture with no bundler has **no execution path**, so this gates the entire mandate layer. Check Pimlico, ZeroDev, Biconomy, Alchemy, thirdweb for real chain-56 support. Write findings into `research/01-protocols/07-mandate-enforcement.md` and open ADR-006.

**T-02 · Read Altana's spend-cap validator source.**
We confirmed KeyStore is *deployed* and CertiK-audited, but did **not** read the module proving the cap reverts in the EVM. We are about to tell users "T0, chain-enforced". Verify that before the UI says it. Also confirm whether `permissions.spend.period` gives us the rolling window that Rhinestone lacks.

### 🟠 P1 — Evidence spine (days 1–6)

**T-03 · Ingestion.** NodeReal archive ($39/mo, archive on all tiers). Backfill `Registered` events from block 79,027,200 → tip. Chunked, resumable, **cap-probing** (parse provider error strings to auto-tune chunk size). Follow `finalized`. Key by `(blockNumber, logIndex)`; wall-clock from `milliTimestamp`.

**T-04 · Registration-file resolver.** Resolve `agentURI` for every agent — `https` / `ipfs` / `data`. Parse per the ERC-8004 schema. Never trust the file's self-declared identity; always resolve top-down chain → URI → file.

**T-05 · Prober.** The differentiator. Multi-region, and implement every detection rule:
- **D1** valid-ID vs nonsense-ID byte comparison → `IMPOSTOR_STATIC`
- **D2** reject unexpanded `{…}` placeholders
- **D3** `transport: "stdio"` → `NOT_REMOTE`
- **D4** exclude `data:` URIs from "resolvable" metrics
- **D5** capability handshake, not HTTP 200
- **D8** `/.well-known/agent-registration.json` reciprocal proof (only 0.04% have it)
- **D9** verify A2A card JWS (detached, RFC 8785 canonical, defaults removed)

**T-06 · Evidence store.** Append-only bitemporal `Observation` table (schema in the architecture doc). Insert-only; corrections supersede. Every row carries `source`, `method`, `evidenceClass`; chain rows carry `finality`.

**T-07 · Proof Score.** Wilson LB + Beta accumulation + empirical-Bayes shrinkage. **Pin `z` in config and record it in `scoring_version`** — a `z=1.6449` implementation against a `z=1.96` golden table deadlocks the test suite on day one.

**T-08 · Classifier.** Bucket agents into the four categories. The registry has no category field, so this is text classification over name/description/manifest. Keyword matching gives yield 132 / rebalancing 40 / grid 10 / health-factor 4 as a **lower bound**.

**T-09 · Serve `/v1/stats`, `/v1/search`, `/v1/agents/{id}/passport`** per the contract. **Highest demo value per hour of work** — ship these first.

### 🟡 P2 — Reference agents (days 5–12, parallel)

**Forced scope.** Health factor has 4 agents on all of BSC; grid has 10. "All four categories with equal depth" is unachievable by indexing.

**T-10 · Health-factor agent** — Venus. Monitor account liquidity, repay on threshold. Comptroller `0xfD36E2c2a6789Db23113685031d7F16329158384`. A `repayBorrow` costs **153,929 gas ≈ $0.0055**.
**T-11 · Grid agent** — PancakeSwap v3.
**T-12 · Register both** on ERC-8004 with valid registration files and working `/.well-known` reciprocal proofs — i.e. be the agents we wish existed.

### 🟢 P3 — Authority & commerce (days 8–16)

**T-13 · Policy compiler.** AiKi policy → SmartSession policies or Altana session grant. Emit the **enforcement tier per constraint**.
**T-14 · Deploy `TimeFramePolicy`** — it is not on chain 56. Also `UsageLimitPolicy`, `ValueLimitPolicy` if needed.
**T-15 · Session lifecycle** — grant, spend tracking, instant revoke.
**T-16 · ERC-8183 adapter** from the **deployed ABI**, implementation pinned and asserted at startup.
**T-17 · `$U` settlement** + x402 v2 (`@x402/*` 2.23.0, CAIP-2 networks). Token capability flags in config.
**T-18 · Ledger.** Double-entry, idempotency keys, three-way reconciliation (ledger ↔ adapter ↔ chain). **A tx timeout is not a failure** — one intent, one nonce, resubmission is replacement.

### 🔵 P4 — Proof & Arena (days 14–19)

**T-19 · Receipts** — SCITT (RFC 9943) / COSE (RFC 9942) profile, `reference` = mandate hash.
**T-20 · Job SSE stream** per contract §6.
**T-21 · Arena harness** — `anvil --fork-block-number <pinned> --evm-version prague`. Paired replay: every agent on identical scenarios. Report intervals. **Never a Sharpe leaderboard.**
**T-22 · ERC-8004 validator** *(stretch, high strategic value)* — write Arena/liveness verdicts as `validationResponse`. Zero validators exist network-wide. Note it is owner-initiated, so it needs provider cooperation.

---

## 6. Stack

Proposed, not dogma — argue if you disagree, but decide fast and write an ADR.

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 24) | Shared types with the frontend across the seam |
| API | Hono or Fastify | Light, fast, good SSE |
| DB | Postgres | Append-only evidence + JSONB provenance |
| Queue | pg-boss or BullMQ | Don't add Kafka for this |
| Chain | viem | Modern, typed, good BSC support |
| Indexer | custom over NodeReal | Ponder auto-tunes ranges — worth evaluating |
| Contracts | Foundry | anvil is already the Arena harness |

**Constraint:** the frontend consumes `packages/contracts`. Whatever you choose must emit those types.

---

## 7. Access you need

| | |
|---|---|
| GitHub | `github.com/Immadominion/AiKi` — ask Joel for the invite |
| NodeReal | archive RPC, $39/mo — **first spend, do it day one** |
| 8004scan | API key is in `.env` at the workspace root (gitignored). ⚠️ Currently returning anonymous limits — activation pending. |
| BSC wallet | your own, for testnet then mainnet |
| Telegram | the team channel |

---

## 8. How we know things

The rule that governs this repo:

> Every technical fact is **VERIFIED** (fetched from a primary source, URL + date recorded), **ASSUMED** (labelled, only built on behind an adapter), or **UNKNOWN** (may not be built on).

AiKi's product thesis is *evidence over claims*. Architecting it on unverified assertions would be incoherent at the root — so if you can't cite it, mark it UNKNOWN and move on. **A missing fact is fine. A fabricated one is not.**

Both foundational standards are still **Draft** and one already diverges from its deployed implementation. Isolate everything behind adapters, pin versions and addresses, assert at startup.
