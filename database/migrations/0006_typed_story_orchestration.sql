DROP INDEX IF EXISTS generation_jobs_one_active_campaign_idx;
DROP INDEX IF EXISTS generation_jobs_claim_idx;

ALTER TABLE generation_jobs
  DROP CONSTRAINT generation_jobs_status_check;

ALTER TABLE generation_jobs
  ADD CONSTRAINT generation_jobs_status_check CHECK (status IN (
    'queued', 'assessing', 'generating', 'validating', 'committing', 'indexing',
    'completed', 'recoverable', 'failed'
  ));

ALTER TABLE generation_jobs
  ADD COLUMN orchestration_private jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX generation_jobs_one_active_campaign_idx
  ON generation_jobs(campaign_id)
  WHERE status IN ('queued', 'assessing', 'generating', 'validating', 'committing', 'indexing');

CREATE INDEX generation_jobs_claim_idx
  ON generation_jobs(status, created_at)
  WHERE status IN ('queued', 'assessing', 'generating', 'validating', 'committing', 'indexing');

COMMENT ON COLUMN generation_jobs.orchestration_private IS
  'Private typed referee, roll, and event-trigger state. Never include this object in narrative or Chronicle prompts.';
