ALTER TABLE generation_jobs DROP CONSTRAINT IF EXISTS generation_jobs_status_check;
ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_status_check CHECK (status IN (
  'queued', 'replacement_queued', 'assessing', 'generating', 'validating', 'committing',
  'completed', 'recoverable', 'failed', 'discarded', 'cancelled'
));
