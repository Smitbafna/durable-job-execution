-- Job Engine — execution output persistence (M7.2.2)

-- Add exit_code, stdout, and stderr columns to jobs table
-- These columns persist runtime execution output for client retrieval.

ALTER TABLE jobs
ADD COLUMN IF NOT EXISTS exit_code SMALLINT,
ADD COLUMN IF NOT EXISTS stdout TEXT,
ADD COLUMN IF NOT EXISTS stderr TEXT;
