ALTER TABLE illustration_prompt_jobs DROP CONSTRAINT IF EXISTS illustration_prompt_jobs_status_check;
ALTER TABLE illustration_prompt_jobs ADD CONSTRAINT illustration_prompt_jobs_status_check CHECK (status IN (
  'queued', 'refining', 'completed', 'fallback', 'recoverable', 'failed', 'cancelled'
));

ALTER TABLE illustration_resolution_jobs
  ALTER COLUMN turn_id DROP NOT NULL;
