-- Job Engine — M2: allow execute_artifact job type.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_valid;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_valid CHECK (type IN ('sum_numbers', 'execute_artifact'));
