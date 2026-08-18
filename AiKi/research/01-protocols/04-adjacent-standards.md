# Adjacent Standards — What AiKi Must Not Reinvent

**Research verdict:** SOLID
**Verified:** 18 August 2026
**Answers:** Charter questions **D1**, **D3**, **B4**

> The landscape moved substantially in the last 12 months. **Most 2025-vintage writing about it is now wrong**, including the assumptions embedded in AiKi's founding documents. Five corrections matter.

---

## 🚨 The blocking finding: BSC's dominant stablecoins cannot do gasless authorization

**Verified on-chain against chainId `0x38`:**

| Token | Address | EIP-3009 | EIP-2612 permit |
|---|---|:---:|:---:|
| **USDT (BSC)** | `0x55d398326f99059fF775485246999027B3197955` | ❌ | ❌ |
| **Binance-Peg USDC** | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | ❌ | ❌ |
| FDUSD | — | ✅ | ✅ |
| USD1 | — | ✅ | ✅ |
| Permit2 | canonical address | ✅ live | — |

Every probe against USDT and Binance-Peg USDC **reverts with empty data**.

### Why this is architecturally decisive

x402's `exact` scheme is built on **EIP-3009 `transferWithAuthorization`** — that is what makes the payment signable off-chain and settleable by a facilitator. **The dominant stablecoin on BSC does not implement it.**

So one of the following must be true, and the x402 research now in flight must determine which:

1. x402-on-BSC settles in a token that *does* support EIP-3009 — consistent with BNB Agent Studio settling in **`$U`** with "gasless transfers via EIP-3009" ([Agent Studio findings](../02-ecosystem/03-bnb-agent-studio.md)); or
2. x402-on-BSC uses a different scheme; or
3. x402-on-BSC does not really work with USDT and the ecosystem has quietly standardised on a niche asset.

**Consequences either way:**

- **AiKi cannot assume "pay in USDT" works with x402's exact scheme.** The Payment Router must model *token capability* — `supports_eip3009`, `supports_permit`, `requires_permit2` — as a first-class property, exactly as the MPSS's adapter philosophy prescribes for wallets.
- **Permit2 is the fallback** for USDT/USDC gasless approval, at the cost of a one-time approval to the Permit2 contract and a different signing flow.
- **There is a UX consequence.** Telling a user "you'll pay in USDT" and then requiring FDUSD or `$U` is exactly the kind of hidden friction that kills a checkout. Settlement-asset capability belongs in the quote, visible before authorization.

This is a hard constraint discovered by probing, not a preference. It is filed as a first-class risk.

---

## 1. AP2 v0.2 — adopt this mandate model, do not invent one

**This is the most important "do not rebuild" finding in the programme.**

AP2 v0.2 (published **2026-04-28**) **threw away** the Intent / Cart / Payment mandate trio and the W3C Verifiable Credentials framing that all 2025 writing describes. Any AiKi design based on that material is building against a dead schema.

### What it is now

Two mandate types, as **SD-JWT VCs**, delivered via OpenID4VP `transaction_data`:

| Type | `vct` |
|---|---|
| Checkout Mandate | `mandate.checkout.1` / `mandate.checkout.open.1` |
| Payment Mandate | `mandate.payment.1` / `mandate.payment.open.1` |

### The open/closed delegation model — this is AiKi's mandate primitive

- **Open mandate** = user-signed *constraint set* + agent `cnf` (confirmation) key
- **Closed mandate** = agent-signed *concrete instance* within those constraints

Two steps: **Mandate Delegation** (user approves Mandate Content on a Trusted Surface, receives a Mandate) and **Action Authorization** (Verifier challenges Agent; Agent proves possession).

And, verbatim from the Agent Authorization Framework:

> "AP2 makes use of this model for the payments use case, but **the model could be applied more generally in the future**."

**That is precisely AiKi's Mandate Builder, already specified by someone else, and explicitly designed to generalise beyond payments.**

### The constraint algebra already exists

`payment.budget` · `payment.amount_range` · `payment.agent_recurrence` · `payment.allowed_payees` · `payment.allowed_instrument` · `payment.allowed_pisp` · execution window · `checkout.line_items` — **with normative evaluation semantics.**

Closed Payment Mandate carries `vct`, `transaction_id` (base64url hash of the checkout JWT), `payee`, `pisp`, `payment_amount` (ISO-4217 + **integer minor units** — 27999 = $279.99), `payment_instrument`, and chaining to a Checkout Mandate.

Compare against the MPSS §14.1 policy dimensions — action allowlist, target allowlist, asset scope, value limits, time, approval mode. **The overlap is substantial.** AiKi's policy language should be a *superset* of AP2's algebra (AiKi additionally needs contract/selector allowlists and on-chain conditions like health-factor thresholds), expressed so that the payment-shaped subset **is** an AP2 mandate.

**→ Recommendation (labelled as such): adopt AP2's open/closed model and constraint vocabulary as the basis for ADR-005 (policy language), extending rather than replacing it.** Rationale: it is a real, versioned, normatively-specified schema from the ecosystem AiKi wants interoperability with; inventing a parallel one means carrying both the maintenance cost of a standard *and* the integration cost of theirs — the exact NIH failure the charter warned about.

### AP2 ships x402 as a first-class rail

Sample flows cover Human-Present Cards, **Human-Present x402**, Human-Not-Present Cards, **Human-Not-Present x402**, and Digital Payment Credentials.

⚠️ The repo's `x402_constants.py` currently targets **Base Sepolia only** (`DEFAULT_USDC_CONTRACT = "0x036CbD53842c5..."`). AP2's x402 support is real but **not BSC-configured out of the box.**

---

## 2. Execution Receipts already have an IETF standard

The MPSS proposes an AiKi-defined Execution Receipt schema. **Do not define a new format.**

| Standard | RFC | Status |
|---|---|---|
| **SCITT** (Supply Chain Integrity, Transparency and Trust) | **RFC 9943** | Proposed Standard, **June 2026** |
| **COSE Receipts** | **RFC 9942** | Proposed Standard, **June 2026** |
| RATS Architecture | RFC 9334 | |
| EAT (Entity Attestation Token) | RFC 9711 | |

Together these already provide the full receipt/attestation vocabulary: signed statements, transparency-log inclusion proofs, and attestation evidence.

**→ AiKi's Execution Receipt should be a *profile* of SCITT/COSE Receipts, not a new format.**

Why this is strictly better than inventing one:
- Receipts become verifiable by third parties with off-the-shelf tooling — which is the entire point of "prove what happened."
- Transparency-log inclusion proofs give append-only guarantees that match [HP-4](../00-method/02-hard-problems.md)'s evidence-integrity requirement, without building a bespoke log.
- AP2's own Receipt types (Checkout Receipt, Payment Receipt — signed, bound by hash to the closed Mandate) give the commerce-layer analogue to align with.

AP2's Payment Receipt shape, for reference: `status` (Success|Error), `iss`, `iat`, `reference` (*"the hash of the closed Mandate that this receipt is binding to"*), `payment_id`, `psp_confirmation_id`, `network_confirmation_id`.

**That `reference`-binds-to-mandate-hash pattern is exactly what AiKi needs**: a receipt cryptographically bound to the authority under which the work was done. It closes the loop between the Mandate Builder and the Receipt in a way a bare JSON blob cannot.

---

## 3. A2A v1.0.1 — the transport/discovery layer

Released **2026-05-28** (v1.0.0 was 2026-03-12) under the **Linux Foundation**, 150+ supporting organizations.

| Property | Value |
|---|---|
| Discovery | **`/.well-known/agent-card.json`** |
| Transports | declared per-interface in `supported_interfaces[]`: `JSONRPC` \| `GRPC` \| `HTTP+JSON` |
| Card signing | **detached JWS over RFC 8785 canonicalized JSON** |
| Serialization | protojson (lowerCamelCase), schema in `a2a.proto` |
| Extensions | negotiated per-request via the **`A2A-Extensions`** header; advertised in `AgentCapabilities.extensions[]` by URI |

Required AgentCard fields: `name`, `description`, `supported_interfaces`, `version`, `capabilities`.

**Signature verification, verbatim:** extract signature from `signatures[]` → retrieve key via `kid`/`jku` → **remove properties with default values** → **exclude the `signatures` field** → canonicalize (RFC 8785) → verify.

⚠️ That canonicalization procedure is easy to get subtly wrong. Removing default-valued properties before canonicalizing is unusual and will break naive implementations.

### Task lifecycle — 9 enum values

```
TASK_STATE_UNSPECIFIED = 0
TASK_STATE_SUBMITTED   = 1
TASK_STATE_WORKING     = 2
TASK_STATE_COMPLETED   = 3   terminal
TASK_STATE_FAILED      = 4   terminal
TASK_STATE_CANCELED    = 5   terminal
TASK_STATE_INPUT_REQUIRED = 6   interrupted
TASK_STATE_REJECTED    = 7   terminal
TASK_STATE_AUTH_REQUIRED = 8   interrupted
```

**A2A has no identity root and no payments.** It is discovery + transport. That is why it composes with ERC-8004 (identity) and AP2 (authorization) rather than competing.

**→ The `A2A-Extensions` header is the hook both AP2 and UCP use.** If AiKi exposes an A2A interface, extension negotiation is how commerce and mandate semantics ride on top.

---

## 4. ERC-8004 ↔ A2A: complementary by reference, not converging

ERC-8004 explicitly positions itself as the discovery/trust layer *below* A2A and MCP. Its registration file **references an A2A AgentCard by URL**; it does not embed or mirror the schema.

- ERC-8004 registration file: 4 descriptive fields (`type`, `name`, `description`, `image` — explicitly for ERC-721 app compatibility) + `services` / `registrations` / `supportedTrust` / `x402Support` / `active`.
- A2A AgentCard: 14 fields dominated by `capabilities`, `skills`, `securitySchemes`, `supportedInterfaces`, JWS signatures.

**There is no formal convergence effort.** And ⚠️ **ERC-8004's draft still pins A2A version `"0.3.0"`** — a version superseded by v1.0.0 in March 2026. The standard references a stale version of its neighbour.

**→ AiKi must resolve both** — chain identity from ERC-8004, capability detail from the A2A card — and reconcile them. Where they disagree, the chain-anchored fact wins for identity and the card wins for capability, with the disagreement itself recorded as evidence. Card JWS verification is a genuine Class-A/C signal that almost nobody checks.

---

## 5. The commerce-layer landscape

| Protocol | Status | Shape |
|---|---|---|
| **UCP** (Google Universal Commerce Protocol) | Launched **2026-01-11**, Apache-2.0, 3,314★, releases `v2026-01-11` / `v2026-01-23` / `v2026-04-08` | **The commerce layer AP2 secures.** Co-developed with Shopify, Etsy, Wayfair, Target, Walmart. **Amazon, Meta, Microsoft, Salesforce, Stripe joined the Tech Council 2026-04-24.** |
| **ACP** (OpenAI + Stripe) | Alive, API version **`2026-04-17`**, 1,513★ | Competing, **card/PSP-centric**. No crypto rail, no agent-identity layer. Version `2026-01-30` deprecated. |

**→ Neither is a direct AiKi competitor** — both are retail/checkout commerce, not delegated-work marketplaces. But **UCP + AP2 is consolidating into the default Western agent-commerce stack**, and AP2's mandate model is the piece AiKi genuinely overlaps with. Aligning there buys optionality; ignoring it means AiKi's mandates are a dialect nobody else speaks.

---

## 6. Impact on AiKi

| Finding | Decision |
|---|---|
| **BSC USDT + Binance-Peg USDC support neither EIP-3009 nor permit** | **Hard constraint.** Payment Router models token capability explicitly. Permit2 as fallback. Settlement asset must be visible in the quote. |
| FDUSD and USD1 support both | Candidate settlement assets — check liquidity before committing. |
| **AP2 v0.2 replaced its entire mandate model** | Any design from 2025 AP2 writing is wrong. |
| **AP2 open/closed mandates + constraint algebra** | **Adopt as the basis of ADR-005.** AiKi's policy language = superset; the payment-shaped subset *is* an AP2 mandate. |
| AP2 Receipt binds by hash to the closed Mandate | Adopt the pattern: receipt cryptographically bound to the authority it acted under. |
| **SCITT RFC 9943 + COSE Receipts RFC 9942** | **Execution Receipt = a profile of these, not a new format.** Third-party verifiable; transparency-log inclusion proofs satisfy HP-4. |
| A2A v1.0.1, card at `/.well-known/agent-card.json`, detached JWS over RFC 8785 | Verify card signatures — a real trust signal nobody checks. Mind the canonicalization subtleties. |
| A2A `A2A-Extensions` header | The extension hook if AiKi exposes an A2A interface. |
| ERC-8004 references A2A but **pins stale v0.3.0** | Resolve both; reconcile; record disagreement as evidence. |
| UCP+AP2 consolidating; ACP card-centric | Not direct competitors. Align with AP2 for optionality. |

---

## Sources

`a2aproject/A2A` releases + `specification/a2a.proto` @ v1.0.1 + `docs/specification.md` · `a2a-protocol.org` · Linux Foundation press release 2026-04-09 · `ap2-protocol.org` (v0.2, lastmod 2026-04-28) + GitHub release v0.2.0 · `universal-commerce-protocol/ucp` · `agentic-commerce-protocol/agentic-commerce-protocol` · RFC 9943, RFC 9942, RFC 9334, RFC 9711 · on-chain probes against chainId `0x38`.
