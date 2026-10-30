-- Job Engine — initial schema (applied by the migration runner in jobs/db/migrate.ts).
--
-- `jobs` is the durable, authoritative store for submitted jobs. Nothing is
-- executed in Week 1: every job is created with status = `queued` and stays
-- there until a worker advances it (a future milestone).

CREATE TABLE jobs (
  id            UUID PRIMARY KEY,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL,
  payload       JSONB NOT NULL,
  result        JSONB NULL,
  error         JSONB NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ NULL,
  completed_at  TIMESTAMPTZ NULL,

  -- Valid domain values (defence in depth on top of app-level checks).
  CONSTRAINT jobs_type_valid   CHECK (type IN ('sum_numbers')),
  CONSTRAINT jobs_status_valid CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),

  -- Status <-> timestamp consistency. These are domain invariants, kept in sync
  -- with the application layer (see jobs/domain/job.ts): a `queued` job has no
  -- start/complete time; a `running` job has a start but no complete time; a
  -- `succeeded`/`failed` job has both; a `cancelled` job is finalized.
  CONSTRAINT jobs_timestamp_consistency CHECK (
      (status = 'queued'      AND started_at IS NULL AND completed_at IS NULL)
    OR (status = 'cancelled'  AND completed_at IS NOT NULL)
    OR (started_at IS NOT NULL AND completed_at IS NULL)        -- running
    OR (started_at IS NOT NULL AND completed_at IS NOT NULL)    -- succeeded/failed
  )
);

-- Lookup by id (PK already indexed). The following indexes serve the access
-- patterns used now and those the worker/scheduler will add shortly:
CREATE INDEX IF NOT EXISTS idx_jobs_status       ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at   ON jobs (created_at);
