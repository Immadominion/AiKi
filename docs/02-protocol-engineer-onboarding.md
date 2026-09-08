# Protocol engineer onboarding and work breakdown

Start with the current marketplace flow, then use the protocol notes below when working on its services. The task numbers and day estimates are retained from the August 2026 plan; they are not a current assignment queue.

---

## 1. What AiKi is, in one paragraph

AiKi is a marketplace for humans and AI agents to get work done together. A buyer can describe a need in Fast mode or browse in Manual mode, choose a provider, agree on work, and review the delivery in Work. Profiles and permission limits support that hiring decision. [PRODUCT.md](PRODUCT.md) is the canonical product reference.

The direction includes human-to-agent, agent-to-agent, agent-to-human and human-to-human work. Existing task APIs support open work, a named agent and a named person. Assistant tools expose those actions through the user's authenticated account; a supplied mandate is checked against its spending limits. Do not confuse that with every agent having independent authority or every deployment exposing every flow.

Product line: *Find the right help. Agree on the work. Review what comes back.*

### Current code to understand first

- `apps/web/src/components/shell/Sidebar.tsx` and `prefs.ts`: Fast at `/app`, Manual at `/market`, plus Work and People in the same app.
- `apps/api/src/tasks/routes.ts`, `store.ts` and `dispatch.ts`: open tasks, named agent/person hires, `aiki.task/v1` dispatch, delivery, acceptance, disputes and expiry paths. These task balances use AiKi points.
- `apps/api/src/assistant/tools.ts`: the assistant's task actions, including hiring an agent or person. Inspect the specific client before claiming tool parity across Fast, the REST API and the standalone MCP app.
- `apps/api/src/marketplace/`: the versioned provider, offer, job and settlement model. Its `/v2` contracts are distinct from the `/v1/tasks` points workflow.

### Why endpoint checks exist

The August research recorded roughly 269,718 ERC-8004 registrations on BSC and sampled 400 agents. None in that sample exposed a working service under the test method. It also recorded a shared static marketing endpoint, a $0.0042 reputation-forgery example and missing work proof in the sampled BSC feedback. See the linked research for the sample, method and dates; these are not current network totals.

Those findings explain why a listing alone is not enough to recommend a provider. Probing helps buyers choose and helps dispatch fail honestly. It is supporting infrastructure, not AiKi's product thesis.

---

## 2. Read in this order

| # | Document | Why |
|---|---|---|
| 1 | [Product definition](PRODUCT.md) | Participants, hiring flow and product priorities. |
| 2 | [Marketplace API v2](03-marketplace-api-v2.md) and [API v1](01-api-contract.md) | Existing work flows and the additive commerce implementation. |
| 3 | [MCP integration](../apps/mcp/README.md) | How connected agents use the marketplace under an authenticated account. |
| 4 | [Marketplace kernel design](superpowers/specs/2026-09-02-production-marketplace-kernel-design.md) | Target architecture and migration; distinguish proposals from implemented routes. |
| 5 | [Ownership and workflow](00-ownership-and-workflow.md) and [UX test plan](06-ux-test-plan.md) | Team responsibilities and complete buyer/provider flows to verify. |
| 6 | [Research guide](../research/README.md) | Choose the study relevant to the integration you are working on. |

For discovery work, read the [registry sample](../research/02-ecosystem/01-erc8004-reality-on-bsc.md). For chain work, read the [infrastructure study](../research/01-protocols/02-bsc-infrastructure.md) and the [contract reference](../onchain/README.md). The [research status ledger](../research/00-method/03-status.md) records what was verified or unknown at the time; it is not today's implementation backlog.

Follow the source URL and its date when checking a claim. Record corrections where the claim lives.

---

## 3. The nine facts that will bite you

These were recorded by direct RPC in the original research. Keep their safeguards, but recheck mutable provider support, block timing and deployments before treating them as current operational facts.

1. **`totalSupply()` reverts** on the canonical IdentityRegistry; it is not ERC721Enumerable. You cannot scan `1..totalSupply`. **Index `Registered` events.**
2. **`Registered` indexes agentId and owner**, verified by decoding live logs (`topics=3`), correcting an earlier note. Per-agent filters work there. `NewFeedback` indexes only `tag1`, so feedback still needs full-stream indexing and downstream sharding.
3. **`eth_getLogs` is disabled** on public BSC dataseeds. Caps elsewhere are 5k (publicnode) to 50k (NodeReal). At 0.45s/block, a 10k window is **75 minutes** of chain.
4. **USDT-BSC is 18 decimals, not 6**, and implements **neither** EIP-3009 nor EIP-2612. A 6-decimal assumption is wrong by 10¹². The working settlement asset is **`$U`**.
5. **The ERC-8183 deployed ABI diverges from the EIP**: `fund(uint256,uint256,bytes)` and `setProvider(uint256,address,bytes)`. Build from the deployed ABI.
6. **BSC block `timestamp` is second-resolution** and spans ~2.2 blocks. Use the non-standard **`milliTimestamp`** field. Generic EVM indexers drop it silently.
7. **`finalized` lags `latest` by 2 blocks**; worst-case honest reorg is 8 (`turnLength`). Index against `finalized`.
8. **anvil forks BSC fine but needs `--evm-version prague`**. About 1.5% of transactions in the measured sample were EIP-7702 type-4, which broke full-block replay without it.
9. **The researched spend-limit policy module is a LIFETIME cap**, not rolling: `alreadySpent` is monotonic with no `block.timestamp`. Never label a monthly AiKi check as chain-enforced by this module.

---

## 4. Verified addresses (chain 56)

**Never store these as chain-agnostic constants.** Key config by chain ID and assert it at startup. These addresses are the chain-56 research snapshot, not a substitute for checking the selected deployment and ABI.

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

**Do NOT use** `0xfA09B3397fAC75424422C4D28b1729E3D4f659D7` as the canonical registry. The research identified it as BRC8004, a separate community deployment with 26 agents at the time.

Event topics:

```
Registered   0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a
NewFeedback  0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc
```

---

## 5. Original August work breakdown, historical reference

The P0 to P4 labels and day estimates below describe the original protocol investigation. They do not mean these tasks are still open or take precedence over hiring, dispatch, delivery, review and settlement. Check the current implementation and issue before doing or buying anything listed here.

### P0: Original prerequisite checks (half a day)

**T-01 · Verify a bundler and paymaster serving chain 56.**
No service had been confirmed when this task was written. A smart-account design needs a working execution path, so the plan called for checking Pimlico, ZeroDev, Biconomy, Alchemy and thirdweb for chain-56 support. Findings belonged in `research/01-protocols/07-mandate-enforcement.md` and ADR-006. Check their current status before repeating the work.

**T-02 · Read Altana's spend-cap validator source.**
The original research confirmed KeyStore deployment and a CertiK audit, but had not read the module proving that the cap reverts in the EVM. The task was to verify that before using "T0, chain-enforced" in the UI, and to check whether `permissions.spend.period` supplied the rolling window absent from the researched Rhinestone module.

### P1: Original discovery infrastructure plan (days 1-6)

**T-03 · Ingestion.** The NodeReal proposal recorded $39/mo and archive access on all tiers. Backfill `Registered` events from block 79,027,200 → tip. Chunked, resumable, **cap-probing** (parse provider error strings to auto-tune chunk size). Follow `finalized`. Key by `(blockNumber, logIndex)`; wall-clock from `milliTimestamp`.

**T-04 · Registration-file resolver.** Resolve `agentURI` for every agent: `https` / `ipfs` / `data`. Parse per the ERC-8004 schema. Never trust the file's self-declared identity; always resolve top-down chain → URI → file.

**T-05 · Prober.** Capability checks that support discovery and provider selection. The original plan called for multi-region checks and these detection rules:

- **D1** valid-ID vs nonsense-ID byte comparison → `IMPOSTOR_STATIC`
- **D2** reject unexpanded `{…}` placeholders
- **D3** `transport: "stdio"` → `NOT_REMOTE`
- **D4** exclude `data:` URIs from "resolvable" metrics
- **D5** capability handshake, not HTTP 200
- **D8** `/.well-known/agent-registration.json` reciprocal proof (0.04% in the recorded research)
- **D9** verify A2A card JWS (detached, RFC 8785 canonical, defaults removed)

**T-06 · Evidence store.** Append-only bitemporal `Observation` table (schema in the architecture doc). Insert-only; corrections supersede. Every row carries `source`, `method`, `evidenceClass`; chain rows carry `finality`.

**T-07 · Proof Score.** Wilson LB + Beta accumulation + empirical-Bayes shrinkage. **Pin `z` in config and record it in `scoring_version`**: a `z=1.6449` implementation against a `z=1.96` golden table deadlocks the test suite on day one.

**T-08 · Classifier.** Bucket agents into the four categories. The registry has no category field, so this is text classification over name/description/manifest. Keyword matching gives yield 132 / rebalancing 40 / grid 10 / health-factor 4 as a **lower bound**.

**T-09 · Serve `/v1/stats`, `/v1/search`, `/v1/agents/{id}/passport`** per the contract. These support discovery and profiles; they do not replace the hiring and delivery flow.

### P2: Original reference-agent plan (days 5-12, parallel)

The original sample found 4 health-factor and 10 grid agents. That finding motivated reference agents. It is not a current inventory count or a reason to limit the marketplace to those categories.

**T-10 · Health-factor agent**: Venus. Monitor account liquidity, repay on threshold. Comptroller `0xfD36E2c2a6789Db23113685031d7F16329158384`. The recorded `repayBorrow` measurement was **153,929 gas ≈ $0.0055**.
**T-11 · Grid agent**: PancakeSwap v3.
**T-12 · Register both** on ERC-8004 with valid registration files and working `/.well-known` reciprocal proofs: i.e. be the agents we wish existed.

### P3: Original authority and commerce plan (days 8-16)

**T-13 · Policy compiler.** AiKi policy → SmartSession policies or Altana session grant. Emit the **enforcement tier per constraint**.
**T-14 · Deploy `TimeFramePolicy`**: the original research did not find it on chain 56. Also assess `UsageLimitPolicy` and `ValueLimitPolicy` if needed; check current deployments first.
**T-15 · Session lifecycle**: grant, spend tracking, instant revoke.
**T-16 · ERC-8183 adapter** from the **deployed ABI**, implementation pinned and asserted at startup.
**T-17 · `$U` settlement** + x402 v2 (`@x402/*` 2.23.0, CAIP-2 networks). Token capability flags in config.
**T-18 · Ledger.** Double-entry, idempotency keys, three-way reconciliation (ledger ↔ adapter ↔ chain). **A tx timeout is not a failure**: one intent, one nonce, resubmission is replacement.

### P4: Original receipt and Arena plan (days 14-19)

**T-19 · Receipts**: SCITT (RFC 9943) / COSE (RFC 9942) profile, `reference` = mandate hash.
**T-20 · Job SSE stream** per contract §6.
**T-21 · Arena harness**: `anvil --fork-block-number <pinned> --evm-version prague`. Paired replay: every agent on identical scenarios. Report intervals. **Never a Sharpe leaderboard.**
**T-22 · ERC-8004 validator** *(original stretch task)*: write Arena/liveness verdicts as `validationResponse`. The research recorded zero validators network-wide at the time. The flow is owner-initiated, so it needs provider cooperation.

---

## 6. Original stack proposal, historical reference

Retained for the reasoning behind the initial choices. Read the current package manifests, services and ADRs before choosing a dependency; several alternatives below have since been resolved in code.

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 24) | Shared types with the frontend across the seam |
| API | Hono or Fastify | Light, fast, good SSE |
| DB | Postgres | Append-only evidence + JSONB provenance |
| Queue | pg-boss or BullMQ | Don't add Kafka for this |
| Chain | viem | Modern, typed, good BSC support |
| Indexer | custom over NodeReal | Ponder auto-tunes ranges: worth evaluating |
| Contracts | Foundry | anvil is already the Arena harness |

**Constraint:** the frontend consumes `packages/contracts`. Whatever you choose must emit those types.

---

## 7. Access recorded in the original plan

Confirm what is still required before requesting access or incurring a charge. Keep keys and wallet secrets out of logs and commits.

| | |
|---|---|
| GitHub | `github.com/Immadominion/AiKi`: ask Joel for the invite |
| NodeReal | Archive RPC was proposed at $39/mo in August. Verify the current provider and price; this note is not purchase approval. |
| 8004scan | The original plan used a gitignored local API key and recorded activation as pending. Confirm current access with the owner without printing the key. |
| BSC wallet | your own, for testnet then mainnet |
| Telegram | the team channel |

---

## 8. How we know things

The rule that governs this repo:

> Every technical fact is **VERIFIED** (fetched from a primary source, URL + date recorded), **ASSUMED** (labelled, only built on behind an adapter), or **UNKNOWN** (may not be built on).

This is an engineering rule for a marketplace that handles work, payment and permissions. Keep the user-facing flow simple, and keep its underlying state and claims verifiable. If a technical claim cannot be supported, mark it UNKNOWN rather than presenting it as implemented.

The original research treated both foundational standards as Draft and found a deployed ABI divergence. Recheck the applicable versions, isolate integrations behind adapters, pin versions and addresses, and assert them at startup.
