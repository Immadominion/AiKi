# Research Status Ledger

**Updated:** 18 August 2026
**Rule:** a topic is DONE only when a primary source was fetched and the finding is written up. Everything else is UNKNOWN and may not be built on.

---

## ✅ Ground-truth research complete — 15/15 topics

| Topic | Verdict | Document |
|---|---|---|
| ERC-8004 specification (**A1**) | SOLID | [01-protocols/01](../01-protocols/01-erc8004-trustless-agents.md) |
| BSC infrastructure, measured live (**C2**, **C3**) | SOLID | [01-protocols/02](../01-protocols/02-bsc-infrastructure.md) |
| MCP `2026-07-28` (**A5**) | SOLID | [01-protocols/03](../01-protocols/03-mcp-2026-07-28.md) |
| Adjacent standards — A2A / AP2 / ACP / SCITT (**D1**, **D3**, **B4**) | SOLID | [01-protocols/04](../01-protocols/04-adjacent-standards.md) |
| ERC-8183 commerce (**A2**) | SOLID | [01-protocols/05](../01-protocols/05-erc8183-commerce.md) |
| x402 payments (**A3**, **B4**) | SOLID | [01-protocols/06](../01-protocols/06-x402-payments.md) |
| Mandate enforcement (**B1–B3**) | PARTIAL | [01-protocols/07](../01-protocols/07-mandate-enforcement.md) |
| ERC-8004 ecosystem reality (**C1**) | SOLID | [02-ecosystem/01](../02-ecosystem/01-erc8004-reality-on-bsc.md) |
| Build the Era competition | SOLID | [02-ecosystem/02](../02-ecosystem/02-build-the-era-competition.md) |
| BNB Agent Studio (**A4**) | PARTIAL | [02-ecosystem/03](../02-ecosystem/03-bnb-agent-studio.md) |
| Competitive teardown (**D2**) | SOLID | [02-ecosystem/04](../02-ecosystem/04-competitive-teardown.md) |
| Measurement science (**C4**) | SOLID | [03-architecture/01](../03-architecture/01-measurement-science.md) |
| Venus + PancakeSwap interfaces | PARTIAL | raw |
| Yield + grid venues | PARTIAL | raw |
| Registry deployments (**C-1**) | SOLID | folded into 01-protocols/01 + 02-ecosystem/03 |

Raw structured output: `research/_raw/*.json`. Round-1 adversarial verdicts: `_raw/verdicts-round1.json`.

---

## ✅ C-1 RESOLVED — two registries, only one matters

Both researchers were right about the bytes and wrong about exclusivity. **BSC hosts two independent ERC-8004-shaped registry pairs.** All four addresses verified by direct `eth_getCode` / `eth_call`.

### (A) CANONICAL — index this one

| | Address |
|---|---|
| Identity | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Reputation | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

ERC-1967 proxies. `name()` = **"AgentIdentity"**, `symbol()` = **"AGENT"**, `getVersion()` = **"2.0.0"** on both. The Reputation proxy's `getIdentityRegistry()` returns the Identity proxy — **the pair is wired**. Implementations (`0x7274e874…`, `0x16e0fa7f…`) are **source-verified on Sourcify** as `IdentityRegistryUpgradeable` / `ReputationRegistryUpgradeable`, and the ABI matches ERC-8004 v1 exactly.

- Highest tokenId: **269,718** (binary search on `ownerOf`)
- **~460 registrations/day** (4 `Registered` events per 1,000-block window)
- **This is where the 257,865 agents live** — that figure is a stale/filtered snapshot of this contract.
- **`bnb-chain/bnbagent-sdk` pins chain 56 → `0x8004A169…`**

### (B) BRC8004 — dead, ignore

| | Address |
|---|---|
| Identity | `0xfA09B3397fAC75424422C4D28b1729E3D4f659D7` |
| Reputation | `0x17860530385Bdde7992c4Da71B9ec7791E474C08` |

`name()` = "BRC8004 Identity Registry", `symbol()` = "BRC8004". **`totalSupply()` = 26.** Zero `Registered` events in the same window. **Agent #1 is literally named "Test".** Repo is `github.com/BRC8004` (not `bnb-chain`), created and last pushed 2026-02-02, 1 star. A community re-deployment, effectively abandoned.

**→ Index (A) only. Agent Studio writes to (A). The concern that Studio agents were invisible to the count was unfounded.**

---

## Remaining open items

| # | Item | Blocks | Priority |
|---|---|---|---|
| **O-1** | **Terms of Participation** — not publicly fetchable; IP/licensing/open-source obligations unknown | Submission | **Founder action** |
| **O-2** | Altana spend-cap enforcement not read at source level; BscScan source-verification unconfirmed (Cloudflare 403) | The T0 claim in the mandate UI | **High** |
| **O-3** | **No bundler or paymaster verified as serving chain 56**; Biconomy/Safe/thirdweb/Alchemy BSC support unchecked | ADR-006 wallet custody boundary | **High** |
| O-4 | ERC-8183 BscScan source verification (Cloudflare 403; needs Etherscan v2 key) | Mainnet funds | Medium |
| O-5 | `$U` liquidity, depth, on/off-ramps | Checkout UX | Medium (product risk) |
| O-6 | Agent Studio: registration-file JSON schema; full ERC-8183 wire protocol; whether IdentityRegistry is ERC-721 Enumerable | Ingestion, commerce adapter | Medium |
| O-7 | Whether ERC-8183 job state is enumerable on-chain | Potentially a **higher-signal supply source** than identity | Worth pursuing |

---

## VERIFIED — may be built on

**Identity.** ERC-8004 is `Draft` (commit 2026-01-25; moved to Review Oct 2025 then reverted — pin a commit hash). Identity is a transferable ERC-721; `agentId` == `tokenId`. `agentWallet` is the only cryptographically proven field (EIP-712/ERC-1271), auto-cleared on transfer. Registration files carry **no signature** — always resolve top-down chain → URI → file. `/.well-known/agent-registration.json` reciprocal proof exists at **0.04% adoption**. Reputation is `int128` + caller-set `valueDecimals`; `getSummary` accepts a client filter; `revokeFeedback` exists. **ValidationRegistry: zero validators, zero validations, globally.** Validation is owner-initiated.

**Commerce.** ERC-8183 is Draft (2026-02-25), deployed and **busy** — job 56,610 same-day. AgenticCommerce proxy `0xEa4DAa31…`, impl `0xd5f9b570…`. **Deployed ABI diverges from spec: `fund(uint256,uint256,bytes)` and `setProvider(uint256,address,bytes)`.** Proxy is upgradeable, pausable, owner-controlled. `claimRefund` is deliberately not hookable. Fees only on `Completed`. Expiry is permissionless. EvaluatorRouter is both evaluator and `IACPHook`.

**Payments.** x402 **v2** is current (`@x402/*` 2.23.0; unscoped v1 frozen at 1.2.x); headers `PAYMENT-REQUIRED`/`PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE`, CAIP-2 networks. **USDT-BSC implements neither EIP-3009 nor permit, and is 18 decimals.** **Chain 56 is absent from `DEFAULT_STABLECOINS`.** **`$U`** (`0xcE2443…666666`, "United Stables", 18dp) implements EIP-3009 and is ERC-8183's `paymentToken`. **B402 is third-party (`b402.ai`), abandons EIP-3009, and its "RelayerV3 contract" is an EOA with no code.**

**Enforcement.** EIP-7702 live since **2025-03-20** (Pascal), 1.40% of txs. EntryPoints v0.6/v0.7/v0.8 all deployed; 7702+4337-v0.8 live in production. Rhinestone SmartSession `0x00000000008bDABA73cD9815d79069c247Eb4bDA` deployed; SpendingLimits/UniversalAction/Sudo policies deployed; **TimeFrame/UsageLimit/ValueLimit NOT deployed on 56 — AiKi must deploy them.** **`ERC20SpendingLimitPolicy` is a lifetime cap, not a rolling window** (monotonic `alreadySpent`, no `block.timestamp`). Altana KeyStore `0x6572427E…` + Controller `0x0834Ee2C…` have bytecode on 56; CertiK-audited 15 Jul 2026; revocation is a single userOp, immediate, no off-chain coordination. **Altana = T0** (with the §O-2 asterisk); **TWAK = T3** (no constraint surface).

**Chain.** 0.45s blocks, `finalized` lag 2 blocks, reorg bound 8 blocks (`turnLength`). Non-standard **`milliTimestamp`** — generic indexers drop it. `eth_getLogs` **disabled** on public dataseeds; caps 5k–50k elsewhere. **anvil forks BSC, gas exact, needs `--evm-version prague`.** NodeReal **$39/mo with archive on all tiers**. **Mandatory Pasteur hardfork 25 Aug 2026.**

**Competition.** Deadline **12:00 UTC 9 Sep 2026**. Rubric: Functionality / Data Quality / Agent Diversity; press release adds "real-world usage"; Phase 2 redacted. Category supply: yield 132, rebalancing 40, grid 10, **health factor 4**.

**Competitive reality.** Confidence-weighted scoring (trust8004), explainable ranking + liveness (8004scan v5), on-chain mandate ceilings (winsznx/mandate), staked typed evaluators (TermiX AACP) are **all already shipped**. The unoccupied position is **independent evidence generation** — the empty ValidationRegistry, and the fact that 100% of BSC feedback lacks interaction proof.

**Measurement.** Wilson LB gives the required score/confidence inversion for free. **Separating 0.5 Sharpe needs ~63 years** — leaderboards are statistically void; **paired replay on identical scenarios is the only honest comparison.** Wash trading is detectable by iterative SCC counting + volume matching.

---

## Next: architecture

Ground truth is complete enough to design. Order:

1. Canonical domain model + evidence graph (HP-4)
2. Ingestion and verification pipeline (D1–D7 detection rules)
3. Policy DSL and enforcement tiers (HP-3, AP2-aligned)
4. Arena replay harness (HP-1, HP-2)
5. Commerce + payment routing (ERC-8183 / x402 / `$U`)
6. ADR set
7. Feasibility, critical path, build sequence
