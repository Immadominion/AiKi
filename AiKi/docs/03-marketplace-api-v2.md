# Marketplace API v2

**Status:** additive production foundation

`/v2` is the canonical commerce surface. It does not replace `/v1` yet. Legacy
jobs and tasks continue to work while Fast and Manual move onto the same kernel.

## Rules

- Marketplace token amounts are unsigned base-unit decimal strings.
- Every mutation requires an authenticated wallet session and `Idempotency-Key`.
- An idempotency key is scoped to the actor and operation.
- Repeating the same normalized request returns the original status and body.
- Reusing a key with different normalized input returns `409 IDEMPOTENCY_CONFLICT`.
- Public collections use opaque cursor pagination with a limit from 1 to 100.
- Offer versions are immutable. A hire must name the version it reviewed.
- Preview is side-effect free. It never reserves funds or creates work.
- Creating a job from preview creates an unfunded agreement and a funding
  operation. Work must not begin until finalized settlement evidence marks it
  funded.

## Providers

```http
GET /v2/providers?limit=24&cursor=...
GET /v2/providers/{providerId}
PUT /v2/providers/me
Idempotency-Key: caller-owned-key
```

```json
{
  "displayName": "Ada",
  "summary": "Reads smart contracts and returns cited findings.",
  "availability": "AVAILABLE",
  "capacity": 2,
  "supportedProtocols": ["erc-8183"],
  "geography": {}
}
```

Provider identity, endpoint liveness, and commerce reputation remain separate.
The current route creates or updates the authenticated wallet's human actor.
Agent actor ownership will be linked through registry evidence in a later slice.

## Offers

```http
GET  /v2/offers?limit=24&cursor=...
GET  /v2/offers/{offerId}
POST /v2/offers
POST /v2/offers/{offerId}/pause
```

`POST /v2/offers` publishes version 1 atomically. It requires an existing
provider profile. Its body defines:

- title, summary, and normalized capability tags
- input, output, and evidence JSON schemas
- `FIXED`, `HOURLY`, `MILESTONE`, or `QUOTE` pricing
- settlement chain, token, decimals, and base-unit amount
- delivery and review service levels
- revision and concurrent-capacity limits
- dispatch method and endpoint
- whether automatic failover is safe

Fixed, hourly, and milestone offers require a positive amount string. Quote
offers omit the amount. HTTP and MCP offers require an HTTP endpoint without
embedded credentials. The platform, not the provider, applies and snapshots the
fee schedule. Funding will still verify the token, decimals, chain, contract,
and policy against the settlement rail allowlist.

## Job preview

```http
POST /v2/jobs/preview
```

```json
{
  "offerId": "26f30755-c892-4a18-8d70-09321038b053",
  "offerVersion": 1,
  "brief": "Check the ownership and upgrade controls.",
  "requirements": { "contract": "0x..." },
  "definitionOfDone": "Return every finding with its source reference.",
  "evidenceRequirements": { "sourceLines": true }
}
```

The response binds the immutable offer terms, requested scope, settlement asset,
provider payment, rounded platform fee, and total into `previewHash`. A stale
version returns `409 OFFER_VERSION_CHANGED`. Quote-priced work returns
`canCreateJob: false` and `nextAction: REQUEST_QUOTE`.

## Job creation

```http
POST /v2/jobs
Idempotency-Key: caller-owned-key
```

The body is the reviewed preview body plus `previewHash`. AiKi rebuilds the
preview from the active immutable offer version and rejects the request if the
hash does not match.

The response creates:

- an `ASSIGNED` marketplace job
- an immutable agreement snapshot
- one append-only `JOB_CREATED` marketplace event
- one outbox event for settlement escrow creation
- one `CREATE_ESCROW` settlement operation with status `REQUESTED`

The job response is deliberately `settlementState: UNFUNDED` and
`nextAction: CREATE_ESCROW`. It does not claim escrow, payment, delivery start,
or provider earnings. Escrow creation is accepted only for the enabled BNB APEX
settlement rail and configured settlement asset.

Finalized funding, release, refund, delivery, disputes, and receipts are still
future slices. They require chain event projection, reconciliation, and the
hard-expiry refund path before the API can safely move jobs to funded or
terminal states.

## Settlement preparation

```sh
pnpm --filter @aiki/api marketplace:settlement:prepare
```

The preparation worker consumes pending
`marketplace.settlement.create.requested` outbox events. For each event it:

- locks one outbox row with `FOR UPDATE SKIP LOCKED`
- validates the agreement against the enabled BNB APEX rail
- prepares deployed `createJob(address,address,uint256,string,address)` calldata
- records the prepared transaction on the settlement operation
- moves the operation to `PREPARED`
- marks the outbox row `DELIVERED`

No private key is used in this step and no transaction is submitted. The next
slice submits prepared transactions and stores transaction hashes. Finalized log
ingestion still fills `external_job_id` before AiKi creates the actual `FUND`
operation.

## Settlement submission

```sh
MARKETPLACE_SETTLEMENT_RELAYER_KEY=0x... \
  pnpm --filter @aiki/api marketplace:settlement:submit
```

The submission worker claims one `PREPARED` `CREATE_ESCROW` operation by moving
it to `SUBMITTING`, sends the exact prepared calldata, then records:

- `status: SUBMITTED`
- transaction hash
- transaction nonce when the RPC can return it

If the RPC refuses the transaction before a hash exists, the operation returns to
`PREPARED` with `failure_code: SUBMIT_REFUSED` so it can be inspected and retried.
The worker does not mark the marketplace job funded or create provider earnings.
Only finalized APEX chain events may do that.
