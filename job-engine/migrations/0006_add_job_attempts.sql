-- Job Engine — M5.1: durable attempt tracking and retry scheduling metadata.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL;

-- Database constraints for valid attempt counts and maximum attempts.
ALTER TABLE jobs ADD CONSTRAINT jobs_attempt_count_nonnegative CHECK (attempt_count >= 0);
ALTER TABLE jobs ADD CONSTRAINT jobs_max_attempts_positive CHECK (max_attempts > 0 AND max_attempts <= 100);

-- Existing queued jobs remain immediately eligible (next_attempt_at defaults to NULL).
-- Existing running jobs retain lease ownership (no changes to lease columns).

CREATE INDEX IF NOT EXISTS idx_jobs_next_attempt_at ON jobs (next_attempt_at) WHERE status = 'queued';