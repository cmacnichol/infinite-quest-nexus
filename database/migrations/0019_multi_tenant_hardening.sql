ALTER TABLE activity_events
  DROP CONSTRAINT IF EXISTS activity_events_campaign_id_fkey,
  ADD CONSTRAINT activity_events_campaign_owner_fk
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE;

ALTER TABLE imports
  DROP CONSTRAINT IF EXISTS imports_world_id_fkey,
  ADD CONSTRAINT imports_world_owner_fk
  FOREIGN KEY (world_id, owner_user_id) REFERENCES worlds(id, owner_user_id) ON DELETE SET NULL (world_id),
  DROP CONSTRAINT IF EXISTS imports_world_version_id_fkey,
  ADD CONSTRAINT imports_world_version_owner_fk
  FOREIGN KEY (world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id) ON DELETE SET NULL (world_version_id),
  DROP CONSTRAINT IF EXISTS imports_campaign_id_fkey,
  ADD CONSTRAINT imports_campaign_owner_fk
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE SET NULL (campaign_id);

ALTER TABLE assets
  DROP CONSTRAINT IF EXISTS assets_campaign_id_fkey,
  ADD CONSTRAINT assets_campaign_owner_fk
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  DROP CONSTRAINT IF EXISTS assets_turn_id_fkey,
  ADD CONSTRAINT assets_turn_owner_fk
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE SET NULL (turn_id);

ALTER TABLE asset_references
  DROP CONSTRAINT IF EXISTS asset_references_turn_id_fkey,
  ADD CONSTRAINT asset_references_turn_owner_fk
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE SET NULL (turn_id);

ALTER TABLE chronicle_memories
  DROP CONSTRAINT IF EXISTS chronicle_memories_turn_id_fkey,
  ADD CONSTRAINT chronicle_memories_turn_owner_fk
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

ALTER TABLE generation_jobs
  DROP CONSTRAINT IF EXISTS generation_jobs_result_turn_id_fkey,
  ADD CONSTRAINT generation_jobs_turn_owner_fk
  FOREIGN KEY (result_turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE SET NULL (result_turn_id);

ALTER TABLE provider_cost_events
  DROP CONSTRAINT IF EXISTS provider_cost_events_turn_id_fkey,
  ADD CONSTRAINT provider_cost_events_turn_owner_fk
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE SET NULL (turn_id);
