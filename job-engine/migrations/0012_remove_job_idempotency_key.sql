-- Job Engine — M7.1.1: remove redundant idempotency_key from jobs table.
--
-- The idempotency association is preserved through idempotency_keys.job_id → jobs.id.
-- Prefer ON DELETE CASCADE so deleting a job also removes its idempotency record
-- and permits reuse of the key.
--
ALTER TABLE jobs DROP COLUMN idempotency_key;