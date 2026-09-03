-- Submitting a prepared transaction crosses the database/network boundary. A
-- distinct in-flight state lets one worker claim the operation before calling
-- the RPC, without holding a database transaction open during the send.

ALTER TABLE settlement_operations
  DROP CONSTRAINT settlement_operations_status_check;

ALTER TABLE settlement_operations
  ADD CONSTRAINT settlement_operations_status_check
  CHECK (status IN (
    'REQUESTED', 'PREPARED', 'SUBMITTING', 'SUBMITTED', 'MINED', 'FINALIZED',
    'REPLACED', 'REVERTED', 'ABANDONED'
  ));
