# Fast mode: unconfirmed turns

An interrupted provider call or ledger write can leave a turn `UNCONFIRMED`, or leave an expired `IN_PROGRESS` row. AiKi keeps the wallet blocked and the unresolved points reserved. It never assumes that a timeout means free work, refunds automatically, or runs the turn again with a fresh key.

Global concurrency counts only unexpired `IN_PROGRESS` leases. An unresolved turn does not occupy a global execution slot forever, but its full reservation still counts against wallet and global spending limits, even after 24 hours. Those limits can still stop admission until an operator resolves enough uncertainty. Expiry is not proof that a remote provider stopped processing.

## Inspect without changing balances

Use an approved read-only database connection. Keep wallet addresses, replies, keys and provider credentials out of public incident reports. These queries omit message bodies and idempotency keys.

```sql
BEGIN READ ONLY;

SELECT id, owner, state, created_at, updated_at, lease_expires_at,
       reserved_points, usage_points, input_tokens, output_tokens,
       response_status, response_body->'error'->>'code' AS error_code
FROM assistant_requests
WHERE state = 'UNCONFIRMED'
   OR (state = 'IN_PROGRESS' AND lease_expires_at <= now())
ORDER BY created_at;

COMMIT;
```

For one affected turn, set a local `psql` variable, then inspect its ledger entries. The UUID below is a placeholder, not a real request.

```sql
\set turn_id '00000000-0000-0000-0000-000000000000'
BEGIN READ ONLY;

SELECT owner, delta, reason, reference, created_at,
       detail->>'model' AS model,
       detail->>'inputTokens' AS input_tokens,
       detail->>'outputTokens' AS output_tokens,
       detail->>'providerPoints' AS provider_points
FROM credit_entries
WHERE reference LIKE 'turn:' || :'turn_id' || ':%'
ORDER BY created_at, reference;

COMMIT;
```

Each confirmed movement has matching `:out` and `:in` entries. `:hold` moves the wallet's points to reserve, `:spend` moves confirmed usage to revenue, and `:release` returns only known unused points. The reserve account is shared: its total balance alone does not identify this turn's hold. Compute the turn's remaining hold from these specific movements.

## Resolve deliberately

1. Save the turn ID, incident window and deployed model/pricing revision. Check the original response or replay with its original request key. Replaying reads the recorded outcome; using a new key is not recovery.
2. Check the provider's usage records and any available provider request IDs for that window. `usage_points` and token checkpoints prove usage already returned to AiKi, not that later calls used nothing. An aggregate provider bill or a missing log is not enough to allocate an uncertain call to a wallet.
3. Check linked Work tasks and downstream mutation references before deciding whether work ran. A failed answer can still have created work. Do not repeat a hire to test it.
4. If provider usage or ledger settlement cannot be established, leave the reservation in place and tell the affected user it is awaiting confirmation. Do not delete the request, reset its lease, mark it completed, grant compensating points, or edit cached balances just to unblock the wallet.
5. Once an operator has verified the exact outcome, prepare a separately reviewed, idempotent reconciliation change using the existing double-entry credit transfer rules. It must account for already-recorded movements, retain the original request identity, and settle confirmed spend before returning verified unused points. Update the cached response/history consistently and confirm each movement sums to zero. There is currently no automatic reconciliation command or scheduled refund job.

The admission transaction uses one PostgreSQL advisory lock for every wallet and the shared budget. Separating execution slots from unresolved financial reservations does not release points or bypass that lock. Raising spending limits to conceal unresolved requests is not recovery.

Implementation: [billing store](../apps/api/src/assistant/billing.ts), [HTTP settlement](../apps/api/src/assistant/routes.ts), [credit transfers](../apps/api/src/credits/store.ts), [pricing](../apps/api/src/credits/pricing.ts). Regression coverage: [PostgreSQL admission and replay](../apps/api/src/assistant/billing-postgres.test.ts), [failed usage and history replay](../apps/api/src/assistant/conversation-billing.test.ts).
