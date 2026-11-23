-- 0014_add_worker_registration.sql
-- Worker registration table: persists worker lifecycle timestamps.
-- Health status is derived from these timestamps via the status derivation logic.

CREATE TABLE IF NOT EXISTS workers (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'node',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  shutdown_at TIMESTAMPTZ NULL
);

-- Index for heartbeat-based staleness checks
CREATE INDEX IF NOT EXISTS idx_workers_last_heartbeat ON workers (last_heartbeat_at DESC);