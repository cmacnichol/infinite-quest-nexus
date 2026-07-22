ALTER TABLE generation_jobs
  ADD COLUMN operation_kind text NOT NULL DEFAULT 'append'
    CHECK (operation_kind IN ('append', 'replace_latest')),
  ADD COLUMN replacement_turn_id uuid,
  ADD COLUMN base_turn_number integer CHECK (base_turn_number IS NULL OR base_turn_number >= 0),
  ADD COLUMN base_state_private jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN base_scratchpad_safe_for_prompt boolean NOT NULL DEFAULT false;

ALTER TABLE generation_jobs
  ADD CONSTRAINT generation_jobs_replacement_turn_owner_fk
  FOREIGN KEY (replacement_turn_id, campaign_id, owner_user_id)
  REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE SET NULL (replacement_turn_id);

ALTER TABLE generation_jobs DROP CONSTRAINT IF EXISTS generation_jobs_status_check;
ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_status_check CHECK (status IN (
  'queued', 'replacement_queued', 'assessing', 'generating', 'validating', 'committing',
  'completed', 'recoverable', 'failed', 'discarded'
));

WITH ranked_active AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY campaign_id
           ORDER BY CASE WHEN status = 'recoverable' THEN 1 ELSE 0 END, created_at DESC
         ) AS active_rank
    FROM generation_jobs
   WHERE status IN ('queued', 'replacement_queued', 'assessing', 'generating', 'validating', 'committing', 'recoverable')
)
UPDATE generation_jobs job
   SET status = 'discarded', lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
  FROM ranked_active ranked
 WHERE job.id = ranked.id AND ranked.active_rank > 1;

DROP INDEX IF EXISTS generation_jobs_one_active_per_campaign;
CREATE UNIQUE INDEX generation_jobs_one_active_per_campaign
  ON generation_jobs (campaign_id)
  WHERE status IN ('queued', 'replacement_queued', 'assessing', 'generating', 'validating', 'committing', 'recoverable');

DROP INDEX IF EXISTS generation_jobs_claim_idx;
CREATE INDEX generation_jobs_claim_idx ON generation_jobs (status, created_at)
  WHERE status IN ('queued', 'replacement_queued', 'assessing', 'generating', 'validating', 'committing');

COMMENT ON COLUMN generation_jobs.operation_kind IS
  'Append creates the next turn. Replace_latest stages a latest-turn replacement without deleting accepted state before validation.';
COMMENT ON COLUMN generation_jobs.base_state_private IS
  'Authoritative private campaign state immediately before a staged replacement turn. Never return this value to clients or prompts.';
