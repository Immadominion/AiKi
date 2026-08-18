# BNB Agent Studio — Technical Surface and the Supply Question

**Research verdict:** PARTIAL (the central question is answered with high confidence; several integration details remain open)
**Verified:** 18 August 2026
**Answers:** Charter question **A4** — *the highest-stakes question in the programme*

---

## The answer to A4

> **No. BNB Chain does not operate a public API, registry service, index or export that enumerates agents created with Agent Studio.**

Eight documentation pages were fetched (index, quickstart, demo, architecture, configuration, cli-reference, deployment, security). None describes a hosted directory, a REST/GraphQL discovery service, an auth model for one, or a response shape.

The launch blog frames discovery as standards-based rather than centralised — *"Other agents can discover and call the one you've built."* The demo page confirms the flow works the other way round: a buyer must **already hold an `agent_id`**, then reads the on-chain ERC-8004 registry for that ID's `agent_uri` to obtain the service endpoint.

There is a `bag agents list|show|forget|register` command group, but `forget` is a verb that only makes sense against local persisted state — you cannot un-know a public registry entry — and no network endpoint, base URL or auth scheme appears anywhere in the docs. **Assessment: a local address book, not a network registry.** *(Confidence: low. Confirm empirically.)*

### What this means for AiKi

The consequence is not fatal, but it is structural:

1. **There is no supply feed to plug into.** AiKi must build enumeration itself, from chain data.
2. **The on-chain registry is the only substrate**, which makes AiKi's indexing layer load-bearing from day one rather than a phase-two nicety.
3. Combined with the [measured ecosystem reality](01-erc8004-reality-on-bsc.md) — zero invocable endpoints in a 400-agent sample — **the supply problem is now confirmed from two independent directions**. Shipping first-party reference agents moves from "recommended" to "required".

There is a silver lining worth stating plainly: because no one has a supply feed, **no competitor has one either**. Enumeration quality is a level playing field, and it feeds directly into the "Data Quality" criterion.

---

## ⚠️ 1. An unresolved contradiction about registry addresses

Two research agents, working independently, returned **different** ERC-8004 registry addresses for BSC mainnet.

| Source | Identity Registry (chain 56) | Reputation Registry |
|---|---|---|
| 8004scan live API + arXiv paper + `awesome-erc8004` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| **BRC8004 repo README** ("Trustless Agents on BNB Chain") | **`0xfA09B3397fAC75424422C4D28b1729E3D4f659D7`** | **`0x17860530385Bdde7992c4Da71B9ec7791E474C08`** |

These are not the same contracts.

**The most likely explanation** — and it is a hypothesis, not a verified fact — is that BSC hosts **two** ERC-8004 registries: the canonical cross-chain deterministic deployment at the vanity `0x8004…` prefix, and BNB Chain's own `BRC8004` implementation. If so:

> **Agent Studio agents may not appear in the 257,865-agent count that 8004scan indexes at all.**

That would materially change the picture. It would mean the ecosystem measurement covered the *canonical* registry — largely EvoEvo/Termix bulk registrations — while Agent Studio's agents, the ones the competition is actually about, live somewhere else and have never been counted.

**This is the single most important open question remaining.** It is unresolved because the adversarial verification pass that would have settled it was killed by a session limit.

**Resolution procedure (do this first when research resumes):**
1. Read `constants`/config in `github.com/bnb-chain/bnbagent-sdk` to find which address `bag erc8004 register` actually writes to.
2. Verify both addresses on BscScan: contract creation, verified source, `totalSupply()`, recent `Transfer` activity.
3. Compare `totalSupply()` on each against 8004scan's BSC count of 257,865.
4. If both are live, **AiKi must index both** and the canonical-identity model (ADR-001) must handle one logical agent appearing in two registries.

Until then, **neither address may be written into code.** This is exactly the charter's UNKNOWN state.

---

## 2. Enumeration path

The `BRC8004` IdentityRegistry is an upgradeable ERC-721 exposing:

```solidity
register(string agentURI) returns (uint256 agentId)
setAgentURI(...)
setAgentWallet(...)
totalSupply()
exists(uint256)
getAgentWallet(uint256)
```

So enumeration is: walk token IDs `1..totalSupply()`, resolve each `agentURI` (base64 `data:` JSON carrying `name`, `description`, `protocol`, `endpoint`).

> ⚠️ **This scan breaks if IDs are non-sequential or tokens are burnable.** Only `totalSupply`, `exists` and `getAgentWallet` were confirmed — **ERC-721 Enumerable `tokenByIndex` was not**. Read the ABI directly before relying on a sequential scan. The safe implementation indexes `Transfer` events from block 0 rather than scanning IDs.

**Third-party alternative:** The Graph's Agent0 subgraphs (announced 2026-04-14) index ERC-8004 across Ethereum, Base, Polygon, BNB Chain and Monad via GraphQL, with entities `agentRegistrationFiles`, `agentId`, `name`, `description`, `mcpEndpoint`, `mcpTools`, `supportedTrusts`. The BSC subgraph ID (`D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K`) is recorded in the [ecosystem doc](01-erc8004-reality-on-bsc.md#72-the-graph--agent0-subgraphs-structured-alternative) — but note it presumably indexes the `0x8004…` registry, which loops back to the contradiction above.

---

## 3. Architecture — and a security pattern worth copying

Two deployed artifacts:

| Layer | Runs on | Holds keys? | Public HTTP? |
|---|---|---|---|
| **A — Agent** | AWS Bedrock AgentCore | **Yes** | **No** — invoke-only |
| **B — Service** | EC2 / Fargate | No | Yes — `POST /apex/negotiate`, `/apex/health` |

Documented trust boundaries:

- The bundled MCP server for Cursor/Claude Code exposes 15 chain tools, and **"all 15 tools are read-only — no signing, no on-chain state change"**.
- Layer B is keyless: it **"can only *request* signatures, never sign directly"**, via AWS `InvokeAgentRuntime` into Layer A.
- The keystore lives at `.studio/wallets/` at workspace root — deliberately **outside** the AgentCore code directory so it is never packaged into deploy artifacts. Injected at runtime from AWS Secrets Manager as `WALLET_KEYSTORE_JSON`. `WALLET_PASSWORD` is never persisted to config.
- Signing policy lives in `app/agent/signing.py` — **fixed, non-LLM-reachable code**.

**AiKi should adopt this separation wholesale.** A keyless public surface that can only *request* a signature, plus a key-holding component that re-validates independently before signing, is the correct default for any platform touching third-party funds — and it is the pattern BNB Chain's judges will recognise.

### 3.1 …but the enforcement is off-chain — and that matters

> **Spend caps and EIP-712 allowlists are enforced in-process, off-chain.** The signing policy clamps prices to `[min_price, max_price]` from static config.

In [HP-3](../00-method/02-hard-problems.md) terms this is **T1 (custodial)**, not T0 (cryptographic). It survives a compromised or misbehaving *agent*; it does **not** survive a compromised host process.

This is not a criticism of Agent Studio — it is a reasonable design for a developer runtime. But it means:

- AiKi must **not** describe Studio-derived spend caps as on-chain guarantees.
- The enforcement-tier model is not academic. The reference implementation in this ecosystem is already T1, and AiKi's UI must be able to render that honestly.

---

## 4. The wire contract is custom — not A2A, not `/.well-known`

```http
POST /apex/negotiate
{"task_description": str,
 "terms": {"deliverables": str, "quality_standards": str}}

→ {"accepted": bool,
   "price": "<raw uint256 string>",
   "currency": "<settlement-asset>",
   "provider_sig": "<EIP-191 signature>",
   "chain_id": 97,
   "quote_expires_at": "<5-min TTL>",
   "verifying_contract": "<address>"}
```

Health: `GET /apex/health` → `{"status":"ok", ...}` (`/apex/status` also referenced).

**No `/.well-known` route. No A2A AgentCard.** So Agent Studio agents do *not* speak the A2A discovery convention that ERC-8004's registration file optionally references.

→ **AiKi's `ProviderAdapter` layer needs an APEX adapter distinct from an A2A adapter.** The MPSS's adapter posture is vindicated: there is no single wire protocol to code against.

→ **The 5-minute quote TTL and the `provider_sig` + `verifying_contract` fields are directly reusable** in AiKi's Quote Service — a signed, expiring quote bound to a verifying contract is exactly the right primitive.

> ⚠️ The security page is silent on authentication or rate limiting for `/apex/negotiate`. **The endpoint appears unauthenticated.** If so, quote-spam is an unmitigated DoS vector against every Studio agent, and AiKi should rate-limit its own probing accordingly.

---

## 5. Registration is opt-in and manual — a supply-data consequence

ERC-8004 identity is **not** written automatically on deploy. It requires a discrete CLI step, run *after* Layer B is reachable:

```bash
bag erc8004 register --endpoint https://my-service.example.com/apex/
```

Because the EC2 IP is unknown at scaffold time, the docs recommend registering a placeholder and correcting it later via `bag erc8004 update --new-uri <real-url>` (the CLI reference lists the verb as `update-endpoint`; `show` and `resolve` also exist).

**Two consequences:**

1. **A meaningful fraction of Studio agents will have no on-chain record at all** — they exist and work, but are invisible to any chain-based enumeration. On-chain counts are a *lower bound* on real Studio supply.
2. **The placeholder-then-correct workflow is a documented source of stale endpoints.** This is very likely the mechanism behind the 13 agents publishing literal `{agentId}` placeholders found in the [ecosystem measurement](01-erc8004-reality-on-bsc.md#22-the-unsubstituted-template-13-of-400). The bug is not incidental — **the recommended workflow encourages it.**

→ AiKi's ingestion must treat a registered endpoint as a *claim requiring verification*, never as fact. Detection rule **D2** (reject unexpanded `{…}` placeholders) is now understood as mitigating a documented workflow hazard, not an isolated mistake.

---

## 6. Toolchain facts

| Item | Value |
|---|---|
| CLI / runtime | `pip install bnbagent-studio` (or `uv tool install`) → `bag` |
| Runtime library | `bnbagent-studio-core` |
| SDK | `bnbagent` (Python) · `@bnbagent/sdk` (npm) |
| Repos | `github.com/bnb-chain/bnbagent-studio` · `github.com/bnb-chain/bnbagent-sdk` |
| **Versions** | **None published on any page fetched** |
| Default framework | Google ADK |
| Default runtime | AWS Bedrock AgentCore |
| Default network | **`bsc-testnet` (97)** |
| Networks supported | BSC Testnet 97, BSC Mainnet 56 — *only these two* |
| LLM gateway | `pieverse-llm`, activated with a $0 deposit |
| First deploy time | 4–6 minutes |

Scaffold flow:

```bash
pip install bnbagent-studio
bag skills install
bag init weather-seller --framework adk --runtime agentcore \
    --llm-provider pieverse-llm --network bsc-testnet --ide claude-code
bag dev
bag deploy prepare && bag deploy agent
bag deploy verify --endpoint <service-url>
bag erc8004 register --endpoint <service-url>/apex/
```

**LLM billing** is gateway-mediated: `[llm.pieverse]` holds a `key_hash` (a hashed key reference, not a raw provider key), and `bag llm topup|allocate|rotate|usage` are credit operations. Agents top up automatically over **x402**.

**On x402 vs B402:** the CLI exposes `bag x402 quote|buy`. The SDK references *delegated x402* with a `TWAKProvider` wallet and a *session-key x402 payer* with `AltanaWalletProvider` — i.e. there is a `WalletProvider` seam letting payment authority be delegated or scoped to a session key.

> **The term "b402" appeared in no fetched source.** Combined with the competition research finding that "BinancePay B402 merchants integration" is a *roadmap* item, treat **B402 as not-yet-real**. Build on x402.

The networks page explicitly declines to publish contract addresses: *"Deployed contract addresses are not listed in this documentation. Use the upstream repos."*

---

## 7. Open gaps

Ordered by how much they block.

| # | Gap | Blocks |
|---|---|---|
| **G1** | **Which registry address `bag erc8004 register` writes to** (§1) | All ingestion. Resolve first. |
| G2 | BSC testnet (97) IdentityRegistry address | Testnet development |
| G3 | ERC-8183 / APEX addresses on chain 56 — docs defer to `apex-contracts#deployments` | Escrow and settlement. *(Competition research surfaced candidates — see [competition doc §8.1](02-build-the-era-competition.md) — still unverified on BscScan.)* |
| G4 | Whether IdentityRegistry implements ERC-721 Enumerable; whether tokens are burnable | Whether a sequential scan is safe |
| G5 | Full ERC-8183 wire protocol beyond `/apex/negotiate` — CLI verbs `bag erc8183 publish\|list\|status\|buy\|submit\|fetch\|settle` exist but paths/payloads are unpublished | The commerce adapter |
| G6 | Verbatim JSON schema of the registration file. Field *names* seen (`agent_id`, `address`, `name`, `description`, `protocol`, `endpoint`, `agent_uri`); no schema document, no versioning | Manifest parsing |
| G7 | Whether ERC-8183 job/offer state is enumerable on-chain | **Potentially a higher-signal supply source than the identity registry — a listed job implies an agent is actually selling.** Worth pursuing. |
| G8 | AgentCore runtime limits: memory, timeout, payload size, cold start, concurrency | Probe budgets and SLO design |
| G9 | Auth / rate limiting on `/apex/negotiate` | Probe etiquette; DoS assessment |
| G10 | Package versions and PyPI release dates | Reproducible builds |
| G11 | `bag agents list` semantics — local cache vs network | Whether a supply feed exists after all |
| G12 | Concrete LLM model IDs, pricing, context limits; identity of the Pieverse operator | Cost modelling |

---

## Sources

- `https://docs.bnbchain.org/developer-kit/bnbchain-studio/` — index, quickstart, demo, architecture, configuration, cli-reference, deployment, security
- `https://www.bnbchain.org/en/blog/bnb-agent-studio-is-live-on-bnb-chain-ai-agents-from-one-prompt`
- `github.com/bnb-chain/bnbagent-studio` · `github.com/bnb-chain/bnbagent-sdk` · BRC8004 repo README
- The Graph, Agent0 subgraphs announcement (2026-04-14)
