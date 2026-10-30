-- Job Engine — Week 2 worker execution support.
--
-- Adds per-job ownership metadata (`worker_id`) so the worker can record and
-- observe which process claimed a job, plus indexes that make "pick the next
-- queued job" efficient. 0001_ is untouched here; the migration runner applies
-- files in name order, so this runs after the original schema.

-- Record which worker claimed a job (NULL for jobs never claimed yet).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS worker_id TEXT NULL;

-- Who ran what (ownership / debugging).
CREATE INDEX IF NOT EXISTS idx_jobs_worker_id ON jobs (worker_id);

-- Efficient "next queued job" selection: pick the oldest queued job first.
-- The partial predicate lets this index be far smaller than a full
-- idx_jobs_created_at while still covering WHERE status = 'queued'.
CREATE INDEX IF NOT EXISTS idx_jobs_queued_created
    ON jobs (created_at) WHERE status = 'queued';
