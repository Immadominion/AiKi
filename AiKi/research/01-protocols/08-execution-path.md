# The Execution Path — O-3 Resolved

**Research verdict:** SOLID · verified by direct RPC against chain 56, not documentation
**Date:** 19 August 2026
**Resolves:** blocker **O-3**, open item **O-2**, and ADR-006

---

## Headline

> **O-3 was not a blocker.** A production bundler serves chain 56 today. More importantly, we found a **better path that needs no bundler at all** — and it closes the rolling-window gap I previously said would require custom audited code.

Three things changed:

| Was | Now |
|---|---|
| "No bundler verified on 56 — the T0 path has no execution" | **Pimlico is live on 56**, verified by RPC. Plus `handleOps` is permissionless, so we can self-relay. |
| "Rolling-window caps need a custom policy contract we shouldn't write under deadline" | **`ERC20PeriodTransferEnforcer` is deployed on BSC and resets per period.** No custom code. |
| "Altana is T0 with an asterisk we couldn't close" | **Altana is genuinely T0 with a true rolling window** — but the audit does not cover the enforcing contract. |

---

## 1. Bundlers on chain 56 — verified live

**Pimlico public endpoint** `https://public.pimlico.io/v2/56/rpc`:

- `eth_chainId` → `"0x38"` (56)
- `eth_supportedEntryPoints` → **four** EntryPoints
- `pimlico_getUserOperationGasPrice` → 0.060 / 0.063 / 0.066 gwei tiers

That last call matters: a gas oracle answering with real prices proves a priced, operating service rather than a routing stub. At those prices a 200k-gas userOp costs ~**1.3 × 10⁻⁵ BNB** — sponsoring AiKi's session-key transactions is effectively free.

⚠️ **The chain must be numeric.** `/v2/56/rpc` works; `/v2/bsc/rpc` returns `-32000 chain "bsc" is not supported`. Same trap on thirdweb (`56.bundler.thirdweb.com` works, `bsc.` doesn't).

Authenticated shape: `https://api.pimlico.io/v2/56/rpc?apikey=KEY` — **query parameter, not a header** (confirmed by the server's own 401). Testnet 97 serves the identical EntryPoint list, so staging is available.

| Provider | Chain 56 | Notes |
|---|---|---|
| **Pimlico** | ✅ verified by RPC | 4 EntryPoints, gas oracle live, public tier 20 req/min/IP |
| Biconomy | ✅ documented | Bundler + sponsorship + token paymaster — but **EntryPoint v0.7 only**, not v0.8/7702 |
| Etherspot / Skandha | ✅ routes 56 | Auth-rejects, not chain-rejects. **Open source and self-hostable** — the strategic option |
| thirdweb | ✅ routes 56 | Numeric subdomain + `x-client-id` header |
| ZeroDev | likely (multiplexes Pimlico) | Unverified directly |
| Candide/Voltaire | ❌ no chain-56 route | |
| Alchemy, Stackup | unconfirmed | |

### ⚠️ A fourth EntryPoint exists

`eth_getCode` on chain 56 found **four** deployed EntryPoints, not the three previously verified:

| Version | Address | Bytecode |
|---|---|---:|
| v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | 23,689 B |
| v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | 16,035 B |
| v0.8 | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` | 21,738 B |
| **v0.8.x?** | **`0x433709009B8330FDa32311DF1C2AFA402eD8D009`** | **22,425 B** |

The fourth is likely a patched v0.8 point release. **Determine which is canonical before committing** — account factories and SmartSession registrations are EntryPoint-scoped, and migrating later is painful.

### The architectural constraint that decides this

> **Rhinestone SmartSession is an ERC-7579 *validator*** — it works through `validateUserOp`. It therefore **requires the EntryPoint path** and cannot be driven by a bare EIP-7702 direct call.

So "use SmartSession" and "skip the bundler" are mutually exclusive. That forces a real choice, which §3 makes.

---

## 2. Altana — T0 confirmed, but not where anyone was looking

**O-2 is closed, and the answer is more interesting than expected.**

The spend cap is **not** enforced by `KeyStore` (`0x6572427E…`) or `KeyStoreController` (`0x0834Ee2C…`). **Those are a permission registry.** Enforcement lives in the **Altana account implementation** at:

```
0x4b5d20cd8a3927b500540d9bccddc27385c9fa79   (v0.5.10, chain 56)
```

— the EIP-7702 delegation target, which is **Porto** (`ithacaxyz/account`) as a pinned dependency per Altana's own docs.

Verified on live BSC RPC, this bytecode exposes:

```solidity
setSpendLimit(bytes32, address, uint8, uint256)
removeSpendLimit(...)
spendInfos(bytes32)
startOfSpendPeriod(uint256, uint8)
```

And `eth_call` on `startOfSpendPeriod` returns **true rolling-window boundaries** — minute, day and year all snap to exact UTC boundaries. Enforcement is `GuardedExecutor._incrementSpent`, which **reverts `ExceededSpendLimit(token)`** and zeroes `spent` on entering a new period.

**So Altana's `period` field is real and genuinely rolling — a capability Rhinestone's `ERC20SpendingLimitPolicy` (lifetime, monotonic) does not have.**

### ⚠️ Three caveats the UI must carry

1. **The CertiK audit does not cover the enforcing contract.** Scope was `KeyStore.sol` + `KeyStoreCacheOPStack.sol` and six files — **the registry, not the account implementation that actually reverts.** Citing "CertiK audited" next to the spend cap would be misleading.
2. **No Sourcify verification** for any of the four addresses.
3. **The enforcing contract's mainnet address is undocumented**, and the SDK **blind-signs relay-built intents**.

Tier: **T0**, with `verified: true` for the mechanism and an explicit `caveat` naming the audit-scope gap. That is exactly what the `EnforcementInfo.caveat` field exists for.

---

## 3. ✅ The recommended path — self-relay, no bundler

**MetaMask Delegation Framework v1.3.0 (ERC-7710) is deployed on BSC mainnet**, confirmed by bytecode:

| Contract | Address | Code |
|---|---|---:|
| DelegationManager | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` | 11.5 KB |
| EIP7702StatelessDeleGatorImpl | `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` | 11.2 KB |

Plus **every caveat enforcer AiKi needs**: `ERC20PeriodTransferEnforcer`, `TimestampEnforcer`, `AllowedTargetsEnforcer`, `AllowedMethodsEnforcer`, `ValueLteEnforcer`, `LimitedCallsEnforcer`, `RedeemerEnforcer`, `MultiTokenPeriodEnforcer`.

### 🎯 The single most important finding

> **`ERC20PeriodTransferEnforcer` is a RESETTING periodic cap** — *"the transferable amount resets at the beginning of each period."*

This closes the exact gap documented in [mandate-enforcement](07-mandate-enforcement.md): on BSC, Rhinestone's `ERC20SpendingLimitPolicy` is lifetime-only and `TimeFrame`/`UsageLimit`/`ValueLimit` are **not deployed at all**.

**We can now honestly say "$250 per month, renewing" and have the chain enforce it — with no custom contract and no audit of our own.** The previous recommendation to ship lifetime-only caps is superseded.

### The flow

```ts
// 1. Delegate the user's EOA to the stateless delegator (type-0x4 SetCode tx)
const auth = await walletClient.signAuthorization({
  account,
  contractAddress: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
})
await walletClient.sendTransaction({ authorizationList: [auth], to, data })

// 2. AiKi's relayer redeems the delegation as the delegate, paying gas in BNB
await walletClient.writeContract({ address: DELEGATION_MANAGER, functionName: 'redeemDelegations', ... })
```

viem 2.55.19 exposes both `signAuthorization` and `sendTransaction({ authorizationList })`.

**No bundler. No EntryPoint. No paymaster. No vendor API key.** AiKi pays gas as the transaction sender while the user's delegated account authorises the action.

Also live: eth-infinitism's `Simple7702Account` at `0xe6Cae83BdE06E4c305530e199D7217f42808555B` (3.6 KB) — but it **enforces nothing**. It is a batching shim, not scoped authority. Do not mistake it for a delegation target.

### Honest comparison

| Option | Eng days | Rolling caps | Dependency |
|---|---:|---|---|
| **7702 self-relay + Delegation Framework** | **5–8** | ✅ native | DelegationManager only |
| ERC-4337 + SmartSession + Pimlico | 8–14 | ❌ lifetime only | Bundler + Rhinestone + 3 undeployed policies |
| Bespoke session-key contract | 10–15 **+ audit** | ✅ if we build it | None — but unaudited fund-holding code |

### ⚠️ The one real caveat

**`DelegationManager` carries a `whenNotPaused` modifier.** So "no vendor dependency" is not literally true — MetaMask can pause it. Build the executor behind a thin interface with a fallback path, and surface the pausability in the Passport risk section exactly as we do for ERC-8183's upgradeable proxy.

---

## 4. Decisions this settles

**ADR-006 (wallet custody boundary) — unblocked. Recommended:**

> Primary execution is **EIP-7702 self-relay via the MetaMask Delegation Framework**, giving T0 chain-enforced constraints including genuine rolling-window spend caps, with AiKi as relayer paying gas. ERC-4337 + Pimlico stays behind the same adapter interface as a secondary path for accounts that are already smart accounts. `Simple7702Account` is explicitly not a delegation target.

**Changes to earlier documents:**

- [mandate-enforcement §2](07-mandate-enforcement.md) — the recommendation to ship lifetime-only caps is **superseded**. Rolling windows are available without custom code.
- [system-architecture §6.2](../03-architecture/02-system-architecture.md) — "rolling window ❌ needs custom policy" becomes ✅ via `ERC20PeriodTransferEnforcer`.
- ADR-014 ("ship lifetime caps") — **withdrawn**.
- `CapPeriod` in the API contract can now legitimately offer `per_month` at T0.

**Still open:** which of the two v0.8 EntryPoints is canonical (only matters if we take the 4337 path), and Sourcify verification for the Altana account implementation.

---

## Sources

Live RPC: `public.pimlico.io/v2/56/rpc`, `api.pimlico.io/v2/56/rpc`, `rpc.etherspot.io/v2/56`, `56.bundler.thirdweb.com/v2`, `bsc-dataseed1.binance.org` (`eth_getCode`, `eth_call`).
Docs: `docs.pimlico.io/references/bundler/public-endpoint`, `docs.biconomy.io/contracts-and-audits/supported-chains`, Altana docs, `ithacaxyz/account` (Porto), MetaMask Delegation Framework, viem 2.55.19.
Raw research: `research/_raw/o3/`.
