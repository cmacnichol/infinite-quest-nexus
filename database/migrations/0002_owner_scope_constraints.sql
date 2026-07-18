ALTER TABLE worlds ADD CONSTRAINT worlds_id_owner_unique UNIQUE (id, owner_user_id);
ALTER TABLE world_versions ADD CONSTRAINT world_versions_id_owner_unique UNIQUE (id, owner_user_id);
ALTER TABLE campaigns ADD CONSTRAINT campaigns_id_owner_unique UNIQUE (id, owner_user_id);

ALTER TABLE world_versions
  ADD CONSTRAINT world_versions_world_owner_fk
  FOREIGN KEY (world_id, owner_user_id) REFERENCES worlds(id, owner_user_id);

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_world_version_owner_fk
  FOREIGN KEY (world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id);

ALTER TABLE campaign_state
  ADD CONSTRAINT campaign_state_campaign_owner_fk
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id);

ALTER TABLE turns
  ADD CONSTRAINT turns_campaign_owner_fk
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id);

ALTER TABLE chronicle_memories
  ADD CONSTRAINT chronicle_memories_campaign_owner_fk
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id);

ALTER TABLE chronicle_memories
  ADD CONSTRAINT chronicle_memories_world_version_owner_fk
  FOREIGN KEY (world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id);

ALTER TABLE summary_checkpoints
  ADD CONSTRAINT summary_checkpoints_campaign_owner_fk
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id);

ALTER TABLE chronicle_jobs
  ADD CONSTRAINT chronicle_jobs_campaign_owner_fk
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id);
