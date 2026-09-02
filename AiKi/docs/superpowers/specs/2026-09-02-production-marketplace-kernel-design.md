# Production marketplace kernel design

## Outcome

Build one production commerce kernel for AiKi in which a human or agent can hire a human or agent, agree exact terms, fund work through escrow, exchange deliverables, resolve disputes, settle atomically, and generate durable reputation.

Fast and Manual are two interfaces to this same kernel. Venus watches become a specialized automation engagement that uses the same actors, agreements, events, and receipts. The existing trust and probing systems remain supporting signals.

This is not a prototype design. Money paths must be recoverable across crashes, retries, chain reorganizations, dependency outages, and operator mistakes. No screen may claim payment, settlement, finality, or withdrawal before the corresponding source of truth proves it.

## Product boundary

This design covers the marketplace transaction system:

- human and agent actors
- provider profiles
- versioned offers
- direct jobs and open requests
- proposals and assignments
- immutable agreements
- funding and escrow
- messaging and structured delivery
- revisions, acceptance, disputes, expiry, and refunds
- chain-backed settlement
- job events and receipts
- REST, Fast, Manual, and MCP parity
- migration from legacy `jobs` and `tasks`

This design does not expand Arena, broad probing, Proof Score, Workflow Studio, enterprise controls, multi-chain support, or new automation categories. Those systems may consume marketplace outcomes later, but they do not block the commerce kernel.

## Research basis

The design follows these verified patterns:

- ERC-8183 provides a minimal funded job lifecycle with fixed parties, submission, evaluation, completion, rejection, and permissionless expiry refund.
- BNB Chain's APEX deployment adds an optimistic evaluation policy with a dispute window and permissionless settlement.
- BNB Agent SDK treats ERC-8004 identity as optional for commerce, so a human wallet can be a provider without pretending to be an agent.
- Virtuals ACP separates versioned offerings, requirements, negotiation, job execution, delivery, and evaluation.
- Olas Mech emphasizes replay protection, durable recovery, provider retry, and nonce-based billing protection.
- Fetch protocols use role-constrained messages, protocol digests, expiry, and nonces.
- Mature human-work marketplaces distinguish chat attachments from formal delivery, support revisions, use a review clock, and escalate disputes.

Primary references:

- `https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8183.md`
- `https://github.com/bnb-chain/apex-contracts`
- `https://github.com/bnb-chain/bnbagent-sdk`
- `https://github.com/Virtual-Protocol/acp-node-v2`
- `https://github.com/valory-xyz/autonolas-marketplace`
- `https://uagents.fetch.ai/docs/guides/agent-payment-protocol`
- `https://rentahuman.ai/docs`

## Architecture decision

### Approaches considered

#### A. Extend the internal points ledger into a custodial marketplace wallet

This is the smallest change to the current task implementation. AiKi would accept deposits, hold provider earnings in Postgres, and add a treasury-funded withdrawal queue.

This approach is rejected. It makes AiKi responsible for custody, reserves, withdrawal signing, insolvency prevention, key isolation, compliance operations, and reconciliation between one pooled treasury and every customer liability. It also duplicates a deployed escrow protocol and preserves the current split between what the database says and what the chain holds.

#### B. Put all AiKi spending, including Fast model usage, through ERC-8183

This creates one asset and one settlement mechanism. It also forces every assistant turn through wallet approval or delegated on-chain spending, adds avoidable gas and latency, and treats model metering as if it were a two-party work contract.

This approach is rejected. Fast compute is consumed immediately and has different refund, metering, and counterparty semantics from marketplace work.

#### C. Hybrid money with one canonical marketplace kernel

Fast points remain a closed-loop compute credit. Every provider job uses a versioned on-chain settlement rail, with ERC-8183 APEX as the first BNB adapter. Postgres coordinates the marketplace and projects finalized chain truth.

This approach is selected. It keeps the useful credit ledger, removes custodial provider balances, makes human and agent payment identical, and isolates the draft protocol behind an adapter.

### Separate compute credits from marketplace money

AiKi has two economically different products and they must not share one balance:

1. Fast points pay for AiKi model and orchestration usage. They remain closed-loop, non-withdrawable credits.
2. Marketplace jobs pay providers in the ERC-20 asset held by the selected settlement rail. On BNB Chain, the preferred rail is APEX-compatible ERC-8183 escrow.

Points must never be described as provider earnings after this migration. Existing task points remain historical liabilities and are migrated or resolved explicitly. They are not silently relabeled as an on-chain asset.

### Chain owns money, Postgres owns marketplace coordination

For marketplace jobs:

- the escrow contract is the monetary source of truth
- finalized chain events are the settlement source of truth
- Postgres stores discovery, terms, messages, delivery metadata, state projections, operation attempts, and reconciliation results
- Postgres cannot independently mint a provider payout or mark an unfinalized transfer as complete

### Use a versioned settlement adapter

Create a `SettlementRail` interface. The first adapter targets the deployed BNB APEX ABI, not the draft ERC text. The adapter must:

- be keyed by chain ID and contract address
- read and validate the payment token from the contract
- pin the expected proxy implementation and policy configuration
- fail startup or disable new funding when runtime assertions fail
- expose typed prepare, submit, read, reconcile, refund, and settle operations
- preserve raw transaction and log evidence

ERC-8183 is still a draft and the deployed ABI has changed from the written proposal. No marketplace domain type may import a protocol-specific status directly.

### Use an additive strangler migration

Do not rename or repurpose the existing `jobs` and `tasks` tables. Add the canonical schema beside them and adapt legacy routes onto the new application services. Historical rows remain readable. Legacy writes are disabled only after shadow-read parity and two stable releases.

## Domain model

### Actor

An actor is a party that can request or provide work.

Required fields:

- stable AiKi ID
- type: `HUMAN`, `AGENT`, or `SYSTEM`
- controlling wallet address
- status
- created and updated timestamps

Agent actors may link to an ERC-8004 identity by chain and token ID. Human actors do not require an ERC-8004 identity. Identity, endpoint liveness, and commerce performance remain separate facts.

Jobs name three roles independently:

- payer: whose asset funds escrow
- requester: who asked for the work
- provider: who performs and receives payment

This distinction allows a human to fund an agent acting on their behalf, or an agent mandate to fund work requested for its owner.

### Provider profile

A provider profile contains:

- public name and description
- actor type
- payee wallet
- supported capability tags
- availability and capacity
- supported transport protocols
- endpoint records for agents
- service geography for location-bound human work
- verification and liveness facts
- commerce summary derived from settled jobs

Self-asserted profile copy is never merged into measured reputation.

### Offer and offer version

An offer describes work a provider is prepared to sell. Every material edit creates an immutable version.

An offer version snapshots:

- title and summary
- capability tags
- input JSON Schema
- output JSON Schema
- evidence requirements
- sample input and output
- pricing model, asset, amount, and included platform fee
- delivery SLA
- review window
- included revision count
- capacity and availability policy
- transport and dispatch method
- settlement rail
- location or identity requirements
- whether automatic provider failover is safe

A funded agreement always references an exact offer version. A later profile or price edit cannot change a live job.

### Open request and proposal

An open request describes work for which the provider is not yet selected. It may be public, invite-only, or private.

Because ERC-8183 funding binds a provider, workers do not begin an open request merely because it is posted. The sequence is:

1. requester posts requirements and budget range
2. providers apply or propose terms
3. requester selects one proposal
4. both sides receive an immutable agreement preview
5. the selected job is created and funded on chain
6. work begins only after funding is finalized

An open request therefore has a visible funding state, but it is not presented as escrow-backed before provider selection and finalization.

### Agreement

The agreement is immutable once funding begins. It snapshots:

- payer, requester, provider, evaluator, and payee
- offer version or custom scope
- structured requirements
- definition of done
- evidence requirements
- gross amount, provider amount, platform fee, token, decimals, and chain
- delivery, review, dispute, and hard-expiry deadlines
- revision allowance
- mandate and authorization reference when an agent spends
- settlement rail version and policy
- canonical terms hash

No route recomputes a live agreement from a current listing, registry owner, fee schedule, or token configuration.

### Delivery

A delivery is not a string field on the job. It is an append-only record with:

- attempt number
- submitting actor
- summary
- structured output matching the agreement schema
- artifact references
- content hashes
- evidence references
- created timestamp
- formal submission flag

Large artifacts live in versioned object storage. The database stores metadata and hashes. Sensitive artifacts are access-controlled and are never placed on a public URL by default.

### Conversation

Messages are append-only, sequenced, role-attributed records. Formal actions such as proposal, acceptance, delivery, revision request, and dispute remain distinct event types even when a human sees them in one conversation timeline.

### Receipt

A canonical receipt binds:

- agreement hash
- actor identities
- delivery hashes
- decision and dispute records
- settlement contract and on-chain job ID
- finalized transaction and log references
- provider payment and platform fee
- mandate and policy events where applicable
- terminal event sequence

Existing signed receipt bodies are preserved byte-for-byte and exposed as legacy receipts. They are never regenerated from incomplete historical columns.

## Orthogonal state machines

Do not create one enormous status enum. Work, settlement, dispute, payout projection, and automation have different failure modes.

### Work phase

```text
DRAFT
  -> OPEN
  -> OFFERED
  -> ASSIGNED
  -> IN_PROGRESS
  -> SUBMITTED
  -> CHANGES_REQUESTED -> IN_PROGRESS
  -> ACCEPTED
```

Defined exits exist for `CANCELLED` and `EXPIRED`. The transition table lives in one domain module and is enforced with optimistic row versions or conditional updates.

### Settlement phase

```text
UNFUNDED
  -> FUNDING_SUBMITTED
  -> FUNDED
  -> RELEASE_SUBMITTED -> RELEASED
  -> REFUND_SUBMITTED -> REFUNDED
```

`FAILED` describes an operation attempt, not terminal financial truth. A transaction timeout remains pending until chain reconciliation proves replacement, reversion, or finality.

### Dispute phase

```text
NONE
  -> OPENED
  -> EVIDENCE
  -> RESOLVED
  -> APPEALED
  -> FINAL
```

The first settlement policy uses BNB APEX optimistic evaluation:

- formal submission starts a fixed review window
- buyer acceptance may settle immediately when the policy permits
- buyer silence permits settlement after the review window
- a buyer dispute records a reason and evidence commitment
- configured voters or evaluators resolve the dispute
- a hard expiry always permits refund if no valid settlement is reached

The policy and all deadlines are frozen in the agreement. A policy extension can never disable the hard refund path.

### Automation engagement

```text
PENDING_ACTIVATION
  -> ACTIVE
  -> PAUSED
  -> ACTIVE
  -> STOPPED | EXPIRED | FAILED
```

A Venus watch is an automation engagement. Individual assessments and actions are runs under that engagement, not marketplace jobs of their own.

## Canonical persistence

Add these table groups:

- `actors`
- `provider_profiles`
- `offers`
- `offer_versions`
- `open_requests`
- `proposals`
- `marketplace_jobs`
- `job_agreements`
- `job_assignments`
- `job_messages`
- `job_deliveries`
- `job_decisions`
- `job_disputes`
- `settlement_accounts`
- `settlement_operations`
- `chain_events`
- `marketplace_events`
- `outbox_events`
- `inbox_messages`
- `idempotency_records`
- `authorization_usages`
- `automation_engagements`
- `automation_runs`
- `source_links`
- `canonical_receipts`

Financial and audit records use `ON DELETE RESTRICT`. Monetary base units use `NUMERIC(78,0)` in Postgres and decimal strings or `bigint` in TypeScript. No marketplace amount crosses a JavaScript `number` boundary.

Required constraints include:

- unique normalized actor wallet per chain where appropriate
- unique offer version number per offer
- one active assignment per job
- one settlement account per job and asset
- immutable agreement after funding begins
- unique delivery attempt per job
- unique aggregate event version per job
- unique chain event identity by chain, contract, transaction hash, and log index
- unique source mapping for every legacy job or task
- one authorization usage per semantic purchase
- no provider self-hire unless an explicitly privileged administrative repair path records why

## Transactions, outbox, and idempotency

Repositories participating in one command accept the same `postgres.TransactionSql`. Do not let each store open an unrelated pool during a money-sensitive operation.

In one database transaction, a command must:

1. validate caller and idempotency record
2. lock the actor, mandate, and job rows in deterministic order
3. validate expected aggregate version and current state
4. write or snapshot the agreement
5. reserve mandate capacity where applicable
6. append the domain event
7. enqueue external work in the transactional outbox
8. save the exact response against the idempotency record

External dispatch, webhooks, object storage writes, and chain submission happen after commit through durable workers. Workers use `FOR UPDATE SKIP LOCKED`, bounded exponential retry, dead-letter visibility, and idempotent consumers.

Every mutating REST and MCP operation requires a caller-supplied idempotency key scoped by actor and operation. Store a canonical request hash and exact successful response:

- same key and same hash returns the stored response
- same key and different hash returns `409 IDEMPOTENCY_CONFLICT`
- Fast uses `fast:{assistantTurnId}:{toolUseId}`
- provider callbacks include a unique message ID and signature

## Chain projection and finality

Store every observed log with:

- chain ID
- contract address
- transaction hash
- log index
- block number and block hash
- decoded event
- observed, finalized, or orphaned state
- first-seen and finalized timestamps

The indexer records pending events but changes monetary projections and dispatch eligibility only from the finalized chain head. It resumes from a finalized checkpoint and rescans an overlap window.

Funding operations use these stages:

```text
REQUESTED -> SUBMITTED -> MINED -> FINALIZED
```

Alternative terminal attempt states are `REPLACED`, `REVERTED`, and `ABANDONED`. A timeout never creates a new logical payment. Signer operations are serialized through a durable nonce queue.

The service automatically disables new funding when:

- the expected contract implementation changes
- the payment token or decimals do not match the configured allowlist
- the selected policy becomes unavailable
- the chain projection falls behind its operating threshold
- reconciliation diverges

Refund, expiry, and read paths remain available during a new-funding stop.

## Settlement invariants

The following invariants are release gates:

- one funded agreement settles at most once
- total provider payment, client refund, and fee never exceeds funded value
- platform fee is earned only on provider-paid value
- failed or refunded work does not generate a full platform fee
- work is never dispatched before finalized funding
- agreement parties, payee, asset, amount, fee, deadlines, terms, and policy cannot change after funding starts
- no extension, hook, API outage, or administrator can permanently block hard-expiry refund
- customer escrow and platform treasury are never treated as the same balance
- provider payment goes directly to the provider wallet or smart account
- all signed actions bind chain ID, verifying contract, job ID, action, token, amount, nonce, and deadline
- EOAs and ERC-1271 smart accounts are supported
- every terminal marketplace projection has matching finalized chain evidence

There is no AiKi marketplace withdrawal balance in the preferred settlement path. Settlement pays the provider directly. The product may show earned totals by indexing finalized payments, but AiKi does not custody those earnings.

## API design

Introduce `/v2` for the canonical domain. Keep `/v1` as compatibility adapters during migration.

### Discovery and supply

```text
GET    /v2/providers
GET    /v2/providers/:id
PUT    /v2/providers/me
POST   /v2/offers
PATCH  /v2/offers/:id
POST   /v2/offers/:id/pause
GET    /v2/offers
GET    /v2/offers/:id
```

Search first filters by compatibility, availability, geography, budget, protocol, and liveness. Ranking then uses paid completion rate with Bayesian smoothing, unique and repeat buyers, on-time delivery, response latency, disputes, refunds, and price relevance.

### Requests, proposals, and jobs

```text
POST   /v2/requests
GET    /v2/requests
POST   /v2/requests/:id/proposals
POST   /v2/proposals/:id/accept
POST   /v2/jobs/preview
POST   /v2/jobs
GET    /v2/jobs
GET    /v2/jobs/:id
GET    /v2/jobs/:id/events
POST   /v2/jobs/:id/fund
POST   /v2/jobs/:id/messages
POST   /v2/jobs/:id/start
POST   /v2/jobs/:id/deliveries
POST   /v2/jobs/:id/request-changes
POST   /v2/jobs/:id/accept
POST   /v2/jobs/:id/disputes
POST   /v2/jobs/:id/cancel
POST   /v2/jobs/:id/refund
```

Every job response includes exact money, deadlines, state versions, `allowedActions`, `nextAction`, and stable errors containing `code`, `retryable`, `details`, and `correlationId`.

Preview and quote endpoints are side-effect free. Funding validates expected agreement hash, offer version, asset, amount, fee, and chain.

## Fast and Manual parity

Fast does not own a private commerce implementation. Its tools call the same application services and use the same idempotency records as REST.

Fast flow:

1. parse the work request
2. search compatible offers and providers
3. choose direct hire or open request
4. produce a side-effect-free preview
5. show provider, scope, deadline, asset, provider pay, fee, and total
6. request confirmation or apply an existing mandate
7. create and fund the canonical job
8. return the same job route used by Manual

Manual flow exposes the same discovery, preview, funding, conversation, delivery, dispute, and receipt objects.

No Fast tool may invent a random idempotency key during a retry. No Manual screen may simulate progress in local storage after a canonical job exists.

## MCP and agent transport

The marketplace MCP surface mirrors the application services:

- `search_offers`
- `get_offer`
- `preview_job`
- `create_job`
- `get_job`
- `list_jobs`
- `send_job_message`
- `submit_delivery`
- `request_changes`
- `accept_delivery`
- `cancel_job`
- `open_dispute`
- `publish_offer`
- `pause_offer`
- `list_open_requests`
- `apply_to_request`
- `propose_terms`
- `accept_assignment`
- `decline_assignment`
- `respond_to_dispute`

The transport layer supports protocol adapters rather than assuming one endpoint shape. A2A, MCP, ACP-compatible HTTP, and current AiKi dispatch may be implemented independently behind a `ProviderTransport` interface.

Automatic provider failover is disabled unless the exact offer version says the work is fungible and failover-safe. Custom and human work never silently changes provider.

## Legacy migration

### Phase 0: operational hardening

- add migration advisory locking and migration checksums
- add production Postgres to CI
- add startup integrity checks
- introduce feature flags and kill switches
- stop monetary `Number` conversion
- inventory and quarantine historical financial mismatches

### Phase 1: additive canonical schema

- create new tables with nullable bridges where needed
- create concurrent indexes
- add constraints as `NOT VALID`, validate after backfill
- add restartable, checkpointed backfill commands
- preserve existing tables and routes

### Phase 2: historical projection

- map every existing `task` and legacy `job` through `source_links`
- derive funding from ledger entries, not status labels
- quarantine unfunded `OPEN` or `CLAIMED` tasks
- quarantine unpaid `SETTLED` tasks
- quarantine unrefunded `CANCELLED` tasks
- classify records missing owner, payee snapshot, or outlay as `LEGACY_INCOMPLETE`
- preserve signed legacy receipt bytes

### Phase 3: shadow operation

- project new commands into canonical tables
- adapt `/v1/jobs` and `/v1/tasks` to the canonical application service
- shadow-read canonical and legacy views
- alert on any divergence
- keep external effects on the existing path until parity is demonstrated

### Phase 4: controlled cutover

- switch Fast to canonical jobs
- switch Manual hire and Mission Control
- switch open work and human hiring
- migrate Venus watches to automation engagements
- disable legacy writes after two stable releases with zero unexplained divergence

### Phase 5: on-chain settlement rollout

- integrate APEX testnet through `SettlementRail`
- run all five canonical APEX lifecycle flows on a real testnet
- operate finalized event projection and reconciliation in shadow mode
- complete source, proxy-admin, timelock, token, policy, voter, and audit due diligence
- use TVL, per-job, and daily funding limits for controlled mainnet rollout
- automatically stop new funding on reconciliation failure
- retain refunds and reads during incident response

Existing funded work drains on its original rail. An upgrade never moves live escrow implicitly.

## Security and abuse controls

- role checks occur in the application service and database transition
- authorization ownership must be non-null and match the requester for new work
- provider and payer wallet snapshots are checksum-validated and normalized for lookup
- SSRF protection remains mandatory for all agent endpoints and artifact fetches
- callback tokens bind job, message, expiry, and intended action
- request and artifact size limits are enforced before buffering
- public posting and proposal routes have actor, wallet, and IP rate limits
- risky human-work categories remain unrepresentable through an allowlist
- self-dealing, circular payment, repeated counterparties, and wash-job patterns feed a risk system
- secrets and signing keys remain outside process logs and repository files
- signing services have narrow policies and do not share the API runtime's general credentials
- administrative powers use multisig and timelock
- emergency stops block new obligations before they block completion of existing ones

## Observability and operations

Production dashboards and alerts cover:

- request, proposal, funding, assignment, delivery, settlement, refund, and dispute conversion
- p50, p95, and p99 time in every state
- chain indexer lag and finalized checkpoint age
- pending, replaced, reverted, and abandoned transaction operations
- reconciliation by chain, contract, token, and job
- escrow obligations versus finalized contract balance
- stuck outbox messages and dead letters
- duplicate callbacks and idempotency conflicts
- dispute age and evaluator availability
- provider transport failures and endpoint health
- error rate by stable error code

Every request carries a request ID and correlation ID. Every external operation carries the job ID, aggregate version, and idempotency key in structured logs without exposing private briefs or secrets.

## Test strategy

### Domain and database

- exhaustive transition-table tests
- property tests for settlement allocation and deadlines
- 100-way races for create, proposal acceptance, assignment, delivery, settlement, refund, and dispute
- idempotency replay with same and conflicting request hashes
- crash injection after every database write and before every external send
- duplicate outbox delivery and callback replay
- migration checksum and advisory-lock tests
- restartable historical backfill fixtures
- legacy receipt signature preservation

### Chain and contracts

- ABI compatibility tests against pinned deployed bytecode
- contract implementation and payment-token startup assertions
- local Foundry lifecycle tests
- BSC testnet happy path, buyer dispute, stalemate expiry, open cancel, and never-submit flows
- finalized-head indexing and overlap-rescan tests
- simulated reorganization and orphan-event reversal
- transaction timeout, replacement, dropped transaction, revert, and duplicate submission tests
- EOAs and ERC-1271 smart accounts
- fuzzed amounts, deadlines, fees, and nonces

### Product surfaces

- full human-to-agent, agent-to-agent, agent-to-human, and human-to-human direction matrix
- direct offer and open request flows
- Fast and Manual produce the same canonical records
- REST and MCP return matching state and stable errors
- formal delivery remains distinct from messaging
- revision, silence-release, dispute, expiry, refund, and receipt flows
- existing Venus watches survive deploy and migration

### Release gates

- unit, type, lint, contract, integration, and end-to-end suites green
- real Postgres tests run in CI instead of skipping
- zero unexplained reconciliation divergence
- no terminal unpaid or unrefunded canonical jobs
- no overdue outbox or dispute beyond configured operational SLA
- restore rehearsal completed from a production-shaped backup
- rollback feature flags tested
- mainnet funding remains disabled until security due diligence is signed off

## Production acceptance criteria

- A person or agent can publish a versioned offer.
- A person or agent can discover providers by capability and compatibility.
- A person or agent can post an open request, receive proposals, and select a provider.
- A direct hire and an open request produce the same canonical agreement and job records.
- Work begins only after finalized escrow funding.
- Delivery, revisions, acceptance, dispute, expiry, refund, and settlement have recoverable paths.
- Provider payment goes directly to the provider-controlled wallet.
- Platform fees and customer escrow are independently reconcilable.
- Fast, Manual, REST, and MCP expose the same marketplace behavior.
- Every retry is idempotent and every external side effect is recoverable.
- Historical jobs, tasks, and signed receipts remain readable.
- Probe results inform eligibility and risk but settled jobs determine marketplace reputation.
- Production can stop new obligations without trapping existing escrow.

## Strategic sequence

The implementation order is:

1. harden migrations, amounts, transaction boundaries, idempotency, and outbox
2. add actors, providers, offers, agreements, and canonical jobs
3. adapt existing tasks and legacy jobs without changing their public behavior
4. move Fast and Manual onto the same application services
5. add APEX testnet settlement, finality projection, and reconciliation
6. complete dispute, receipt, MCP, and operational parity
7. perform controlled mainnet rollout after due diligence

Production-grade does not mean shipping every previously imagined AiKi feature at once. It means the marketplace features that do ship have real money, recoverable state, exact contracts, complete failure paths, and operational ownership.
