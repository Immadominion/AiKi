-- APEX funding is a two-step chain lifecycle: create the escrow job first, then
-- fund the external job id once the creation event is finalized. Store prepared
-- calldata durably before any signer or relayer submits it.

ALTER TABLE settlement_operations
  DROP CONSTRAINT settlement_operations_operation_type_check;

ALTER TABLE settlement_operations
  ADD CONSTRAINT settlement_operations_operation_type_check
  CHECK (operation_type IN ('CREATE_ESCROW', 'FUND', 'RELEASE', 'REFUND', 'RESOLVE_DISPUTE'));

ALTER TABLE settlement_operations
  DROP CONSTRAINT settlement_operations_status_check;

ALTER TABLE settlement_operations
  ADD CONSTRAINT settlement_operations_status_check
  CHECK (status IN (
    'REQUESTED', 'PREPARED', 'SUBMITTED', 'MINED', 'FINALIZED',
    'REPLACED', 'REVERTED', 'ABANDONED'
  ));

ALTER TABLE settlement_operations
  ADD COLUMN IF NOT EXISTS prepared_transaction JSONB
    CHECK (prepared_transaction IS NULL OR jsonb_typeof(prepared_transaction) = 'object'),
  ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMPTZ;

ALTER TABLE settlement_operations
  ADD CONSTRAINT settlement_operations_prepared_shape
  CHECK (
    status <> 'PREPARED'
    OR (prepared_transaction IS NOT NULL AND prepared_at IS NOT NULL)
  );
