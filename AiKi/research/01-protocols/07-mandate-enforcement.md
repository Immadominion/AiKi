# Mandate Enforcement on BSC — What the Chain Actually Guarantees

**Research verdict:** PARTIAL (core question answered with high confidence; bundler/paymaster coverage unresearched)
**Verified:** 18 August 2026, by direct RPC against chain 56
**Answers:** Charter questions **B1–B4** · resolves **[HP-3](../00-method/02-hard-problems.md)**

---

## The answer

> **AiKi can say "this agent may call Venus.repayBorrow with at most 250 USDT, revocable instantly" and have it be CHAIN-ENFORCED on BSC today, with no backend in the trust path.**
>
> **The words "per rolling 30 days" cannot. No shipping module implements a time-windowed cumulative cap.**

That distinction is not pedantry — it is the difference between a security property and a marketing sentence, and the Mandate Builder must render it.

---

## 1. The substrate is live

Verified by direct RPC, not by blog post.

### EIP-7702 — live since Pascal

- Pascal hardfork, `timestamp 1742436600` = **2025-03-20 02:10:00 UTC**, per `bnb-chain/bsc` `params/config.go`.
- 60-block scan at head 116,725,156: **49 of 3,492 txs are type `0x4` (1.40%)**, each carrying an `authorizationList` with `chainId 0x38`.

This confirms the earlier 1.5% measurement, and corrects an inference from it: **anvil's `Eip7702 is not supported` is an anvil limitation, not a BSC one.** The chain has supported it for 17 months.

### ERC-4337 — all three EntryPoints deployed and answering

| Version | Address |
|---|---|
| v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` |
| v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| **v0.8** | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` |

All answer `getNonce` on BSC. **One observed type-4 transaction targets EntryPoint v0.8 directly — the combined 7702 + 4337-v0.8 path is live in production on BSC.**

### Rhinestone SmartSession — deployed

| Contract | Address (BSC 56) | Status |
|---|---|---|
| **SmartSession** | `0x00000000008bDABA73cD9815d79069c247Eb4bDA` | ✅ deployed, `isModuleType(1) == true` |
| SpendingLimitsPolicy | — | ✅ deployed |
| UniversalActionPolicy | — | ✅ deployed |
| SudoPolicy | — | ✅ deployed |
| TimeFramePolicy | canonical addr | ❌ **returns `0x` — not deployed on 56** |
| UsageLimitPolicy | canonical addr | ❌ **not deployed on 56** |
| ValueLimitPolicy | canonical addr | ❌ **not deployed on 56** |

**→ Three policies AiKi wants must be deployed by AiKi.** They are open-source and deployable to their canonical addresses — a small, bounded task, but it is on the critical path and nobody else has done it.

---

## 2. ⚠️ The hard constraint: spending limits are lifetime, not rolling

The `ERC20SpendingLimitPolicy.sol` source was read directly:

- stores `alreadySpent` as a **monotonic counter** against a fixed `spendingLimit`
- contains **no `block.timestamp`**
- **never resets**

**It is a lifetime cap on a session, not a rolling window.**

So the MPSS's policy dimension *"per action, rolling hour/day, total session"* (§14.1) is only **partly** satisfiable with off-the-shelf modules:

| Constraint | Off-the-shelf? |
|---|---|
| Per-action value cap | ✅ |
| **Total session cap (lifetime)** | ✅ `ERC20SpendingLimitPolicy` |
| Target/contract allowlist | ✅ `UniversalActionPolicy` |
| Function-selector allowlist | ✅ `UniversalActionPolicy` |
| Expiry | ⚠️ `TimeFramePolicy` exists but **must be deployed** |
| **Rolling window cap ("$250/month, renewing")** | ❌ **needs a custom policy contract** |
| Instant revocation | ✅ |

**→ Two honest options, and this is a product decision, not just an engineering one:**

**(a) Ship lifetime caps first.** "This session may spend at most $250 total, expiring 18 Sep" is fully chain-enforced today, and is a *clearer* promise for most users than a renewing budget. Re-authorization creates a new session.

**(b) Write a custom rolling-window policy.** A `RollingWindowSpendPolicy` implementing the SmartSession policy interface with a timestamp-bucketed counter. Well-bounded work, but it is custom, unaudited security-critical code holding user funds — which is exactly the category the decision register says not to write casually.

*Recommendation (labelled as such): ship (a) for launch and treat (b) as a funded, audited workstream.* Rationale: (a) is honest, enforceable, and shippable now; (b) is a genuine improvement but writing unaudited fund-holding code under a three-week deadline is how marketplaces lose money.

---

## 3. Wallet vendors — two different animals

### Altana — **Tier T0**

A **non-custodial ERC-4337 smart-account stack** (`@altananetwork/sdk`, `createClient({chains:[BNB]})`) with a **real, deployed on-chain permission registry**:

| Contract | Address (BSC 56) | Verified |
|---|---|---|
| KeyStore | `0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a` | ✅ `eth_getCode` — has bytecode |
| KeyStoreController | `0x0834Ee2C9BdC3E3efF0a2dC34393D4B0e546A555` | ✅ `eth_getCode` — has bytecode |

Session grants carry:
- `permissions.calls` — contract allowlist by `to`
- `permissions.spend` — `{limit, period, token}` ← **note `period`, unlike Rhinestone**
- `expiry`

**Revocation** is a single userOp that atomically removes the key from KeyStore *and* strips authority from the smart account, gated by `onlyKeyOwnerOrValidator` — *"effective immediately on that chain"*, *"no off-chain coordination is required."*

**Custody:** the admin key never leaves the operator — *"Altana never sees it."*

**Audit:** CertiK audited `KeyStore.sol` / `KeyStoreCacheOPStack.sol`, 15 Jul 2026.

**Two honest caveats, recorded rather than glossed:**

1. **Source verification could not be independently confirmed.** BscScan sits behind Cloudflare and returned 403 to both WebFetch and a UA-spoofed curl; the Etherscan v2 API needs a key. The verification claim currently rests on Altana's own audits page.
2. **The spend-cap enforcement was not read at the source level.** We confirmed the contracts are deployed; we did *not* read the validator module proving the spend cap reverts in the EVM. "Enforced on-chain" for spend is **documented, not verified by us.**

**Not documented — do not promise:** function-selector allowlists, asset scope beyond a single token address, approval thresholds.

**→ Altana's `permissions.spend.period` is the rolling-window primitive Rhinestone lacks.** If it enforces as documented, it solves §2 without custom code. **Verifying that claim at the source level is the single highest-value follow-up in this document.**

### Trust Wallet AgentKit (TWAK) — **Tier T3**

A completely different product: `@trustwallet/cli`, a **local CLI + MCP server** that generates a mnemonic, AES-256-GCM encrypts it under a PBKDF2 password to `~/.twak/wallet.json`, and signs locally.

- **Self-custody, zero vendor custody** — genuinely good.
- **Zero constraint surface.** No session key, no spend cap, no allowlist, no on-chain policy contract appears in any Trust Wallet doc fetched.

**→ TWAK is a key manager, not a mandate system.** Under AiKi it is **T3 — observational**: we can watch what it does and alert, but nothing constrains it. Listing it beside Altana as an equivalent "agentic wallet" would be actively misleading, and AiKi's UI must not do that.

---

## 4. The enforcement-tier model, now populated

[HP-3](../00-method/02-hard-problems.md) proposed tagging every mandate constraint by where it is enforced. That model is no longer hypothetical:

| Tier | Enforcement | Survives | On BSC today |
|---|---|---|---|
| **T0** cryptographic | Chain rejects the violating call | Compromised AiKi **and** compromised agent | **Altana KeyStore; Rhinestone SmartSession + policies** |
| **T1** custodial | A signer AiKi controls refuses | Compromised agent only | **BNB Agent Studio** (in-process price clamp + EIP-712 allowlist) |
| **T2** advisory | Backend policy check before relay | Honest-but-buggy agent | naive relayer designs |
| **T3** observational | Detected after the fact | Nothing | **TWAK** |

**This table is a differentiator, not a disclaimer.** No competitor is going to tell a user that their "on-chain spend cap" is actually a process that could crash. AiKi rendering the tier per constraint — with the same visual weight as the number itself — is exactly the "safety should feel like product, not compliance" principle from the MPSS, and it is only credible *because* T0 is genuinely achievable here.

---

## 5. Impact on AiKi

| Finding | Consequence |
|---|---|
| **EIP-7702 live since 2025-03-20; 1.40% of txs** | T0 enforcement is real on BSC. anvil's limitation ≠ chain's. |
| All 3 EntryPoints live; **7702+4337-v0.8 in production** | Modern smart-account path is available, not theoretical. |
| SmartSession + 3 policies deployed | Core enforcement primitives exist. |
| **TimeFrame/UsageLimit/ValueLimit not deployed on 56** | **AiKi must deploy them.** On the critical path. |
| **Spending limit is lifetime, not rolling** | Ship lifetime caps; treat rolling-window as an audited workstream. **Do not claim "per month" until it is enforced.** |
| **Altana = T0**, deployed KeyStore, atomic revocation, CertiK-audited | Strong integration candidate. Its `spend.period` may solve the rolling-window gap. |
| Altana source-verification + spend-cap enforcement **not independently confirmed** | **Highest-value follow-up.** Do not repeat the claim as verified until read. |
| **TWAK = T3, zero constraint surface** | Never present alongside Altana as equivalent. |
| Altana selector allowlists / asset scope / approval thresholds undocumented | Do not promise them. |

### Unresearched — treat as UNKNOWN

**No bundler or paymaster was verified as actually serving chain 56 against primary docs**, and Biconomy / Safe / thirdweb / Alchemy BSC support was not checked. A smart-account architecture with no verified bundler is a design with no execution path — **this must be closed before ADR-006 (wallet custody boundary) is written.**

---

## Sources

`bnb-chain/bsc` `params/config.go` · direct `eth_getCode` / `eth_call` / block scans against chain 56 · Rhinestone SmartSession + `ERC20SpendingLimitPolicy.sol` source · Altana SDK docs + audits page · `@trustwallet/cli` docs.
