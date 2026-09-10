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
- [ ] Public setup API, durable planner scheduling and owner-facing policy compilation.
- [ ] Deployment tooling, published reviewed configuration and ABI drift checks.
- [ ] Current-design activation and wallet handoff controls.
- [x] Full application tests plus configured strategy mainnet-fork interactions. No real-money transactions for automated tests.
- [ ] Review deployment artifacts, publish verified configuration, complete user-signed funded journeys before claiming live execution.

## Verification requirements

Cover foreign callers/recipients/targets, mutable account ownership, reentrancy, token false returns, failed approvals, expired/stale plans, replay, loss budgets and cleanup. Verify full rollback at each external failure. Cover both yield directions and idle exits; grid crossing/partial-fill/restart cases; LP zero-swap/both-swap directions and replacement custody. Database tests use isolated local schemas and concurrent connections. Fork tests use local funding only. Existing Guardian and billing regressions must remain green.

## Implementation checkpoint: 10 September 2026

The new strategy execution core exists locally. It is not connected to public setup routes or a running scheduler, and the new contracts are not deployed. Existing Guardian deployments and production configuration are unchanged. No funds moved during this implementation or its tests.

Verification at this checkpoint:

- API: 1,621 tests passed with all migrations applied to a fresh local PostgreSQL database.
- Web: 177 tests passed. MCP: 46 passed. SDK: 1 passed.
- All five workspace typechecks passed. Scoped TypeScript formatting/lint checks passed without warnings.
- Strategy Solidity suite: 152 passed, zero failed/skipped with `BSC_FORK_BLOCK=121004566` and the public BSC Alchemy RPC. These are local fork interactions, not broadcast transactions.
- Full default Solidity suite: 227 passed, five optional strategy fork suites skipped, one pre-existing real-manager fork setup failed because its configured public RPC returned HTTP 429. Do not describe that broader default run as fully green.

Admission binds the exact stored signed permission, reviewed enforcer terms, immutable vault policy, full manager simulation and a per-operation gas ceiling. Database locks prevent competing legacy/strategy claims. The last pre-broadcast persistence checkpoint rechecks owner pause, authorization validity, job state, snapshot freshness and permission identity. A stop after that checkpoint cannot cancel an already admitted transaction; on-chain owner pause/revocation remains a separate action.

Receipt settlement preserves nonce and canonical block/hash watermarks, so a still-recent pre-transaction snapshot cannot roll state back. A reverted transaction does not invent a new vault nonce. Recovery checks only the stored transaction hash, never resends, follows replacements, refunds limits or automatically restarts a watch.

Remaining integration must preserve these boundaries. Planner observations need durable compare-and-swap persistence; scheduling must require a newly verified full snapshot after every outcome; deployment must publish actual reviewed addresses/code hashes rather than test fixtures. The full funded Guardian and three new strategy journeys still need explicit customer wallet confirmations and real-browser verification before any live-execution claim.

Read-only funding check: the deployment wallet held `0.0070361189 BNB`. At the observed `0.05 gwei` quote, the binding enforcer, yield factory and LP factory deployment estimates totalled `0.00040132065 BNB`. This is a subtotal, not a total launch budget or funds reservation. Grid deployment, customer vaults, ongoing gas and strategy principal remain separate. No additional funding was requested at this checkpoint.

## Primary references

- [Venus current and legacy markets](https://docs-v4.venus.io/deployed-contracts/markets)
- [Aave BNB address book](https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3BNB.sol)
- [Aave V3 Pool operations](https://aave.com/docs/aave-v3/smart-contracts/pool)
- [Pancake V3 addresses](https://developer.pancakeswap.finance/contracts/v3/addresses)
- [Pancake position manager](https://developer.pancakeswap.finance/contracts/v3/nonfungiblepositionmanager)
- [Pancake router interface](https://raw.githubusercontent.com/pancakeswap/pancake-v3-contracts/main/projects/v3-periphery/contracts/interfaces/ISwapRouter.sol)
- [Pancake oracle library](https://raw.githubusercontent.com/pancakeswap/pancake-v3-contracts/main/projects/v3-periphery/contracts/libraries/OracleLibrary.sol)
