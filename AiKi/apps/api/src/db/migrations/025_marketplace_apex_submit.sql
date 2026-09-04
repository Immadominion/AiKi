-- APEX complete is only valid after the provider has submitted a deliverable on
-- chain. Track that provider submit leg as its own durable settlement operation
-- so requester review waits for finalized contract state.

ALTER TABLE marketplace_jobs
  DROP CONSTRAINT marketplace_jobs_settlement_state_check;

ALTER TABLE marketplace_jobs
  ADD CONSTRAINT marketplace_jobs_settlement_state_check
  CHECK (settlement_state IN (
    'UNFUNDED', 'FUNDING_SUBMITTED', 'FUNDED', 'DELIVERABLE_SUBMITTED',
    'RELEASE_SUBMITTED', 'RELEASED', 'REFUND_SUBMITTED', 'REFUNDED'
  ));

ALTER TABLE settlement_operations
  DROP CONSTRAINT settlement_operations_operation_type_check;

ALTER TABLE settlement_operations
  ADD CONSTRAINT settlement_operations_operation_type_check
  CHECK (operation_type IN (
    'CREATE_ESCROW', 'FUND', 'SUBMIT_WORK', 'RELEASE', 'REFUND', 'RESOLVE_DISPUTE'
  ));
