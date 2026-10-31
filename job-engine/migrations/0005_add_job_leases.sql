-- Job Engine — M4: job leases and fencing tokens.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_jobs_running_lease_expiry
  ON jobs (lease_expires_at) WHERE status = 'running';
