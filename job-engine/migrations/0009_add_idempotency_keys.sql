-- Job Engine — M7.1: durable idempotent job submission.
--
-- Stores idempotency keys with fingerprints for deduplication of job creation
-- requests. Supports concurrent-safe idempotent submission via PostgreSQL
-- uniqueness constraints and transactions.
--
-- Idempotency key scope: global (no authenticated tenant boundary established).
--

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS idempotency_key UUID UNIQUE;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookup by fingerprint.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_fingerprint ON idempotency_keys(fingerprint);