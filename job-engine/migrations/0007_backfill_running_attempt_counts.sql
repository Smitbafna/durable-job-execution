-- Job Engine — M5.1.1: backfill attempt counts for pre-existing running jobs.
--
-- Before M5.1, a row in `running` represented a job that had already been claimed
-- for execution. Those rows therefore consumed one attempt and must start at 1.
UPDATE jobs
SET attempt_count = 1
WHERE status = 'running'
  AND attempt_count = 0;