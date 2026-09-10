# Mainnet execution and agent supply

Mainnet cutover observations are dated 9 September 2026. The strategy implementation checkpoint below was updated on 10 September 2026. This is an engineering handoff, not a claim that all trading features are live.

## Product requirement

AiKi must let someone find and activate real BSC agents in four equally developed categories: liquidity rebalancing, grid trading, yield optimisation and lending-health monitoring. Category labels, registrations and reports alone do not satisfy automated execution. See the [official event requirements](https://www.bnbchain.org/en/hackathons/smart-money-era).

## Current gap

All four first-party agent identities exist on BSC mainnet. Venus #315943 supports in-app one-time report hiring. Rebalancer #315944, Grid #315945 and Yield #315946 now implement the same `aiki.task/v1` hiring protocol, with explicit input hints and real on-chain report results. Those three report endpoints do not trade, rebalance liquidity or move deposits.

Separate yield, grid and LP vault execution, owner setup and scheduler integration are pushed to main in `fb0a834`. BSC transaction preparation and Fast reservation messages were corrected in `90788a4`; header clearance and inline strategy gas validation followed in `1855936`. All three releases reached Vercel and Railway API, worker and web. They do not turn the paid report endpoints into trading endpoints. The new strategy infrastructure still requires reviewed mainnet deployment and configuration before its public setup can become available.

The previous production executor used the pinned chain97 mandate suite. A direct mainnet `eth_getCode` check returned no code at its configured manager and registry addresses. Do not reuse those addresses as a mainnet deployment or substitute MetaMask's manager: its delegation tuple differs from AiKi's, including AiKi's extra epoch field.

## Network-aware execution

The API and scheduled runner now share `config/execution-network.ts`. It selects the mandate deployment, account deployment, signature-verification RPC and runner network together. Watch inputs use the actual mandate account's chain and corresponding Venus market.

- Existing installs remain on their existing chain97 configuration during migration.
- `AIKI_EXECUTION_CHAIN_ID=56` requires `AIKI_ENFORCER_DEPLOYMENT_FILE`, pointing to a reviewed mainnet deployment JSON. There is no fallback to testnet when this file is absent or invalid.
- The file uses `EnforcerDeployment`: chain56, mainnet, truthful audited status, manager and registry addresses and runtime code hashes, plus all six distinct named enforcers and their runtime hashes.
- API startup and each runner process verify the RPC chain, runtime hashes and registry mappings before accepting that deployment. Mainnet checks also verify the manager's expiry enforcer and each stateful contract's manager binding.
- `RUNNER_RPC_URL`, then `ENFORCER_RPC_URL`, then `BSC_RPC_URL` select the mainnet RPC. They must all refer to the intended deployment network when configured.
- Account, delegation and watch networks must agree. The watched account must be the signed delegator. The selected Venus market must contain debt for that account and its underlying token must match the repayment asset.
- Existing watches are checked again before dispatch. A cross-network watch, mismatched account or mismatched repayment token never reaches execution.
- The executor's address is derived from its private key. A configured session address must match it, and each saved mandate must name that executor. API and scheduler identities were checked in production and agree.
- Before activation and each pass, the account must bind the selected manager, its owner must match the saved authorization, and ERC-1271 must accept the signature for the current manager's EIP-712 domain. Changed caveats, expired mandates, on-chain revocations and bumped epochs are rejected. Temporary verification failures do not submit an action or discard the user's watch.
- The watch panel distinguishes an absent watch from a failed request. Wallet changes discard stale responses; a failed refresh retains the stop control and labels the last known state. A stopped watch does not offer a restart the API cannot perform.

The mainnet suite was deployed on 9 September 2026. All eight creation receipts are successful and finalized, all compiled runtime bytes and constructor immutables match, and Sourcify verified every contract. The [deployment record](../onchain/DEPLOYMENT-BSC-56.md) links transactions and the production manifest. Mainnet account funding/allowances, wallet activation and a completed strategy remain distinct checks. The contracts are unaudited; passing tests is not an independent audit.

`onchain/script/Deploy.s.sol` now requires `EXPECTED_CHAIN_ID` and rejects a mismatched RPC before reading a signing key. Simulate and review the deployment first. A successful simulation must not be recorded as a broadcast or a deployed mainnet address.

A local chain56 fork simulation preceded the actual deployment. It estimated 0.00038138645 BNB at 0.05 gwei; the actual eight creations cost 0.0002933743 BNB. Only deployment gas was spent. The wallet was recovered from the existing Git-ignored, owner-only deployment environment file. The server's executor and account-funding keys remain separate operational roles.

Points purchases are configured separately from execution. Changing the executor network does not move billing or historical balances. Production API and worker were switched to the reviewed chain56 deployment in release `34bb0a7`. New points purchases now use mainnet USDT; the old testnet rail remains an explicitly separate reconciliation input. Railway API, worker and web, and Vercel all deployed the same commit successfully. Public execution metadata reports56 and all ten production ledger checks pass.

## Fast mode and MCP execution inputs

The public, uncached `/v1/execution/network` endpoint exposes the API's selected execution configuration and canonical Venus token, market and decimals. It does not promise account deployment, available funds, a valid signature or an operating runner. Missing or inconsistent configuration is unavailable, never implicitly testnet.

Fast mode's Guardian preview, mandate and watch actions fetch this configuration rather than accepting a network from the model, registry or payment rail. Shared `@aiki/contracts` helpers build exact USDT caps. Invalid amounts, a per-action cap above the total, unsupported decimals and invalid expiry are rejected before account deployment. Failed account reads or deployments and mismatched account chains stop the operation before an authorization or watch is created.

The local MCP integration uses the same helpers. It binds sign-in to the current execution chain and checks the account and prepared delegation's chain, manager and delegator before signing. Wallet balance labels follow the actual checked RPC network. A saved watch's remaining allowance uses its own stored chain's decimals, not the latest deployment configuration. Failed watch-status requests are not presented as evidence that no watch exists. The website's existing watch controls also use the shared canonical market definition.

Fast now persists a server-created signing continuation with the saved conversation. Review and sign rechecks the current owner, account, network, stored limits and six on-chain enforcers. A wallet signature requires an explicit click and files only that existing authorization; it does not create a job, start a watch, move funds or spend another Fast turn. Declined, expired, revoked and uncertain requests retain explicit recovery states. A lost filing response is checked against the same authorization before another signature is offered.

The verified Guardian registration now offers automatic repayment setup separately from report hiring. Its builder uses runtime network metadata, canonical Venus repayment scope and a lifetime cap. Stored limits, account and wallet identity are checked around EIP-712 signing; watch activation still requires the normal account readiness checks. Other registrations never inherit Guardian authority from a matching name or category.

Manual setup persists an owner/network-scoped operation key before any deployment or authorization request. Authorization creation is idempotent per wallet and key, with changed terms rejected and signatures, revocation and spent limits preserved on replay. Retries retain the original absolute expiry and authorization and reuse the job key after an uncertain response. Unavailable browser storage fails closed. A pending setup must currently resume with its original limits; automatic cancellation and replacement are not implemented.

These Guardian repairs do not add a hosted MCP transport or fund mandate accounts. The separate strategy workflow below is not an extension of Guardian's scalar repayment mandate. Neither implementation establishes that a real lending position was funded, approved and protected through the public wallet journey. That remains a release gate.

## Strategy setup and scheduler: implementation and release checkpoint

The approved [strategy vault plan](superpowers/specs/2026-09-09-strategy-vaults-design.md) distinguishes implemented code, local test evidence and deployment gates. The new contracts have not been published as reviewed mainnet deployments at this checkpoint. Never copy fork addresses or mock runtime hashes into production configuration.

`STRATEGY_DEPLOYMENT_CONFIG` is server-owned JSON, not a filename. It pins the existing reviewed chain56 manager/account runtime, new binding enforcer and three factories, canonical protocol code, proxy implementations and pool identities. Missing or invalid configuration makes public `GET /v1/strategies/config` report unavailable without invented factory addresses. Configuration availability is not owner readiness or proof that an operation has run. API and scheduler must receive the same reviewed configuration digest.

The unsigned-only `strategies/deployment-cli.ts` supports `infrastructure`, `prepare`, `finalize` and `verify-config`. From `apps/api`, `pnpm exec tsx src/strategies/deployment-cli.ts infrastructure --owner OWNER_ADDRESS --rpc HTTPS_RPC_URL` prints the four reviewed CREATE requests for owner review. It does not load a key, guess a deployed address, sign, send, write configuration or create a user's mandate account. Review each eventual finalized receipt, runtime and constructor binding, then use `verify-config` with the actual reviewed JSON before publishing it. Passing a simulation is not deployment evidence.

Apply additive migrations `031_strategy_operations.sql`, `032_strategy_setups.sql` and `033_strategy_runner.sql` before the matching API and worker serve strategies. The scheduler launches the separate `strategies/runner-cli.ts` loop. `STRATEGY_RUN_INTERVAL_MS` defaults to 15,000 and is bounded to 5,000 through 60,000; `STRATEGY_RUNNER_LIMIT` defaults to five and is bounded to one through twenty per pass. Readiness requires verified deployments, the configured executor and gas, and a ready heartbeat no older than 120 seconds for the exact configuration digest. An unavailable or unconfigured worker cannot advertise new execution as ready. Recovery inspects only existing persisted transaction hashes, without replacing them or restarting stopped watches.

Readiness also binds the worker's executor to the API's executor. The heartbeat table's existing `configuration_hash` now contains `strategyRunnerReadinessDigest(deploymentDigest, executor)`, a domain-separated hash including chain56 and the canonical address. It is not the public `configurationHash`, which remains the deployment digest. Compare through `schedulerStatus` or the readiness helper, not direct equality with public configuration. An older unbound heartbeat, different executor, stale heartbeat or unavailable recovery-only worker cannot enable Start. No new migration is required; rolling deployment stays unavailable until both services agree. The worker needs at least 0.0001 BNB for baseline readiness; each owner's Start separately requires enough executor gas for that setup's full selected ceiling.

Owner setup is deliberately separate from report hiring:

1. Sign in with the current owner and use an existing verified mandate account or its explicit account-deployment step.
2. Prepare and review an immutable policy. Send the reviewed factory deployment from the owner's wallet and reconcile that same hash.
3. Review one exact approval/reset, funding or NFT enrollment transaction per click. Funding does not enable automation. An uncertain wallet send remains unresolved until its original hash can be checked; do not send it again to clear the interface.
4. Review and sign the exact ordered expiry-plus-strategy-binding grant. Signing atomically records the authorization, job and paused watch, not a running strategy.
5. Explicitly enable the vault on chain and then start the service. Start rereads current owner, permission, vault state, pending actions, funding, executor gas and scheduler readiness. Service pause and owner on-chain pause/revocation are separate controls.

Planner observations are durable and compare-and-swap protected. Fresh complete custody and mandate checks precede each pass. `ACTIVE` is a recorded service state, not proof of a trade, profit or uninterrupted future service. The setup page exposes the latest decision and next check; its completed transaction link comes only from a verified finalized attempt. A receipt watermark is not reused as a complete post-operation snapshot.

Fast has four read-only strategy tools: configuration, safe setup navigation, owner list and owner status. A navigation link is allowed only for the exact configured registry identity with a current live reciprocal passport. It opens `/strategy/yield`, `/strategy/grid` or `/strategy/lp`; it cannot prepare, approve, fund, sign or start anything. Unavailable deployments remain labelled unavailable. The MCP integration has not gained these new strategy tools in this batch.

Evidence available on 10 September: the full tracked API suite, including explicit BSC legacy-fee preparation, accurate Fast reservation messages and executor-bound readiness, passed 1,935 tests with three opt-in fork tests skipped; the latest web run passed 215, MCP passed 46 and SDK passed one. All five workspace typechecks, repository lint and the production web build passed. The configured full Solidity run passed 264 tests with no failures or skips. Deployment/artifact checks passed 74 and actual setup route checks passed 38; those overlap the API suite and are not added to its count. Production migrations `031` through `033` are applied with verified checksums. All ten live points-ledger checks passed again after the production Fast checks and transaction-fee release. Strategy configuration is still absent; a fresh worker heartbeat correctly reports unavailable and no strategy watches exist.

The extended three-test local Anvil journey at BSC block `121004566` passed using public fixture keys, local funds and the unchanged real manager. All three owner deployments finalized. Yield funded, signed, started and actually moved 10 USDT into Venus through the durable execution path; exact receipt settlement updated PostgreSQL atomically and rejected the previous snapshot. Grid established its baseline, observed a real bounded local pool swap across its trigger, sold exactly 1 USDT and settled the resulting WBNB inventory and turnover. LP minted, approved and enrolled a real fork NFT, then ran its planner and manager execution to replace the position with the approved narrower range. Both full runner paths settled finalized transactions and did not replay on the immediate next pass. The LP next pass may be in cooldown; it does not prove a later healthy-position decision.

The journey calls setup services, not HTTP authentication or the deployed worker process. Yield supplies an exact verified move rather than testing automatic economic selection. Anvil historical reads are serialized only in this local fixture. The fixture maintains an actual local base fee of 0.05 gwei and checks both signed maximum gas cost and receipt cost against the unchanged 0.001 BNB owner ceiling. No oracle timestamp, protocol guard or production gas cap is weakened. The maintained CI workflow runs these opt-in tests on loopback nodes with public test keys; it remains manual-only under the existing GitHub billing decision. A successful local run is not a claimed GitHub Actions run.

Native Chrome verified the signed-in production setup page and its unavailable-state financial controls. A Fast availability request was blocked before tools or charges: 644 points were required and 525 were available. It did not produce a successful setup navigation. The corrected refusal quotes the confirmed post-refund balance and removes misleading shortening advice. A request above the 2,000-point per-turn cap never recommends adding funds to bypass that cap. Pricing and reservation behavior are unchanged. Component browser checks use mocked API/wallet calls; funded customer-wallet journeys remain release gates.

The Fast header now reserves clearance for fullscreen controls while preserving the draft, history focus and existing design. Isolated component browser checks passed at 375, 768 and 1280 pixels in panel and fullscreen layouts. Native signed-in Chrome then confirmed the live header clearance in panel and fullscreen layouts, and opened the real wallet-scoped conversation history. The three strategy forms expose the existing 0.001 BNB maximum beside the gas field and reject a larger value inline before submission. These checks do not constitute a funded native-wallet journey.

## Mainnet points purchases

`config/credits-network.ts` is shared by the production API, development API and ledger reconciliation command. A missing treasury disables purchases. Existing deployments default to chain97 until an operator explicitly selects chain56.

| Setting | Mainnet requirement |
| --- | --- |
| `CREDITS_CHAIN_ID` | `56` |
| `CREDITS_TREASURY_ADDRESS` | Reviewed receiving wallet, not a signing key |
| `CREDITS_TOKEN_ADDRESS` | Omit to use pinned BSC USDT, `0x55d398326f99059ff775485246999027b3197955`. Other mainnet tokens are rejected. |
| `CREDITS_RPC_URL` | BSC mainnet endpoint that supports the finalized block tag. Falls back to `BSC_RPC_URL`, then the public mainnet endpoint. Never inherits the executor RPC. |

Mainnet USDT has eighteen decimals; the previous testnet token has six. Points conversion uses exact integer arithmetic and the existing rate of 10,000 points per USDT. It rejects unsafe integer totals and never rescales historical entries. The transaction receipt supplies the amount, not a browser request. Prices for work and Fast mode are unchanged.

Before showing payment addresses, the treasury endpoint checks the RPC chain, token decimals and, on mainnet, that a valid finalized block is readable. Its response is not cached. The Points screen validates the rail, shows the corresponding network and explorer, and hides unverified payment details. Fast mode receives the configured execution and payment networks separately and directs people to Points for current verified instructions. It does not embed payment addresses in its prompt.

A deposit must be a successful transfer of the configured token from the signed-in wallet to the configured treasury. Self-transfers are refused. Receipt hash, block depth and canonical block identity are checked. Mainnet additionally requires BSC's finalized height to cover the payment block, then rechecks the canonical block hash. Unsupported or stalled finality never falls back to merely waiting three blocks. See the [official BSC finality API](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/bsc-api-list/#economic-finality-api). Retrying uses the same transaction hash, not a second payment.

Existing lowercase transaction-hash uniqueness remains global, including across a network cutover. New records add network, token decimals, treasury and hash metadata. Reconciliation verifies the current treasury and each explicitly configured historical rail independently. Unknown, duplicate or unavailable historical backing fails closed. It never pools testnet and mainnet balances, deletes points, or silently converts payments into grants.

Before production cutover, inventory all existing deposits and pending verification requests. The read-only `credits/recovery-cli.ts` verifies an explicitly supplied historical payment and reports credited, uncredited or conflicting status without writing points. The production inventory found one old 50,000-point payment, correctly credited and backed by its original five testnet USDT. No recovery credit was needed. Configure its historical chain, treasury and RPC explicitly through `CREDITS_HISTORICAL_CHAIN_ID`, `CREDITS_HISTORICAL_TREASURY_ADDRESS` and `CREDITS_HISTORICAL_RPC_URL`. Do not switch back to old six-decimal verifier code after accepting mainnet deposits.

Local tests cover mainnet and testnet conversion, finality stalls and RPC failures, receipt branch changes, retries, mixed-rail accounting, stale wallet responses and network-specific payment instructions. A read-only mainnet RPC check confirmed USDT's eighteen decimals and support for the finalized block tag. The production billing cutover is complete: the public treasury response reports chain56, USDT18 and finalized verification. No real mainnet payment was made. Wallet-connected purchase and verification remain release gates.

## Transactions awaiting confirmation

A lost RPC response does not prove that a transaction failed. Execution now records an authorization-wide attempt and the actual executor address before reserving spend, then persists the locally calculated signed transaction hash before broadcasting. The signed transaction bytes and signing key are not stored in this record.

- Only one unresolved attempt may exist under a mandate, including across different jobs and server restarts.
- Only one unresolved attempt may use the same executor address on the same chain, including across different owners and API or runner processes. A competing mandate is deferred without reserving spend or exposing another owner's transaction hash. Independent signers or chains do not share this lock.
- A legacy unresolved attempt with no recorded executor blocks new sends on its chain. The sender is not guessed from today's configuration or backfilled into historical rows.
- A known preparation failure never broadcasts. A confirmed revert releases the reserved spend once. A confirmed success keeps that spend accounted for.
- A send acknowledgement failure, receipt timeout, missing receipt hash or different replacement transaction is unresolved, not refused. Its limit stays reserved and the same mandate cannot send another action.
- Mainnet success and revert receipts require the exact signed hash, a covering finalized checkpoint and a subsequent canonical block check on the recorded chain. Three-block depth alone cannot release the signer lock or reserved spend.
- A live preparation or submission defers a scheduled pass without permanently stopping the watch. An explicitly unconfirmed result stops the watch for review.
- The job page retains its last known pending state during refresh errors. A stale response from a different job or wallet cannot replace the current record.

Migration `028_execution_attempts.sql` adds the durable mandate records. Migration `029_execution_signer_lock.sql` adds the recorded executor and a partial unique index for unresolved chain-and-signer attempts. A short database lock makes the legacy-sender check and new claim atomic; the durable record continues to block sends after a connection closes or a process restarts. There is no automatic expiry, refund or resend for an abandoned attempt.

Operator receipt recovery is implemented in `execution/reconcile-cli.ts`. From `apps/api`, use `pnpm exec tsx src/execution/reconcile-cli.ts --attempt UUID --chain 56 --hash HASH` with `DATABASE_URL` and an explicit `EXECUTION_RECONCILE_RPC_URL`. Substitute the recorded attempt UUID and hash, and use `--chain 97` for a recorded testnet attempt. It defaults to a read-only check and does not use a signing key. Review that result before adding `--apply`.

Apply accepts only the exact recorded hash and chain with a successful, finalized, canonical receipt. It records `LANDED` and the evidence-bearing job event in one database transaction, refuses concurrent changes and leaves counted spend unchanged. Missing receipts, malformed finality, replacements and finalized reverts remain locked. A legacy revert does not prove its reserved amount, so this command cannot refund or unlock it. The command sends no transaction and does not restart a stopped watch. Closing the attempt permits later authorized requests, including an existing active schedule, so stop the watch first if it must remain inactive.

## Mandate account deployment safety

Account deployment claims both owner-and-chain and funder-and-chain before signing. Migration `030_account_deployment_attempts.sql` makes these pending locks durable across owners and processes. The account-funding key must differ from the configured executor identity because deployment and execution use separate queues.

The deployer verifies the RPC chain and funding, then records the locally computed signed hash and expected CREATE address before broadcasting. It disables replacement receipt following and accepts only that exact hash. Before recording an account, it verifies finalized inclusion, the expected address, the pinned runtime bytes, the owner's stored address and the manager binding, then rechecks the receipt block's canonical identity and RPC chain. Account insertion and the deployment's `LANDED` state commit together.

After an uncertain send or receipt response, retries only inspect the persisted hash. They never sign or broadcast another deployment. A changed funder or manager, a preparation interrupted before its hash was recorded, or unverifiable account identity remains blocked for review. Only a known pre-broadcast refusal or an exact finalized revert releases a failed deployment claim. These checks do not fund a user's mandate account, create token allowances or turn a hired report into trading authority.

Local regression coverage includes shared-signer claims across independent PostgreSQL connections, unknown historical senders, immutable hashes, finality and canonicality failures, recovery races, unchanged spending caps and stopped watches, deployment replacements, runtime/owner/manager mismatches, cross-owner funder contention, and atomic account finalization with rollback and lost acknowledgements. The focused signer-lock, receipt-recovery and pending-transaction run passed 106 tests; the account deployment, store, compiled-bytecode and funder-identity run passed 61 tests. These tests use mocked chain responses and isolated local database schemas, not live financial transactions.

Release the API and scheduled execution worker together. Apply additive migrations `028`, `029` and `030` before the new processes handle execution or account deployment, and drain old processes before resuming work. Old code does not consult the new locks. Rolling back only the application while unresolved attempts exist would therefore be unsafe. Keep execution paused for a forward repair or a reviewed reconciliation; do not delete pending records or undo the migrations to make a retry possible. Implementation and local test completion do not establish that the production cutover or wallet-connected release gates have passed.

## What the external-provider survey establishes

A bounded, category-diverse survey inspected 100 distinct BSC registrations, made 30 source requests and checked 16 distinct endpoints. It found five MCP services that completed initialization and tool discovery, plus eight responding A2A cards. No external task, payment, trade or fund movement was performed in that survey.

| Provider | Observed interface | Still not established |
| --- | --- | --- |
| HeyAnon Venus #43129 | MCP, 16 tools | A completed paid hire or automatic lending protection |
| 4LPHA Grid #340786 | MCP, 3 tools, shared with LP #340032 and Lending #340232 | Direct execution; listed tools explain strategy, list agents and return a hire link |
| BNB Yield Optimizer #265876 | MCP, 11 tools | API-key access for restricted tools or permission to manage a user's capital |
| BNB Chain Yield Router #338478 | MCP, 3 tools | Paid x402 report completion or authorised financial action |
| Singularry Jarvis #117823 | MCP, 5 tools | Successful task execution through AiKi |

Registrations sharing an endpoint are not separate proven execution integrations. A public A2A card is a declaration, not a completed task. Two checked AWS endpoints required authentication; one other discovery attempt failed. None of these facts proves fraud.

## Why registration totals are misleading

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) provides identity, reputation and validation interfaces, not a guarantee of functional capabilities. Payments are separate. Four.meme's published [registration script](https://github.com/four-meme-community/four-meme-ai/blob/main/skills/four-meme-integration/scripts/8004-register.ts) can register an active identity without service endpoints. Its [Agent Creator documentation](https://github.com/four-meme-community/four-meme-ai/blob/main/skills/four-meme-integration/references/agent-creator-and-wallets.md) describes a token-creator label tied to eligible agent identity ownership. That explains one registration incentive, not the motive of every operator.

The survey also found keyword false positives and repeated product families dominating score-sorted results. Rank is not evidence of successful execution. Discovery should distinguish published connections, authentication, payment, supported read operations and supported jobs.

The 8004scan Pro key was verified against current source quota headers. API-only credentials and conservative 120/minute, 20,000/day limits are staged for production. Keys stay out of browsers, provider requests and repository files. See the [catalog integration](../apps/api/src/catalog/README.md).

## Remaining release gates

1. Recheck funding of the separate mainnet executor and account-deployment wallets before activation. Earlier zero-BNB observations are not current balance evidence, and deploying an enforcement suite does not fund these roles. Never substitute the deployment key to bypass role separation.
2. Provide wallet onboarding, funding, allowances, revocation and visible runner health for an actual lending position. A watch must not guarantee protection against all market moves or RPC failures.
3. Deploy and verify the new strategy infrastructure, publish matching API/worker configuration, and complete all three user-funded strategy journeys. The report buyer flows below do not establish trading or allocation execution.
4. Integrate external providers' real authentication, prices, signed actions and task lifecycle. Never expose arbitrary discovered tools as approved financial actions.
5. Verify mainnet billing and all four activation flows in the normal wallet browser before claiming production completion.

## Customer checks after cutover

The existing wallet session and conversation survived a reload without another Fast charge. Native Chrome report hiring for Yield315946, Grid315945 and LP315944 returned live BSC results, then reached Paid only after explicit customer review and acceptance. Each used a ten-point offer. A Grid request missing required inputs reached Cancelled; refund and ledger verification are recorded in the release QA report. These were report purchases with internal points, not mainnet financial transactions.
