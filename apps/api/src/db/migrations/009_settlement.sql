-- FUNDED and SETTLED existed in the API contract and nowhere else: no code
-- could reach them and the CHECK constraint would have rejected them anyway,
-- so a job could be quoted, dispatched, run and completed without any money
-- ever moving. These two states are the difference between a catalogue and a
-- marketplace.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (
  status IN (
    'AUTHORIZED', 'FUNDED', 'DISPATCHED', 'RUNNING',
    'COMPLETED', 'SETTLED', 'REJECTED', 'CANCELLED'
  )
);
