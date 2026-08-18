# x402 — Machine Payments, and What Actually Works on BSC

**Research verdict:** SOLID
**Verified:** 18 August 2026, including on-chain bytecode inspection
**Answers:** Charter questions **A3**, **B4**

---

## Three findings that change the payment design

1. **x402 has two incompatible wire protocols.** v2 is current; the unscoped npm packages are frozen at v1. Building against v1 types is building against a dead API.
2. **USDT on BSC does not implement EIP-3009 — confirmed at the bytecode level.** x402's recommended `eip3009` path is unavailable for the dominant BSC stablecoin. Worse, **chain 56 is absent from x402's `DEFAULT_STABLECOINS` map**, so the `price: "$0.10"` convenience API *throws* on BSC.
3. **B402 is not a BNB Chain protocol** — prior research is refuted. It is a third-party project, it abandons EIP-3009, and its documented "RelayerV3 contract" **has no code on either BSC or Base — the address is an EOA.**

---

## 1. Two wire protocols

| | **v1** (frozen) | **v2** (current) |
|---|---|---|
| Headers | `X-PAYMENT`, `X-PAYMENT-RESPONSE` | **`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`** |
| Data location | Requirements in the JSON **body** | **All protocol data in base64 headers**; body is free |
| Network id | ad-hoc names | **CAIP-2** (`eip155:84532`) |
| Amount field | `maxAmountRequired` | **`amount`** |
| Resource metadata | inside `PaymentRequirements` | hoisted to a sibling **`resource`** object |
| npm | `x402`, `x402-fetch` @ **1.2.x frozen** | **`@x402/*` @ 2.23.0** |

```ts
// typescript/packages/core/src/types/payments.ts  (v2)
export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export type PaymentRequirements = {
  scheme: string;
  network: Network;   // CAIP-2
  asset:  string;
  amount: string;
  payTo:  string;
  // …
};
```

**Moving all protocol data into headers is significant for AiKi**: it means a paid resource can stream a body while the payment envelope stays in metadata — which suits agent jobs that return large artifacts. It also means an intermediary (AiKi's gateway) can inspect and meter payments without buffering bodies.

**→ Pin `@x402/*` v2 and CAIP-2 network identifiers from the start.**

---

## 2. 🚨 The BSC settlement problem

### USDT on BSC: verified negative

`0x55d398326f99059fF775485246999027B3197955` — deployed bytecode contains **none** of:

| Function | Selector |
|---|---|
| `transferWithAuthorization` | `0xe3ee160e` |
| `receiveWithAuthorization` | — |
| `authorizationState` | — |
| `DOMAIN_SEPARATOR` | — |

`eth_call` to the last two **reverts**. There is also no EIP-2612 `permit`.

**And it is 18 decimals, not 6** — a detail that silently produces 10¹² -sized errors for anyone porting Ethereum/Base USDC assumptions to BSC.

### What this eliminates

| Path | Status on BSC USDT |
|---|---|
| x402 `exact` scheme via EIP-3009 | ❌ unavailable |
| Gasless EIP-2612 approval to Permit2 | ❌ unavailable |
| User-paid `approve(Permit2)` | ✅ works — costs a transaction and a UX step |
| Facilitator-sponsored ERC-20 approval extension | ✅ possible |

Additionally: **chain 56 is absent entirely from x402's `DEFAULT_STABLECOINS` map**, so the ergonomic `price: "$0.10"` sugar throws. Every BSC integration must specify `asset` + `amount` explicitly.

### `$U` is the asset that works

`0xcE24439F2D9C6a2289F741120FE202248B666666` — **"United Stables", symbol `U`, 18 decimals, ERC-1967 proxy** — and its implementation **does** implement EIP-3009. The live `DOMAIN_SEPARATOR` was brute-forced to recover the exact EIP-712 domain.

This closes the loop across three independent research threads:

- Agent Studio settles in `$U` with "gasless transfers via EIP-3009"
- ERC-8183's `paymentToken()` returns `$U`
- USDT structurally *cannot* support the scheme

**→ `$U` is not a quirky choice. It is the only asset on BSC that makes the whole agent-commerce stack work.** AiKi must treat it as the default settlement asset and stop assuming USDT.

### Design consequence

The Payment Router must model **token capability** as first-class:

```
supports_eip3009 | supports_permit2612 | requires_permit2_approval | decimals
```

…and the **settlement asset must be visible in the quote, before authorization.** Promising "pay in USDT" and demanding `$U` at signing is precisely the hidden friction that kills a checkout — and it would violate the MPSS's own cost-transparency requirement (`FR-PAY-002`).

⚠️ **`$U` liquidity is an open question.** Being the technically-correct asset does not make it a *usable* one for a consumer. Depth, on/off-ramps, and how a user acquires it must be answered before the checkout UX is designed. **This is a product risk, not just an engineering one.**

---

## 3. B402 — prior research refuted

The earlier finding was *"B402 is a BNB Chain roadmap item; the term appears in no BNB source."* **That is wrong in an important way.**

B402 **exists, is documented, and is live** — but:

- it is **`b402.ai`, a third-party Apache-2.0 project**, *not* a BNB Chain protocol;
- it **deliberately abandons EIP-3009**;
- its documented **"RelayerV3 contract" has no code on BSC or Base — the address is an EOA.**

That last point inverts its trust model entirely. A relayer users are told is a *contract* — auditable, with enforced logic — is in fact **a private key**. Whoever holds it is trusted unconditionally.

**→ Do not integrate B402 without a direct security review.** And the general lesson is one the charter already insists on: *verify that a claimed contract has code before treating it as a contract.* This is now the second instance in this programme where an address in documentation did not mean what the documentation implied.

---

## 4. Facilitator trust

The facilitator performs `/verify` and `/settle`. Concretely it can:

- **censor** — decline to settle a valid payment;
- **stall** — hold a signed authorization until it expires;
- **not steal**, provided the authorization is properly scoped (EIP-3009 binds `to`, `value`, `validAfter`, `validBefore`, `nonce`).

**→ AiKi should run its own facilitator for its own settlement path** rather than depending on a third party for the money leg, and treat external facilitators as an adapter with a declared trust level — the same capability-not-vendor posture the MPSS mandates for wallets. Facilitator identity belongs in the Execution Receipt.

---

## 5. Impact on AiKi

| Finding | Consequence |
|---|---|
| **x402 v2 is current; v1 npm frozen at 1.2.x** | Pin `@x402/*` 2.23.0. Use CAIP-2 network ids. |
| All protocol data in headers (v2) | Gateway can meter payments without buffering bodies; large artifacts stream freely. |
| **USDT-BSC has no EIP-3009 and no permit; 18 decimals** | The `exact` scheme is unavailable for USDT. Permit2 needs a user-paid approval. |
| **chain 56 absent from `DEFAULT_STABLECOINS`** | The `price: "$0.10"` API throws. Always specify `asset` + `amount`. |
| **`$U` implements EIP-3009 and is ERC-8183's `paymentToken`** | Default settlement asset. Three research threads converge. |
| **`$U` liquidity unknown** | Open product risk. Answer before designing checkout. |
| **B402 is third-party; its "RelayerV3 contract" is an EOA** | Do not integrate without security review. Verify code-at-address before trusting any documented contract. |
| Facilitator can censor/stall but not steal | Run our own for AiKi's settlement path. Record facilitator identity in the Receipt. |

---

## Sources

`github.com/coinbase/x402` (spec markdown + `typescript/packages/core/src/types/payments.ts`) · npm `@x402/*` · `b402.ai` docs · direct `eth_getCode` / `eth_call` against chain 56 for `0x55d398…7955` and `0xcE2443…666666`.
