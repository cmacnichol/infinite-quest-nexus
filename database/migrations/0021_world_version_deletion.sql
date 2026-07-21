ALTER TABLE worlds
  ADD COLUMN next_version_number integer;

UPDATE worlds w
   SET next_version_number = COALESCE((
     SELECT max(wv.version_number) + 1
       FROM world_versions wv
      WHERE wv.world_id = w.id
        AND wv.owner_user_id = w.owner_user_id
   ), 1);

ALTER TABLE worlds
  ALTER COLUMN next_version_number SET DEFAULT 1,
  ALTER COLUMN next_version_number SET NOT NULL,
  ADD CONSTRAINT worlds_next_version_number_check CHECK (next_version_number > 0);

CREATE FUNCTION maintain_world_next_version_number()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE worlds
     SET next_version_number = GREATEST(next_version_number, NEW.version_number + 1)
   WHERE id = NEW.world_id
     AND owner_user_id = NEW.owner_user_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER world_versions_maintain_next_version_number
AFTER INSERT ON world_versions
FOR EACH ROW
EXECUTE FUNCTION maintain_world_next_version_number();

ALTER TABLE world_drafts
  DROP CONSTRAINT world_drafts_based_on_world_version_id_owner_user_id_fkey,
  ADD CONSTRAINT world_drafts_based_on_world_version_owner_fk
  FOREIGN KEY (based_on_world_version_id, owner_user_id)
  REFERENCES world_versions(id, owner_user_id)
  ON DELETE SET NULL (based_on_world_version_id);

ALTER TABLE worlds
  DROP CONSTRAINT worlds_forked_version_owner_fk,
  ADD CONSTRAINT worlds_forked_version_owner_fk
  FOREIGN KEY (forked_from_world_version_id, owner_user_id)
  REFERENCES world_versions(id, owner_user_id)
  ON DELETE SET NULL (forked_from_world_version_id);

CREATE INDEX campaigns_world_version_scope_idx
  ON campaigns(owner_user_id, world_version_id);

CREATE INDEX chronicle_memories_world_version_scope_idx
  ON chronicle_memories(owner_user_id, world_version_id);

CREATE INDEX model_chains_world_version_scope_idx
  ON model_chains(owner_user_id, world_version_id);

CREATE INDEX campaign_world_migrations_from_version_scope_idx
  ON campaign_world_migrations(owner_user_id, from_world_version_id);

CREATE INDEX campaign_world_migrations_to_version_scope_idx
  ON campaign_world_migrations(owner_user_id, to_world_version_id);

CREATE INDEX world_drafts_based_on_version_scope_idx
  ON world_drafts(owner_user_id, based_on_world_version_id)
  WHERE based_on_world_version_id IS NOT NULL;

CREATE INDEX worlds_forked_from_version_scope_idx
  ON worlds(owner_user_id, forked_from_world_version_id)
  WHERE forked_from_world_version_id IS NOT NULL;

CREATE INDEX imports_world_version_scope_idx
  ON imports(owner_user_id, world_version_id)
  WHERE world_version_id IS NOT NULL;
