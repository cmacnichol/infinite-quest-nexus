ALTER TABLE worlds
  ADD COLUMN cover_asset_id uuid,
  ADD CONSTRAINT worlds_cover_asset_owner_fk
    FOREIGN KEY (cover_asset_id, owner_user_id) REFERENCES assets(id, owner_user_id) ON DELETE SET NULL (cover_asset_id);

ALTER TABLE image_jobs
  DROP CONSTRAINT IF EXISTS image_jobs_campaign_id_owner_user_id_fkey,
  DROP CONSTRAINT IF EXISTS image_jobs_turn_id_campaign_id_owner_user_id_fkey,
  ALTER COLUMN campaign_id DROP NOT NULL,
  ALTER COLUMN turn_id DROP NOT NULL,
  ADD COLUMN world_id uuid,
  ADD COLUMN target_type text NOT NULL DEFAULT 'turn_illustration'
    CHECK (target_type IN ('turn_illustration', 'world_cover')),
  ADD CONSTRAINT image_jobs_campaign_owner_fk
    FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  ADD CONSTRAINT image_jobs_turn_owner_fk
    FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE CASCADE,
  ADD CONSTRAINT image_jobs_world_owner_fk
    FOREIGN KEY (world_id, owner_user_id) REFERENCES worlds(id, owner_user_id) ON DELETE CASCADE,
  ADD CONSTRAINT image_jobs_target_scope_check CHECK (
    (target_type = 'turn_illustration' AND campaign_id IS NOT NULL AND turn_id IS NOT NULL AND world_id IS NULL)
    OR
    (target_type = 'world_cover' AND campaign_id IS NULL AND turn_id IS NULL AND world_id IS NOT NULL)
  );

DROP INDEX image_jobs_one_active_turn_idx;
CREATE UNIQUE INDEX image_jobs_one_active_turn_idx
  ON image_jobs(turn_id)
  WHERE target_type = 'turn_illustration'
    AND status IN ('queued', 'generating', 'provider_pending', 'downloading');

CREATE UNIQUE INDEX image_jobs_one_active_world_cover_idx
  ON image_jobs(world_id)
  WHERE target_type = 'world_cover'
    AND status IN ('queued', 'generating', 'provider_pending', 'downloading');

CREATE INDEX image_jobs_world_idx
  ON image_jobs(owner_user_id, world_id, created_at DESC)
  WHERE world_id IS NOT NULL;

COMMENT ON COLUMN image_jobs.target_type IS
  'Authoritative image-job target. World covers use the default image provider and never require a campaign.';
