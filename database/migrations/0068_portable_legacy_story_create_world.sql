-- Up Migration

-- The live Legacy Story contract permits importing without a target world.
-- In that case the durable preview owns creation of both the world version and
-- campaign, matching Campaign ZIP's embedded-world behavior while retaining
-- Legacy Story's distinct portable family.
ALTER TABLE portable_import_operations
  DROP CONSTRAINT portable_import_kind_destination_check,
  ADD CONSTRAINT portable_import_kind_destination_check CHECK (
    (import_kind = 'campaign_zip'
      AND destination_kind IN ('embedded_create_world', 'existing_world_version'))
    OR (import_kind = 'legacy_story'
      AND destination_kind IN ('create_world', 'existing_world_version'))
    OR (import_kind = 'story_text'
      AND destination_kind = 'existing_world_version')
    OR (import_kind IN ('infinite_worlds', 'cyoa', 'world_json', 'world_text')
      AND destination_kind = 'create_world')
  );

-- Down Migration

ALTER TABLE portable_import_operations
  DROP CONSTRAINT portable_import_kind_destination_check,
  ADD CONSTRAINT portable_import_kind_destination_check CHECK (
    (import_kind = 'campaign_zip'
      AND destination_kind IN ('embedded_create_world', 'existing_world_version'))
    OR (import_kind IN ('legacy_story', 'story_text')
      AND destination_kind = 'existing_world_version')
    OR (import_kind IN ('infinite_worlds', 'cyoa', 'world_json', 'world_text')
      AND destination_kind = 'create_world')
  );
