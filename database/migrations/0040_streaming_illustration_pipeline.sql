-- 1. Add generation_job_id to link provisional work to in-flight generation
ALTER TABLE turn_illustration_sets
  ADD COLUMN generation_job_id uuid REFERENCES generation_jobs(id) ON DELETE SET NULL;

ALTER TABLE turn_illustration_segments
  ADD COLUMN generation_job_id uuid REFERENCES generation_jobs(id) ON DELETE SET NULL;

-- 2. Allow turn_id to be NULL in turn_illustration_sets for provisional sets
ALTER TABLE turn_illustration_sets
  ALTER COLUMN turn_id DROP NOT NULL,
  DROP CONSTRAINT turn_illustration_sets_turn_id_campaign_id_owner_user_id_fkey,
  ADD CONSTRAINT turn_illustration_sets_turn_owner_fk
    FOREIGN KEY (turn_id, campaign_id, owner_user_id)
    REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

-- 3. Allow turn_id to be NULL in turn_illustration_segments
ALTER TABLE turn_illustration_segments
  ALTER COLUMN turn_id DROP NOT NULL,
  DROP CONSTRAINT turn_illustration_segments_turn_id_campaign_id_owner_user__fkey,
  ADD CONSTRAINT turn_illustration_segments_turn_owner_fk
    FOREIGN KEY (turn_id, campaign_id, owner_user_id)
    REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

-- 4. Add new statuses to turn_illustration_sets
ALTER TABLE turn_illustration_sets
  DROP CONSTRAINT turn_illustration_sets_status_check,
  ADD CONSTRAINT turn_illustration_sets_status_check
    CHECK (status IN ('provisional', 'queued', 'refining', 'generating', 'completed', 'partial', 'failed', 'superseded', 'orphaned'));

-- 5. Extend image_jobs for streaming target type
ALTER TABLE image_jobs
  DROP CONSTRAINT image_jobs_target_type_check,
  ADD CONSTRAINT image_jobs_target_type_check
    CHECK (target_type IN ('turn_illustration', 'world_cover', 'streaming_illustration')),
  ADD COLUMN generation_job_id uuid REFERENCES generation_jobs(id) ON DELETE SET NULL;

-- 6. Relax the target scope check to allow streaming illustrations without turn_id
ALTER TABLE image_jobs
  DROP CONSTRAINT image_jobs_target_scope_check,
  ADD CONSTRAINT image_jobs_target_scope_check CHECK (
    (target_type = 'turn_illustration' AND campaign_id IS NOT NULL AND turn_id IS NOT NULL AND world_id IS NULL)
    OR (target_type = 'world_cover' AND campaign_id IS NULL AND turn_id IS NULL AND world_id IS NOT NULL)
    OR (target_type = 'streaming_illustration' AND campaign_id IS NOT NULL AND turn_id IS NULL
        AND world_id IS NULL AND generation_job_id IS NOT NULL)
  );

-- 6b. Allow asset_generation_contexts to accept streaming_illustration
ALTER TABLE asset_generation_contexts
  DROP CONSTRAINT asset_generation_contexts_target_type_check,
  ADD CONSTRAINT asset_generation_contexts_target_type_check
    CHECK (target_type IN ('world_cover', 'turn_illustration', 'streaming_illustration', 'other'));

-- 7. Index for claiming streaming image jobs
CREATE INDEX image_jobs_streaming_claim_idx
  ON image_jobs(generation_job_id, status, created_at)
  WHERE target_type = 'streaming_illustration'
    AND status IN ('queued', 'generating', 'provider_pending', 'downloading');

-- 8. Index for promoting/orphaning provisional work
CREATE INDEX turn_illustration_sets_generation_job_idx
  ON turn_illustration_sets(generation_job_id)
  WHERE generation_job_id IS NOT NULL;

-- 9. Allow illustration_prompt_jobs to work without turn_id
ALTER TABLE illustration_prompt_jobs
  ALTER COLUMN turn_id DROP NOT NULL,
  ADD COLUMN generation_job_id uuid REFERENCES generation_jobs(id) ON DELETE SET NULL;

-- 10. Partial unique index: only one provisional set per generation
CREATE UNIQUE INDEX turn_illustration_sets_one_provisional_per_generation
  ON turn_illustration_sets(generation_job_id)
  WHERE status = 'provisional' AND generation_job_id IS NOT NULL;

-- 11. Track streaming segmentation progress on the generation job itself
ALTER TABLE generation_jobs
  ADD COLUMN streaming_segments_state jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN generation_jobs.streaming_segments_state IS
  'Tracks word count thresholds and segment ordinals created during streaming for incremental illustration enqueue.';
