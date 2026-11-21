-- Job Engine — M7.1 fix: change job_id foreign key action
--
ALTER TABLE idempotency_keys ALTER COLUMN job_id DROP NOT NULL;