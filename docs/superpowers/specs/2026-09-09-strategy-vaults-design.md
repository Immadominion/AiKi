# Strategy vaults: approved design and implementation plan

Approved by the user in the conversation following the linked research checkpoint on 9 September 2026. The user explicitly requested implementation without another approval round. Preserve the deployed Guardian account/manager, current UI and all unrelated work.

## Outcome

Implement real, separately funded, non-upgradeable strategy vaults for same-USDT yield allocation, fixed-pool spot grid trading and one-position Pancake V3 liquidity rebalancing. Reports remain distinct from financial actions. Never advertise execution based on a report, transaction simulation or unverified deployment.

## Ownership and authority

Each vault has an immutable AiKi mandate-account controller and policy hash. The current on-chain owner of that account can pause and recover assets directly, independently of the API. The controller can invoke only the strategy operation. A delegated operation does not acquire owner funding, withdrawal, recovery or policy-editing powers. New vaults do not alter existing account bytecode, mandates or the deployment manifest.

Policies are immutable. Owner funding is explicit, and unsolicited transfers never raise authorized principal. Owner state changes invalidate prepared operations with a nonce. Expiry and pause block automation but not owner recovery. Every operation binds its nonce, policy hash and a short deadline. Reentrancy protection surrounds external token/protocol calls. No arbitrary call targets, delegatecall, borrowing, leverage, native-value routing or token-spender selection.

## Shared contract boundary

`StrategyVaultBase` provides the controller and policy hash, owner lookup, pause/resume, expiry, cooldown, bounded deadlines, operation nonce and standard completion event. Concrete vaults enforce their asset accounting. `StrategyToken` performs checked optional-return token operations and exact temporary approvals. A mandatory strategy binding enforcer checks the vault/controller/policy/selector binding; existing scalar ERC-20 cap caveats are not repurposed as portfolio protection.

Off-chain policy views distinguish allocated principal, turnover and measured execution loss. Money moving between two yield venues is not a marketplace payment. Different tokens are never summed as raw units. The chain, not an agent-supplied minimum, enforces the mandatory economic limits.

## Yield

One underlying: canonical BSC USDT. The vault holds idle USDT, Venus Core vUSDT and Aave V3 BNB aUSDT. Fixed internal venue handlers atomically redeem and supply; intentional withdrawal to idle is supported. Reject nonzero Venus error returns and verify actual token/receipt changes. Aave beneficiary/withdrawal destinations are the vault. Never borrow or swap.

Policy bounds allocated capital, per-move amount, turnover, venue exposure, idle reserve and same-underlying execution loss. Portfolio accounting accrues Venus exchange rates and handles Aave indexed receipts. Owner recovery can return receipts when upstream liquidity prevents redemption. These controls do not guarantee protocol solvency or future yield.

The planner compares both eligible venues and idle using a single fresh block snapshot, normalized rates, post-allocation effects, gas, horizon, cooldown and hysteresis. Exclude Venus legacy/exit-only pools. Missing flags, stale snapshots, unsupported rate clocks or inconsistent protocol identity stop new allocations.

## Grid

One fixed reviewed Pancake V3 pool, two reviewed ERC-20 tokens, exact-input swaps and an immutable grid. Separate per-rung inventory/cycle state prevents repeated crossing execution. Activation observes rather than trading historical crossings. Require qualifying crossings, hysteresis and opposite-side rearming. No automatic range changes, borrowing or multihop routing.

Pin the original V3 router, token pair, fee, recipient, meaningful output minimum, price bound, maximum input and short deadline. Verify retained TWAP history and spot deviation. Account for actual fills, including partial input at a price limit. Owner withdrawals invalidate pending plans; unexpected extra tokens do not expand allocation.

## Liquidity rebalancing

One unstaked Pancake V3 NFT in one reviewed pool. The owner explicitly enrolls that NFT, never grants blanket NFT authority to the executor. The vault retains replacement NFTs and residual tokens.

One reverting operation validates NFT/nonce/policy, decreases liquidity, collects, optionally swaps within the same pool, mints replacement liquidity, checks custody/inventory and emits the transition. Simulate the entire operation because removing the original liquidity affects the swap. Bound tick-aligned range, cooldown, oracle deviation, burn/mint amounts, deployed-capital ratio, swap amount/output, deadlines and cumulative execution loss. Fee income must not hide swap loss. This is not insurance against market movement or impermanent loss.

Watch identity is vault plus policy hash, not the original NFT ID. No MasterChef/Infinity positions, arbitrary tokens/routes, native BNB or fee-on-transfer/rebasing assets.

## Service and recovery

Use typed, discriminated strategy snapshots, policies, plans and finalized outcomes. New scheduling is separate from the Venus watch schema and paid Fast turns. Reuse durable chain/signer locks, pre-broadcast exact transaction hashes, canonical finalized receipts and no replacement-following.

A strategy completion requires its expected vault event, nonce, policy hash and asset/position outcome, not only a successful transaction status. Persist terminal attempt, verified strategy transition, inventory/cursor and reservations atomically in normal settlement and recovery. Unknown outcomes remain locked; they do not refund limits, repeat trades or restart watches automatically.

## UI and activation

Preserve report hiring and existing design. Add explicit strategy review, deployment/configuration verification, owner funding, mandate signing, readiness and start/stop/recovery steps. Show chain 56, exact assets and policy, and clear waiting/error states. Declined wallet requests do not create fake completion. The user performs financial confirmations. Activation remains unavailable if any deployed code, funding, allowance, custody, signature or scheduler readiness check fails.

## Implementation checklist

- [x] Inspect existing code, live protocol documentation and candidate markets.
- [x] Compare account migration with dedicated vaults; user approves dedicated vaults.
- [x] Document and self-review the approved design. Visual companion is unnecessary for this contract boundary.
- [x] Shared contract safeguards and binding enforcer, with adversarial tests.
- [x] Yield vault and both real venue operations, planner and tests.
- [x] Grid vault, oracle/fill/rung accounting, planner and tests.
- [x] LP vault, atomic replacement/inventory/loss accounting, planner and tests.
- [x] Shared vault ABIs, typed operations and same-block factory/account/vault/enforcer verification.
- [x] Durable strategy persistence, exact grant/simulation admission, canonical outcome validation and read-only recovery.
- [x] Public owner-scoped setup API, durable planner scheduling and owner-facing policy compilation, with local regression coverage.
- [x] Unsigned deployment tooling, compiled-runtime verification and artifact/ABI drift checks.
- [x] Current-design activation, explicit wallet handoffs, pending-transaction recovery and visible scheduler activity.
- [x] Read-only Fast discovery and owner status, with navigation restricted to the exact configured first-party identity.
- [x] Record baseline application tests and configured protocol-fork interactions. Automated tests use local funds only.
- [x] Complete the full-workspace test/build pass after the latest integration changes; run the opt-in local fork journey separately.
- [x] Verify a real Yield move through durable settlement, plus a full Grid fill and LP runner rebalance with immediate fresh-pass no-replay checks.
- [ ] Extend the full runner journey to automatic Yield economic selection using fresh, unchanged oracle data. Separate exact-move and contract coverage do not replace this integration check.
- [ ] Deploy the new binding enforcer and three factories, verify finalized receipts and code, and publish actual reviewed configuration to API and worker.
- [ ] Complete native-browser Fast navigation and user-signed funded strategy journeys before claiming live execution.

## Verification requirements

Cover foreign callers/recipients/targets, mutable account ownership, reentrancy, token false returns, failed approvals, expired/stale plans, replay, loss budgets and cleanup. Verify full rollback at each external failure. Cover both yield directions and idle exits; grid crossing/partial-fill/restart cases; LP zero-swap/both-swap directions and replacement custody. Database tests use isolated local schemas and concurrent connections. Fork tests use local funding only. Existing Guardian and billing regressions must remain green.

## Implementation checkpoint: 10 September 2026

The execution core at `af41a9f` and setup/scheduler integration at `fb0a834` are pushed to main. BSC fee preparation and Fast reservation copy were corrected in `90788a4`; header clearance and inline strategy gas validation followed in `1855936`. All integration and repair releases are live on Vercel and Railway API, worker and web. Public setup routes are wired into the API. The scheduler has a separate bounded strategy loop, durable planning leases and observation checkpoints. The website exposes the three setup pages and owner activity; Fast can read verified configuration and navigate to those pages. The new binding enforcer and factories have not been published as reviewed mainnet deployments, and both production services still lack `STRATEGY_DEPLOYMENT_CONFIG`. Existing Guardian contracts are not replaced. No real-money transaction was performed by these automated tests.

Setup persists unsigned owner drafts without creating an authorization or job. Each deployment, exact approval, funding/enrollment and owner pause/resume/recovery transaction is a separate reviewed wallet step. Signing registers the verified authorization, job and paused watch atomically; it does not start automation. Start separately checks the current owner, immutable policy, funded and enabled vault, exact permission, executor gas, pending actions and a fresh heartbeat for the same configuration digest. Service pause is distinct from an on-chain owner pause or revocation.

Readiness now also binds that deployment digest to the actual executor and chain56 through a versioned, domain-separated hash. The heartbeat table stores this readiness identity in `configuration_hash`; public `configurationHash` remains unchanged. API and worker using different executor wallets can no longer advertise a usable scheduler or activate a watch that the worker would immediately stop. Legacy unbound heartbeats fail closed without a migration. Recovery-only unavailable heartbeats and existing stop semantics remain unchanged.

The canonical setup grant contains the existing mainnet expiry enforcer first and the new strategy binding enforcer second. Its expiry equals the reviewed vault expiry. Admission binds the exact stored signed permission, immutable vault policy, full manager simulation and a per-operation gas ceiling. Database locks prevent competing legacy/strategy claims. The last pre-broadcast persistence checkpoint rechecks owner pause, authorization validity, job state, snapshot freshness and permission identity. A stop after that checkpoint cannot cancel an already admitted transaction; on-chain owner pause/revocation remains a separate action.

Planner observations now use durable compare-and-swap updates bound to a still-owned lease and snapshot revision. Every scheduled pass reads and verifies a complete fresh snapshot and current mandate before planning. Receipt settlement preserves nonce and canonical block/hash watermarks, so a still-recent pre-transaction snapshot cannot roll state back. A reverted transaction does not invent a new vault nonce. Recovery checks only the stored transaction hash, never resends, follows replacements, refunds limits or automatically restarts a watch.

Verification evidence is scoped, not a final release result:

- The latest tracked API run, including the BSC transaction-fee fix, accurate Fast reservation messages and executor-bound readiness, passed 1,935 tests against local PostgreSQL; three opt-in local fork tests were skipped in that run and are accounted for separately below. The latest web run passed 215 tests, MCP passed 46 and SDK passed one. All five workspace typechecks and repository lint passed. The isolated production web build generated 38 static pages and the dynamic strategy route.
- The latest reported full Solidity run passed 264 tests in 25 suites with no failures or skips. The legacy real-manager fork used block `118000000`; strategy forks used `121004566`. An earlier default run had five optional skips and a public-RPC HTTP 429 failure; the later configured run supersedes that failure, not the need for reproducible RPC access.
- The latest deployment/artifact suite passed 74 tests. Actual Fastify setup route coverage passed 38 tests, including authenticated owner isolation and JSON-null bodyless actions. Focused setup, planner, execution, recovery and PostgreSQL concurrency tests are recorded separately; their overlapping counts are not summed here.
- Local and public production HTTP checks returned 200 for all three strategy routes. Browser checks covered responsive layouts, keyboard focus, input preservation and pending-receipt controls. Wallet/API calls in the component browser checks were mocked. Native Chrome verified the signed-in production setup page, unavailable configuration notice and blocked financial controls. A Fast availability request was correctly stopped before tools or charges because its 644-point reserve exceeded the owner's 525-point balance. No successful native Fast strategy-link click or customer-wallet funded journey is claimed.
- The extended local service journey passed three tests at BSC fork block `121004566`, hash `0x6acee84239c85de59079b7294a01251752e0c75a4a46f00bc1cdfc382366966d`, using public Anvil accounts, local funds and an isolated PostgreSQL schema. All three exercised owner deployment and finalized readback. Yield approved/funded/signed/started, executed a real 10 USDT idle-to-Venus move through the unchanged mainnet manager, settled the exact finalized receipt atomically and rejected its pre-transaction snapshot. Grid ran the full baseline, then a real bounded local pool swap crossed its sell trigger. Its runner sold exactly 1 USDT and settled actual WBNB inventory and turnover. LP minted, approved and enrolled an actual fork NFT, then its full runner rebalanced to the approved narrower range with correct replacement custody, loss accounting and cleared allowances. Both runner paths settled finalized transactions and did not replay on the immediate next pass; LP may be in cooldown, so a later healthy-position decision is not claimed.
- The Fast header passed isolated component browser checks at 375, 768 and 1280 pixels in panel and fullscreen layouts, including control clearance, keyboard focus, history dismissal and draft preservation. Native signed-in Chrome then confirmed live panel and fullscreen header clearance and opened the real wallet-scoped history. Inline strategy gas validation exposes the existing 0.001 BNB ceiling in all three forms without changing the backend limit. Native visual checks and mocked component checks are distinct from the remaining funded wallet journey.

The journey calls the real setup service directly, not the HTTP authentication boundary or deployed worker process loop. Yield supplies an exact verified move rather than testing automatic economic candidate selection; historical oracle timestamps are not rewritten. Earlier archive failures and an Anvil parallel-read deadlock interrupted retries; serializing only the local fixture's RPC transport preserves the exact reads. The fixture maintains an actual local base fee of 0.05 gwei and verifies signed maximum gas cost and receipt cost against the unchanged 0.001 BNB owner ceiling. The successful run exposed and fixed viem returning ambiguous mixed fee fields: BSC transaction preparation now explicitly selects legacy fees, while the gas ceiling and ambiguity rejection remain enforced. No private production key was used and no fork transaction reached mainnet. The CI workflow now includes these opt-in local journeys, real migrations, pinned Foundry and artifact build order. It remains manual-only under the existing billing decision; no GitHub Actions execution is claimed.

Remaining deployment work must publish actual reviewed addresses/code hashes, never test fixtures. Production migrations `031`, `032` and `033` were applied and their checksums verified before publishing `fb0a834`; the previous 30 migration checksums also matched. All ten live points-ledger checks passed again after the native Fast checks and `90788a4` deployment. A fresh read-only runtime check found a chain56 heartbeat correctly marked unavailable, with no strategy watches. Confirm a ready heartbeat for the same configuration digest after reviewed contract configuration and gas funding. The full funded Guardian and three new strategy journeys still need explicit customer wallet confirmations and real-browser verification before any live-execution claim. The contracts remain unaudited; local tests do not establish protocol solvency or profitable operation.

A fresh read-only mainnet preflight at finalized block `121060855` estimated all four infrastructure creations at 11,182,197 gas, or `0.00055910985 BNB` at `0.05 gwei`. The deployment wallet held `0.0070361189 BNB`; the separate executor, account funder and customer wallet held zero BNB. No transfer or contract creation was submitted. This is a dated estimate, not reserved funds or a complete launch budget: customer vaults, ongoing gas and strategy principal are separate. The unsigned infrastructure CLI prints exact reviewed creation requests for wallet review without loading a key or sending them.

## Primary references

- [Venus current and legacy markets](https://docs-v4.venus.io/deployed-contracts/markets)
- [Aave BNB address book](https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3BNB.sol)
- [Aave V3 Pool operations](https://aave.com/docs/aave-v3/smart-contracts/pool)
- [Pancake V3 addresses](https://developer.pancakeswap.finance/contracts/v3/addresses)
- [Pancake position manager](https://developer.pancakeswap.finance/contracts/v3/nonfungiblepositionmanager)
- [Pancake router interface](https://raw.githubusercontent.com/pancakeswap/pancake-v3-contracts/main/projects/v3-periphery/contracts/interfaces/ISwapRouter.sol)
- [Pancake oracle library](https://raw.githubusercontent.com/pancakeswap/pancake-v3-contracts/main/projects/v3-periphery/contracts/libraries/OracleLibrary.sol)
