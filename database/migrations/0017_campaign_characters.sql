ALTER TABLE campaigns
  ADD COLUMN selected_character_id text,
  ADD COLUMN character_snapshot jsonb;

UPDATE campaigns c
   SET selected_character_id = 'legacy-default',
       character_snapshot = jsonb_build_object(
         'id', 'legacy-default',
         'name', left(COALESCE(
           NULLIF(split_part(COALESCE(wv.content->'world'->>'character', ''), E'\n', 1), ''),
           'Default character'
         ), 200),
         'characterText', COALESCE(wv.content->'world'->>'character', ''),
         'rpgStats', COALESCE(wv.content->'rpgStats', '[]'::jsonb),
         'defaultTriggers', COALESCE(wv.content->'defaultTriggers', '[]'::jsonb),
         'source', jsonb_build_object('type', 'legacy-world-version'),
         'legacy', true
       )
  FROM world_versions wv
 WHERE wv.id = c.world_version_id
   AND wv.owner_user_id = c.owner_user_id
   AND c.character_snapshot IS NULL;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_character_snapshot_object_check
  CHECK (character_snapshot IS NULL OR jsonb_typeof(character_snapshot) = 'object');

COMMENT ON COLUMN campaigns.selected_character_id IS
  'Opaque character identifier selected from the campaign pinned world version.';

COMMENT ON COLUMN campaigns.character_snapshot IS
  'Immutable campaign-owned snapshot of the selected playable character.';
