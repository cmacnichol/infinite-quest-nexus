-- Activity events
-- campaign_id is ON DELETE CASCADE.
ALTER TABLE activity_events
  ADD CONSTRAINT activity_events_campaign_owner_fk
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE;

-- Imports
-- world_id, world_version_id, campaign_id are ON DELETE SET NULL originally?
-- Actually, let's check 0001_initial_nexus.sql:
--   world_id uuid REFERENCES worlds(id),
--   world_version_id uuid REFERENCES world_versions(id),
--   campaign_id uuid REFERENCES campaigns(id),
-- No ON DELETE action was specified! Default is NO ACTION.
-- So we just add the compound keys with NO ACTION.
ALTER TABLE imports
  ADD CONSTRAINT imports_world_owner_fk
  FOREIGN KEY (world_id, owner_user_id) REFERENCES worlds(id, owner_user_id),
  ADD CONSTRAINT imports_world_version_owner_fk
  FOREIGN KEY (world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id),
  ADD CONSTRAINT imports_campaign_owner_fk
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id);

-- Assets
-- campaign_id has ON DELETE CASCADE. turn_id has ON DELETE SET NULL.
ALTER TABLE assets
  ADD CONSTRAINT assets_campaign_owner_fk
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  ADD CONSTRAINT assets_turn_owner_fk
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id);

-- Asset References
-- turn_id has ON DELETE SET NULL.
ALTER TABLE asset_references
  ADD CONSTRAINT asset_references_turn_owner_fk
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id);

-- Chronicle Memories
-- turn_id has ON DELETE CASCADE.
ALTER TABLE chronicle_memories
  ADD CONSTRAINT chronicle_memories_turn_owner_fk
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

-- Generation Jobs
-- result_turn_id has ON DELETE SET NULL.
ALTER TABLE generation_jobs
  ADD CONSTRAINT generation_jobs_turn_owner_fk
  FOREIGN KEY (result_turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id);

-- Provider Cost Events
-- turn_id has ON DELETE SET NULL.
ALTER TABLE provider_cost_events
  ADD CONSTRAINT provider_cost_events_turn_owner_fk
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id);
