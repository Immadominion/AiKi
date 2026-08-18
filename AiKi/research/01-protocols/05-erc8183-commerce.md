# ERC-8183 "Agentic Commerce" — Spec vs Deployment

**Research verdict:** SOLID
**Verified:** 18 August 2026, by direct `eth_call` against BSC public RPC
**Answers:** Charter question **A2**

---

## Headline

**ERC-8183 is real, deployed, and busy.** This was the question the charter flagged as most likely to come back "paper spec." It didn't.

> **Highest live job ID: 56,610 — submitted 2026-08-18T11:54:17Z, hours before this research ran.**

And a second headline that costs a day of debugging if missed:

> **⚠️ The deployed ABI diverges from the EIP text on two functions. Build against the deployed ABI.**

---

## 1. Spec

| Field | Value |
|---|---|
| Status | **Draft**, Standards Track / ERC |
| Created | **2026-02-25** |
| Requires | **EIP-20** |
| Authors | Davide Crapis, Bryan Lim, Tay Weixiong, Chooi Zuhwa |
| Discussion | `ethereum-magicians.org/t/erc-8183-agentic-commerce/27902` |

Note Davide Crapis co-authors both ERC-8004 and ERC-8183 — the identity and commerce layers are designed together.

```solidity
enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }

struct Job {
    uint256   id;
    address   client;
    address   provider;
    address   evaluator;
    string    description;
    uint256   budget;
    uint256   expiredAt;
    JobStatus status;
    address   hook;
}

function createJob(address provider, address evaluator, uint256 expiredAt,
                   string calldata description, address hook) external returns (uint256);
function setProvider(uint256 jobId, address provider_) external;
function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;
function fund(uint256 jobId, bytes calldata optParams) external;
function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
function claimRefund(uint256 jobId) external;
function getJob(uint256 jobId) external view returns (Job memory);
```

Events: `JobCreated`, `ProviderSet`, `BudgetSet`, `JobFunded`, `JobSubmitted`, `JobCompleted`, `JobRejected`, `JobExpired`, `PaymentReleased`, `Refunded`.

Errors: `InvalidJob`, `WrongStatus`, `Unauthorized`, `ZeroAddress`, `ExpiryTooShort`, `ZeroBudget`, `ProviderNotSet`, `FeesTooHigh`, `HookNotWhitelisted`.

```solidity
interface IACPHook is IERC165 {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}
```

### State machine

| Transition | Caller | Condition |
|---|---|---|
| Open → Funded | **Client** | Provider set; budget matches expected |
| Open → Rejected | **Client** | Only while Open |
| Funded → Submitted | **Provider** | Job is Funded |
| Funded/Submitted → Completed | **Evaluator** | Job is Submitted |
| Funded/Submitted → Rejected | **Evaluator** | Before or after submission |
| Funded/Submitted → **Expired** | **Anyone** | `block.timestamp >= expiredAt` |

Terminal: `Completed`, `Rejected`, `Expired`.

**Two design details worth respecting:**

- **The expiry path (`claimRefund`) is deliberately not hookable**, so a malicious or buggy hook cannot block recovery of escrowed funds. That is a well-considered safety property, and AiKi's own commerce model should preserve the equivalent invariant: *no extension point may trap a user's money.*
- **Fees (platform + evaluator) are deducted only on `Completed`.** Failure is free for the client.
- **Expiry is permissionless** — anyone may expire a stale job. AiKi can run this as a keeper service, which is a small, cheap, visible way to be a good ecosystem citizen.

ERC-8004 integration is **RECOMMENDED, not required** — reputation is optional. So a job can settle with no identity attached, which means **on-chain job history is not automatically linkable to an agent identity.** AiKi's evidence graph must handle that join explicitly, and unlinked jobs are weaker evidence.

---

## 2. Deployment — verified on-chain

All four addresses hold code, checked by direct RPC rather than a README or explorer page.

| Contract | Address (BSC 56) |
|---|---|
| **AgenticCommerce** (ERC-1967/UUPS proxy) | `0xEa4DAa3100A767e86FDed867729ae7446476EBA6` |
| ↳ implementation | `0xd5f9b570c96b5d67702d508c0bfb8b3b09209787` (10,893 bytes runtime) |
| **EvaluatorRouter** | `0x51895229E12F9876011789B04f8698af06cCD6DA` |
| **OptimisticPolicy** | `0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5` |
| **Payment token** | `0xcE24439F2D9C6a2289F741120FE202248B666666` |
| owner() | `0x5057b09a4b510ccaf7e3fb3038ba60713e62b1fc` |

**The payment token is `$U` — "United Stables", symbol `U`, 18 decimals, ~1.0198 × 10⁹ supply**, itself a transparent proxy. `paymentToken()` returns it, so **the escrow is single-asset**: jobs settle in `$U`, not USDT.

**Liveness:** job IDs are sequential; binary search puts the highest live job at **56,610**, submitted the same day this research ran.

**The EvaluatorRouter is the `IACPHook`.** Most jobs carry `evaluator = 0x51895229…`, and that contract also implements `beforeAction`/`afterAction`. So the router is simultaneously the on-chain evaluator of record and the hook — a single point of both extension and centralisation worth noting in the threat model.

Ops surface on the proxy: `pause`/`unpause`/`paused`, `Ownable2Step` (`owner`, `pendingOwner`, `acceptOwnership`, `transferOwnership`, `renounceOwnership`), UUPS (`proxiableUUID`, `upgradeToAndCall`).

> ⚠️ **This is an upgradeable, pausable, owner-controlled contract.** The owner can pause all commerce and upgrade the implementation. That is a real trust assumption AiKi inherits and should surface honestly — it belongs in the risk section of any agent Passport whose jobs settle here.

---

## 3. ⚠️ Deployed ABI ≠ EIP text

Selectors matched against computed `keccak256`:

| Selector | Deployed signature | Spec says |
|---|---|---|
| `0x41528812` | `createJob(address,address,uint256,string,address)` | ✅ matches |
| `0xc9a84bb9` | **`setProvider(uint256,address,bytes)`** | ❌ `setProvider(uint256,address)` |
| `0xdd4ae9d4` | `setBudget(uint256,uint256,bytes)` | ✅ matches |
| `0xd2e13f50` | **`fund(uint256,uint256,bytes)`** | ❌ `fund(uint256,bytes)` |
| `0x9e63798d` | `submit(uint256,bytes32,bytes)` | ✅ |
| `0xd75bbdf3` | `complete(uint256,bytes32,bytes)` | ✅ |
| `0x41dd26f5` | `reject(uint256,bytes32,bytes)` | ✅ |
| `0x5b7baf64` | `claimRefund(uint256)` | ✅ |
| `0xbf22c457` | `getJob(uint256)` | ✅ |

Also present: `jobs(uint256)` `0x180aedf3`, `jobCounter()` `0x50355d76`, `paymentToken()` `0x3013ce29`, `platformTreasury()` `0xe138818c`, `BP_DENOMINATOR()` `0xabe685cd`.

**`fund` taking an explicit amount rather than deriving it from the stored budget is a meaningful semantic difference**, not a cosmetic one — it changes what the client asserts at funding time and opens an amount-mismatch failure mode the spec's signature does not have.

**→ Rule: the `CommerceProtocolAdapter` must be generated from the deployed ABI and pinned by implementation address.** The EIP text is a design reference, not an integration contract. And since the proxy is upgradeable, the adapter needs a startup check that the implementation address still matches the one it was built against.

---

## 4. Impact on AiKi

| Finding | Consequence |
|---|---|
| **ERC-8183 is deployed and actively used (job 56,610 same-day)** | The commerce adapter has a real target. A2 resolved favourably. |
| **Deployed ABI diverges on `fund` and `setProvider`** | Generate from deployed ABI; pin implementation address; assert on startup. |
| Escrow is single-asset **`$U`** | Reinforces the [x402 finding](06-x402-payments.md): **USDT is not the settlement asset on BSC.** The quote must state the settlement asset. |
| `claimRefund` is not hookable | Adopt the invariant: no extension point may trap user funds. |
| Fees only on `Completed` | Failure is free for the client — good default; mirror it. |
| Expiry is permissionless | AiKi can run a keeper. Cheap, visible ecosystem contribution. |
| **EvaluatorRouter is both evaluator and hook** | Single point of extension *and* centralisation. Threat-model it. |
| **Proxy is upgradeable + pausable + owner-controlled** | Inherited trust assumption. Surface it in the Passport risk section. |
| ERC-8004 integration is optional | On-chain jobs are **not** automatically linkable to an agent identity. Unlinked jobs are weaker evidence; the graph join must be explicit. |
| Nine typed custom errors | Map to AiKi's retryable/non-retryable error model (MPSS §23.2). |
| ERC-2771 meta-tx support | Relayed job creation is possible — relevant to gasless UX. |

### Open gap

**BscScan source-verification status could not be established** — Cloudflare returned 403 to both WebFetch and headless Chrome, and there is no free explorer API. The bytecode-level selector analysis is strong evidence the contracts do what they claim, but **independent source verification is still outstanding.** Resolve with an Etherscan v2 API key before mainnet funds flow.

---

## Sources

`https://eips.ethereum.org/EIPS/eip-8183` · `ethereum-magicians.org/t/erc-8183-agentic-commerce/27902` · direct `eth_call` / `eth_getCode` against BSC public RPC, chain 56.
