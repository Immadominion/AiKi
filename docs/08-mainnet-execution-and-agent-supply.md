# Mainnet execution and agent supply

Status checked on 9 September 2026. This is an engineering handoff, not a claim that all trading features are live.

## Product requirement

AiKi must let someone find and activate real BSC agents in four equally developed categories: liquidity rebalancing, grid trading, yield optimisation and lending-health monitoring. Category labels, registrations and reports alone do not satisfy automated execution. See the [official event requirements](https://www.bnbchain.org/en/hackathons/smart-money-era).

## Current gap

All four first-party agent identities exist on BSC mainnet. Venus #315943 supports in-app one-time report hiring. Rebalancer #315944, Grid #315945 and Yield #315946 currently expose read-only assessments, without comparable in-app task delivery or autonomous execution.

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

The mainnet deployment file has not been produced or enabled in this repair. Mainnet execution is not live merely because the software can select it. Mainnet deployment, source verification, funding/allowance setup, wallet activation and receipt verification remain release gates. The contracts are unaudited; passing tests is not an independent audit.

`onchain/script/Deploy.s.sol` now requires `EXPECTED_CHAIN_ID` and rejects a mismatched RPC before reading a signing key. Simulate and review the deployment first. A successful simulation must not be recorded as a broadcast or a deployed mainnet address.

A local chain56 fork simulation completed without broadcasting, using the verified prior deployment wallet. It estimated 7,627,729 gas for the suite, or 0.00038138645 BNB at the observed 0.05 gwei gas price. The wallet was recovered from the existing Git-ignored, owner-only deployment environment file; its key derives to the recorded deployment address. The server's executor and account-funding keys remain separate operational roles. No real BNB was moved during this repair, and simulation addresses are not deployed contracts.

Points purchases remain separately configured on testnet. Changing the execution network does not silently migrate billing. Mainnet billing needs its own treasury, asset, RPC and end-to-end deposit checks.

## Transactions awaiting confirmation

A lost RPC response does not prove that a transaction failed. Execution now records an authorization-wide attempt before reserving spend, then persists the locally calculated signed transaction hash before broadcasting. The signed transaction bytes and signing key are not stored in this record.

- Only one unresolved attempt may exist under a mandate, including across different jobs and server restarts.
- A known preparation failure never broadcasts. A confirmed revert releases the reserved spend once. A confirmed success keeps that spend accounted for.
- A send acknowledgement failure, receipt timeout, missing receipt hash or different replacement transaction is unresolved, not refused. Its limit stays reserved and the same mandate cannot send another action.
- A live preparation or submission defers a scheduled pass without permanently stopping the watch. An explicitly unconfirmed result stops the watch for review.
- The job page retains its last known pending state during refresh errors. A stale response from a different job or wallet cannot replace the current record.

Migration `028_execution_attempts.sql` adds the durable records and a partial unique index for unresolved attempts. There is no automatic expiry, refund or retry for an abandoned attempt. Operator reconciliation and shared-signer nonce coordination remain open work; this repair does not claim to implement them.

Release the API and scheduled execution worker together. Apply the additive migration before either new process handles jobs, and drain old execution processes before resuming work. Old code does not consult the new locks. Rolling back only the application while unresolved attempts exist would therefore be unsafe. Keep execution paused for a forward repair or a reviewed reconciliation; do not delete pending records or undo the migration to make a retry possible.

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

1. Deploy and verify the mainnet mandate suite, then configure the same reviewed deployment for API and runner.
2. Provide wallet onboarding, funding, allowances, revocation and visible runner health for an actual lending position. A watch must not guarantee protection against all market moves or RPC failures.
3. Complete the normal buyer flow for the other three categories. Reports are useful, but must not be renamed as trading or allocation execution.
4. Integrate external providers' real authentication, prices, signed actions and task lifecycle. Never expose arbitrary discovered tools as approved financial actions.
5. Verify mainnet billing and all four activation flows in the normal wallet browser before claiming production completion.
