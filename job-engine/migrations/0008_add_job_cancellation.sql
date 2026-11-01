-- Job Engine — M6: durable job cancellation request tracking.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_cancellation_requested_at
  ON jobs (cancellation_requested_at) WHERE cancellation_requested_at IS NOT NULL;
