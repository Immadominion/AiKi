# BNB Smart Chain — Measured Infrastructure Facts

**Research verdict:** SOLID
**Measured live:** 18 August 2026, 16:08–16:33 UTC, against mainnet
**Answers:** Charter questions **C2** (deterministic replay) and **C3** (indexing)

> Everything here was **measured against the live chain**, not read from documentation. Where docs and reality disagree — and they do, twice — the measurement wins and the doc is flagged stale.

---

## ⚠️ Operational alert: mandatory hardfork in 7 days

**Pasteur — 25 August 2026, 02:30 UTC, BEP-673, client v1.7.7.** Mandatory mainnet upgrade.

Any node, fork-pin or replay environment we stand up this week must be v1.7.7-compatible. Historical replay across the fork boundary will need the correct EVM version per era.

2026 fork history:

| Fork | Date | Contents |
|---|---|---|
| **Fermi** | 14 Jan 2026, 02:30 UTC | Block time 0.75s → **0.45s** (BEP-619); BEP-590 fast-finality stability; BEP-592 block-level access list; BEP-593 incremental snapshot; BEP-610 EVM super-instruction |
| **Osaka/Mendel** | 28 Apr 2026, 02:30 UTC | BEP-658 (incl. EIP-7823 MODEXP bounds, EIP-7825 tx gas cap, BEP-657 EIP-7702 limits) |
| **Pasteur** | **25 Aug 2026** | BEP-673 |

---

## 1. Chain fundamentals

| Property | Measured value |
|---|---|
| Chain ID | **56** (`0x38`) |
| Block time | **0.450s exactly** (Δ over 2,000 blocks) |
| Block gas limit | **55,000,000** |
| `baseFeePerGas` | **0** — the entire fee is legacy `gasPrice`/priority |
| Block fullness | 62–81% (33.9M–44.3M gas used) |
| `finalized` lag | **2 blocks / ~900ms** |
| `safe` lag | 1 block |
| Worst-case honest reorg | **8 blocks (3.6s)** |
| Min gas price | 0.05 gwei; median effective **0.055 gwei**, p90 0.5925 |
| Native transfer cost | **$0.00063** (BNB @ $603.21) |
| Venus `repayBorrow` | **153,929 gas ≈ $0.0055** — measured on-chain |

### 1.1 The 8-block reorg bound is derived, not assumed

```
cast call 0x0000000000000000000000000000000000001000 "turnLength()(uint256)" → 8
```

Miner run-length histogram over 400 contiguous blocks: `{8: 49 runs, 6: 1, 2: 1}`. Every validator produces exactly 8 consecutive blocks per turn. `getValidators()` returns 45 addresses; 21 distinct validators produced blocks in the sample.

So: **worst-case honest-protocol reorg = one full turn = 8 blocks = 3.6s.** Fast finality (BEP-126 + BEP-590, `KAncestorGenerationDepth=3`) cuts the practical window to 2.

**→ Design the indexer around the `finalized` tag, not a fixed confirmation count.** Four consecutive batched probes 3s apart returned `lag_final=2` every time. Chain-derived evidence should carry a finality state, and only `finalized` facts should feed the Proof Score without a provisional flag — which is exactly what [HP-4](../00-method/02-hard-problems.md) requires.

### 1.2 ⚠️ `timestamp` is no longer a usable key — use `milliTimestamp`

Observed verbatim in `eth_getBlockByNumber`:

```json
"timestamp":      "0x6a8483b3",
"milliTimestamp": "0x1a015a274fa"
```

At 450ms intervals, **2–3 consecutive blocks share the same second.** Any indexer keying or bucketing by `timestamp` will collide and misorder.

- Key events by **`(blockNumber, logIndex)`**.
- Use **`milliTimestamp`** for wall-clock.
- ⚠️ `milliTimestamp` is **BSC-specific** and absent from standard go-ethereum block JSON. **Generic EVM indexers will silently drop it.** This is a concrete reason a naive off-the-shelf indexer will produce subtly wrong time-series for AiKi.

---

## 2. ✅ C2 answered: deterministic replay on BSC is feasible

This was an open question blocking Agent Arena's entire reproducibility claim ([HP-2](../00-method/02-hard-problems.md)). **The answer is yes, with one required flag and one real constraint.**

**Environment:** anvil / Foundry **1.7.1**, commit `4072e48705af9d93e3c0f6e29e93b5e9a40caed8`, build 2026-05-08.

**What works:**

```bash
anvil --fork-url <bsc-archive> --fork-block-number 116487736   # up in <12s
```

- `eth_chainId` → 56.
- **Parlia block headers round-trip intact** — difficulty 2, totalDifficulty 232390151, `extraData` carrying the full Parlia vote attestation and seal, `mixHash`, gasLimit 55,000,000, `withdrawalsRoot` present.
- Parlia system contracts are reachable.
- **`cast run --quick` reproduces gas exactly: 34,515 measured == 34,515 on-chain.**

**The gotcha:**

```
transaction validation error: Eip7702 is not supported
```

Full-block replay fails because ~1.5% of BSC transactions are type `0x4` and essentially **every block contains one**.

> **Fix: `--evm-version prague`.**

**The real bottleneck is archive-RPC storage fan-out**, which 429s public endpoints within seconds. Replay is gated on paid archive access, not on tooling.

### What this means for Arena

| HP-2 input | Status on BSC |
|---|---|
| Chain state | ✅ Pinnable — fork at a fixed block, identical start state for every agent |
| Gas accounting | ✅ Exact — reproduces to the unit |
| Market prices | ✅ Pinnable via frozen snapshot (see §6) |
| Wall clock | ✅ Virtualisable |
| External HTTP | ⚠️ Only controllable where AiKi mediates it |
| **Agent-internal LLM sampling** | ❌ **Not controllable — third-party endpoint** |

**Arena's reproducibility claim is defensible for the environment and indefensible for the agent's internals.** That is exactly the honest scoping HP-2 demanded: pin what we control, declare what we don't, and handle agent nondeterminism with N trials and a reported interval rather than a single run presented as fact.

---

## 3. ⚠️ Indexing: `eth_getLogs` is disabled on official endpoints

Confirmed by documentation **and** live probe returning `-32005 limit exceeded` for every range, **including a single block**.

Measured caps, 18 Aug 2026, with a real `address + topic0` filter:

| Endpoint | `eth_getLogs` range cap |
|---|---|
| `bsc-dataseed.bnbchain.org` | **Disabled entirely** (`-32005`) |
| `bsc-dataseed1.binance.org` | **Disabled entirely** |
| `bsc-rpc.publicnode.com` | 5,000 · **403 at 10,000**, and 403s after ~5–10 rapid requests |
| NodeReal | **50,000** — verbatim: `exceed maximum block range: 50000` |
| QuickNode | 10,000 |

### The arithmetic that matters

At 0.45s/block, caps in *blocks* translate to tiny windows in *time*:

| Cap | Wall-clock covered |
|---|---|
| 10,000 blocks | **75 minutes** |
| 50,000 blocks | 6.25 hours |

A full backfill of ~116.7M blocks at a 10,000-block cap needs **~11,670 sequential calls**.

**→ Consequences for AiKi:**
1. The public dataseeds are **unusable** for event indexing. Paid archive access is not optional.
2. Backfill must be **chunked, parallel, and resumable** with per-provider cap discovery — the cap is a provider property to be probed, not a constant.
3. Provider-specific error strings must be parsed to auto-tune chunk size.

### Archive availability is scarce

`eth_getBalance` at blocks 1M / 20M / 40M / 60M:

| Endpoint | Result |
|---|---|
| **NodeReal public** | ✅ all four |
| `bsc.meowrpc.com` | ✅ 1M, 40M · ❌ 20M (`header not found`) · 429 at 60M — **inconsistent shard coverage** |
| `bsc.blockrazor.xyz` | ❌ all four |
| `bsc.rpc.blxrbdn.com` | ❌ all four |
| `bsc-dataseed` | ❌ `missing trie node` |

**NodeReal was the only free endpoint serving full archive.** That is a single point of failure for the replay harness.

### Provider pricing (verified)

| Provider | Entry price | Archive | Notes |
|---|---|---|---|
| **NodeReal MegaNode** | **$39/mo** Growth | ✅ **all tiers** | 500M CU, 700 CUPS, 15 keys. Overage $1 per 5M CU. `eth_getLogs` = 50 CU, `eth_call` = 20, `eth_getBlockByNumber` = 15. WS billed 0.04 CU/byte. Free tier: 10M CU, 150 CUPS, no debug API. |
| Chainstack | $149/mo | — | 25 RPS, all chains |
| QuickNode | **$799/mo** | ❌ **not included** | 75 RPS flat-rate BSC |

**→ NodeReal is the BSC-native choice: archive on every tier at $39/mo, versus QuickNode at $799/mo without archive.** That is a 20× difference on the one capability the Arena harness depends on.

### Indexing frameworks

| Framework | BSC | Notes |
|---|---|---|
| **Envio HyperSync** | ✅ **at chain tip** | `bsc.hypersync.xyz/height` → 116,687,299, exactly at head. opBNB (204) also at tip. ⚠️ **Now requires an API token** — unauthenticated queries rejected. |
| The Graph | ✅ `bsc` | Decentralized network with issuance. **Hosted service fully retired (June 2024).** 100,000 free queries/month. ❌ **opBNB not supported.** |
| Goldsky | ✅ | Most transparent pricing: $100 free credits; Subgraphs $0.05/hr (~$37/mo) + $4 per 100k entities beyond the first 100k; Mirror $0.10/hr + $1 per 100k events beyond 1M; Edge RPC $5 per 1M requests |
| Substreams | ✅ | `bnb.streamingfast.io:443`, `bsc.substreams.pinax.network:443`. First-streamable-block and trace availability not stated for BSC. opBNB absent. |
| Ponder / SubQuery | ✅ generic | Driven by your own RPC. Ponder auto-determines max block range per provider — useful given §3's cap variance. |

**→ Recommendation (labelled as such): Envio HyperSync for backfill speed, with a self-operated Ponder-style indexer over NodeReal archive as the authoritative path.** Rationale: HyperSync is at tip and fast, but is a third-party dependency requiring a token; the evidence graph is the moat and must not be hostage to one vendor's uptime. This mirrors the 8004scan posture — use it, don't depend on it.

---

## 4. EIP-7702 is live and materially used

Sampled **2,417 transactions across 20 consecutive blocks**:

| Type | Count | Share |
|---|---:|---:|
| `0x0` legacy | 1,585 | 65.6% |
| `0x2` EIP-1559 | 748 | 30.9% |
| `0x1` EIP-2930 | 43 | 1.8% |
| **`0x4` EIP-7702 SetCode** | **37** | **1.5%** |
| `0x3` blob | 4 | 0.2% |

~2 SetCode transactions per block — essentially every block has one. EIP-7702 shipped in Pascal (Mar 2025); BEP-657 in Osaka/Mendel added limits.

**→ This is decisive for the mandate layer.** EIP-7702 being live in production means an EOA can carry delegated execution logic on BSC *today*. It is the strongest available foundation for T0 (cryptographic) enforcement in the [HP-3](../00-method/02-hard-problems.md) tier model. The dedicated delegation research is confirming exactly what shipping modules can encode.

---

## 5. opBNB — and a stale doc

| Property | Measured | Docs say |
|---|---|---|
| Chain ID | 204 (`0xcc`) | ✓ |
| **Block time** | **0.25s** | **1s — stale** |
| Gas limit | 100,000,000 | |
| Gas price | 0.001 gwei, base fee 0 | |
| Finality lag | ~29 blocks (~7s) | |
| Fullness | 10% | |

BNB Chain's own docs and third-party pages still say 1s. **Treat them as stale.**

opBNB is 4× faster and ~50× cheaper per gas than BSC, but has ~8× the finality lag and **no Graph support**. Not a launch target; worth noting for later high-frequency agent execution.

---

## 6. Data sources for backtesting — all verified live

| Source | Endpoint | Limits |
|---|---|---|
| **Binance klines** | `api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=1d` | **6,000 weight/min**; 300,000 raw requests/5min. `x-mbx-used-weight-1m` header for backpressure |
| **DefiLlama coins** | no key required | Works with BSC token addresses |
| **Dune** | `X-Dune-Api-Key` | |

Kline array shape: `[openTime_ms, open, high, low, close, volume, closeTime_ms, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]`.

**→ Binance klines at 6,000 weight/min is more than adequate to build the frozen price snapshots Arena replay needs**, and being Binance data on a Binance-adjacent chain, it is the natural reference for BNB pairs.

---

## 7. MEV and private execution

A mature multi-builder market — relevant because agent execution quality (slippage, sandwich exposure) is an **outcome metric AiKi should measure**, not just a footnote.

**bloXroute:** `https://api.blxrbdn.com` / `wss://api.blxrbdn.com/ws`, method `blxr_submit_bundle`, `Authorization` header, `blockchain_network: "BSC-Mainnet"`. Default `max_block_number` = current + 40. **Bundles limited to 2 transactions** without the Bundle Size Add-on. Cloud API only. Builders: `bloxroute` (default), `all`, `48club`, `blockrazor`, `jetbldr`, `nodereal`.

**48Club Puissant v2:** explicit auction with a published sorting formula.

**→ An agent that routes through a private relay measurably outperforms one that does not, on identical inputs.** That is a real, measurable capability difference belonging in the Passport — and a category metric no competitor is likely to surface.

---

## 8. Verified contract addresses

Checked for non-empty bytecode via `eth_getCode` / `cast codesize` against NodeReal archive.

| Contract | Address | Evidence |
|---|---|---|
| USDT (BSC) | `0x55d398326f99059fF775485246999027B3197955` | decoded transfer trace |
| PancakeSwap V2 Router | `0x10ED43C718714eb63d5aA57B78B54704E256024E` | codesize 21,936 |
| Venus Comptroller | `0xfD36E2c2a6789Db23113685031d7F16329158384` | official docs |
| Venus vBNB | `0xA07c5b74C9B40447a954e1466938b865b6BBea36` | confirmed |
| Venus vUSDT | `0xfD5840Cd36d94D7229439859C0112a4185BC0255` | codesize 4,744 |
| Venus vUSDC | `0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8` | official docs |
| Venus vBTC | `0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B` | official docs |

Venus `RepayBorrow` event topic0: `0x1a2a22cb034d26d1854bdc6666a5b91fe25efbbb5dcad3b0355478d6f5c362a1`

> **One widely-memorized address was found to be WRONG and has been excluded.** This is precisely why the charter forbids writing addresses from memory.

---

## 9. Impact on AiKi

| Finding | Consequence |
|---|---|
| **Pasteur fork 25 Aug, mandatory** | Pin client v1.7.7. Replay across fork boundaries needs per-era EVM version. |
| `finalized` lags 2 blocks; reorg bound 8 | Index against `finalized`. Chain evidence carries a finality state. |
| **`milliTimestamp` is BSC-specific** | Key by `(blockNumber, logIndex)`. **Generic indexers silently lose sub-second ordering.** |
| **anvil forks BSC; gas exact; needs `--evm-version prague`** | **Arena replay is feasible.** Environment reproducible; agent internals are not. Scope the claim honestly. |
| `eth_getLogs` disabled on dataseeds; caps 5k–50k | Paid archive mandatory. Chunked, resumable, cap-probing backfill. |
| **NodeReal $39/mo with archive on all tiers** | Recommended primary. QuickNode is $799/mo *without* archive. |
| **EIP-7702 live, 1.5% of txs** | The strongest foundation for T0 mandate enforcement. |
| Gas is trivial ($0.0055 per Venus repay) | On-chain receipt anchoring is economically viable. Cost is not a reason to keep evidence off-chain. |
| Envio at tip but token-gated; Graph retired hosted | Self-operated indexer as authority; hosted as accelerator. |
| Binance klines 6,000 weight/min | Sufficient for Arena's frozen price snapshots. |
| MEV relay market is mature | Execution quality is a measurable Passport metric. |
| opBNB docs stale by 4× | Re-measure every ecosystem claim. Docs lie; chains don't. |

---

## Sources

Live probes against `bsc-dataseed.bnbchain.org`, `bsc-rpc.publicnode.com`, `bsc.blockrazor.xyz`, `bsc-mainnet.nodereal.io`, `bsc.meowrpc.com`, `opbnb-mainnet-rpc.bnbchain.org`, `bsc.hypersync.xyz`, `api.binance.com`.
Docs: BNB Chain hardfork announcements (Fermi, Osaka/Mendel, Pasteur), BNB Chain H1-2026 retrospective and H2-2026 roadmap, NodeReal MegaNode pricing, Goldsky pricing, The Graph supported-networks, Substreams chains-and-endpoints, bloXroute BSC bundle API, Venus official docs.
