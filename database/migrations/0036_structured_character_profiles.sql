ALTER TABLE campaigns
  ADD COLUMN character_profile jsonb,
  ADD COLUMN character_profile_revision integer NOT NULL DEFAULT 0
    CHECK (character_profile_revision >= 0);

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_character_profile_object_check
  CHECK (character_profile IS NULL OR jsonb_typeof(character_profile) = 'object');

UPDATE campaigns
   SET character_profile = jsonb_build_object(
         'name', character_snapshot->>'name',
         'profile', character_snapshot->'profile'
       ),
       character_profile_revision = 1
 WHERE character_profile IS NULL
   AND jsonb_typeof(character_snapshot->'profile') = 'object'
   AND NULLIF(character_snapshot->>'name', '') IS NOT NULL;

CREATE TABLE campaign_character_profile_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  previous_profile jsonb,
  next_profile jsonb NOT NULL CHECK (jsonb_typeof(next_profile) = 'object'),
  edit_source text NOT NULL
    CHECK (edit_source IN ('world_version_seed', 'manual', 'ai_organized', 'imported', 'branch', 'transfer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, revision),
  UNIQUE (id, owner_user_id),
  FOREIGN KEY (campaign_id, owner_user_id)
    REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE
);

CREATE INDEX campaign_character_profile_edits_campaign_idx
  ON campaign_character_profile_edits(owner_user_id, campaign_id, revision DESC);

INSERT INTO campaign_character_profile_edits (
  owner_user_id, campaign_id, revision, previous_profile, next_profile, edit_source
)
SELECT owner_user_id, id, character_profile_revision, NULL, character_profile, 'world_version_seed'
  FROM campaigns
 WHERE character_profile IS NOT NULL
   AND character_profile_revision > 0
ON CONFLICT DO NOTHING;

ALTER TABLE turn_illustration_sets
  ADD COLUMN character_visual_reference text NOT NULL DEFAULT '';

COMMENT ON COLUMN campaigns.character_profile IS
  'Mutable campaign-owned full copy of the selected character name and structured profile.';

COMMENT ON COLUMN campaigns.character_profile_revision IS
  'Optimistic concurrency revision for explicit campaign character profile edits.';

COMMENT ON COLUMN turn_illustration_sets.character_visual_reference IS
  'Fiction-only bounded character appearance snapshot used for this illustration set.';
