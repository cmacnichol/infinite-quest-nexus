UPDATE generation_jobs
   SET status = CASE WHEN result_turn_id IS NULL THEN 'queued' ELSE 'completed' END,
       lease_owner = NULL,
       lease_expires_at = NULL,
       completed_at = CASE WHEN result_turn_id IS NULL THEN completed_at ELSE COALESCE(completed_at, now()) END,
       updated_at = now()
 WHERE status = 'indexing';

ALTER TABLE generation_jobs DROP CONSTRAINT IF EXISTS generation_jobs_status_check;
ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_status_check CHECK (status IN (
  'queued', 'assessing', 'generating', 'validating', 'committing',
  'completed', 'recoverable', 'failed'
));

DROP INDEX IF EXISTS generation_jobs_one_active_per_campaign;
CREATE UNIQUE INDEX generation_jobs_one_active_per_campaign
  ON generation_jobs (campaign_id)
  WHERE status IN ('queued', 'assessing', 'generating', 'validating', 'committing');

DROP INDEX IF EXISTS generation_jobs_claim_idx;
CREATE INDEX generation_jobs_claim_idx ON generation_jobs (status, created_at)
  WHERE status IN ('queued', 'assessing', 'generating', 'validating', 'committing');

COMMENT ON COLUMN generation_jobs.status IS
  'Durable story workflow phase. Chronicle embedding work is tracked independently in chronicle_jobs.';
