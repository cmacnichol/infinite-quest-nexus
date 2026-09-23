-- Up Migration

CREATE TABLE campaign_cast_state (
  owner_user_id uuid NOT NULL,
  campaign_id uuid PRIMARY KEY,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  timeline_revision integer NOT NULL DEFAULT 0 CHECK (timeline_revision >= 0),
  UNIQUE (campaign_id, owner_user_id),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE
);

CREATE TABLE campaign_cast_characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  origin jsonb NOT NULL CHECK (origin->>'kind' IN ('manual','discovered','world','protagonist')),
  world_version_id uuid GENERATED ALWAYS AS ((origin->>'worldVersionId')::uuid) STORED,
  world_entity_id text GENERATED ALWAYS AS (origin->>'entityId') STORED,
  first_observed_turn integer NOT NULL CHECK (first_observed_turn >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, campaign_id, owner_user_id),
  CHECK ((origin->>'kind' = 'world') = (world_version_id IS NOT NULL AND world_entity_id IS NOT NULL)),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaign_cast_state(campaign_id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX campaign_cast_one_protagonist_idx ON campaign_cast_characters(campaign_id)
  WHERE origin->>'kind' = 'protagonist';
CREATE UNIQUE INDEX campaign_cast_world_origin_idx ON campaign_cast_characters(campaign_id,world_version_id,world_entity_id)
  WHERE origin->>'kind' = 'world';

-- One event is an atomic ordered batch, including its stable allocation receipt.
CREATE TABLE campaign_cast_events (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  effective_turn_number integer NOT NULL CHECK (effective_turn_number >= 0),
  timeline_revision integer NOT NULL CHECK (timeline_revision >= 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'array'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, campaign_id, owner_user_id),
  UNIQUE (campaign_id, idempotency_key),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaign_cast_state(campaign_id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX campaign_cast_events_boundary_idx ON campaign_cast_events(campaign_id,effective_turn_number,sequence);

CREATE TABLE campaign_cast_observations (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  character_id uuid NOT NULL,
  event_id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  field text NOT NULL CHECK (field IN ('identity.pronouns','story.role','story.background','story.personality',
    'story.motivations','story.goals','story.voiceAndMannerisms','appearance.description','state.location','state.condition','state.clothing')),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 2000),
  mode text NOT NULL CHECK (mode IN ('fact','claim')),
  speaker_character_id uuid,
  evidence jsonb NOT NULL CHECK (evidence->>'kind' IN ('turn','world')),
  source_turn_id uuid GENERATED ALWAYS AS ((evidence->>'turnId')::uuid) STORED,
  narration_revision integer GENERATED ALWAYS AS ((evidence->>'narrationRevision')::integer) STORED,
  source_hash text GENERATED ALWAYS AS (evidence->>'sourceHash') STORED,
  world_version_id uuid GENERATED ALWAYS AS ((evidence->>'worldVersionId')::uuid) STORED,
  supersedes_observation_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, character_id, field, campaign_id, owner_user_id),
  CHECK (supersedes_observation_id IS NULL OR (mode = 'fact' AND supersedes_observation_id <> id)),
  CHECK ((evidence->>'kind' = 'turn' AND source_turn_id IS NOT NULL AND narration_revision >= 0 AND source_hash ~ '^[a-f0-9]{64}$')
    OR (evidence->>'kind' = 'world' AND world_version_id IS NOT NULL)),
  FOREIGN KEY (character_id,campaign_id,owner_user_id) REFERENCES campaign_cast_characters(id,campaign_id,owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (speaker_character_id,campaign_id,owner_user_id) REFERENCES campaign_cast_characters(id,campaign_id,owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id,campaign_id,owner_user_id) REFERENCES campaign_cast_events(id,campaign_id,owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (source_turn_id,campaign_id,owner_user_id) REFERENCES turns(id,campaign_id,owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (world_version_id,owner_user_id) REFERENCES world_versions(id,owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_observation_id,character_id,field,campaign_id,owner_user_id)
    REFERENCES campaign_cast_observations(id,character_id,field,campaign_id,owner_user_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX campaign_cast_observations_character_idx ON campaign_cast_observations(campaign_id,character_id,sequence);
CREATE INDEX campaign_cast_observations_source_idx ON campaign_cast_observations(source_turn_id,narration_revision);

CREATE TABLE campaign_cast_profiles (
  owner_user_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  character_id uuid PRIMARY KEY,
  revision integer NOT NULL CHECK (revision >= 0),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  FOREIGN KEY (character_id,campaign_id,owner_user_id) REFERENCES campaign_cast_characters(id,campaign_id,owner_user_id) ON DELETE CASCADE
);

COMMENT ON TABLE campaign_cast_events IS 'Append-only cast event batches. Internal foundation only; public editing is not enabled.';
COMMENT ON TABLE campaign_cast_profiles IS 'Rebuildable supporting-character cache; protagonist profile remains on campaigns.';

-- Down Migration
DROP TABLE campaign_cast_profiles;
DROP TABLE campaign_cast_observations;
DROP TABLE campaign_cast_events;
DROP TABLE campaign_cast_characters;
DROP TABLE campaign_cast_state;
