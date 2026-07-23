ALTER TABLE assets
  ADD COLUMN pixel_width integer CHECK (pixel_width > 0),
  ADD COLUMN pixel_height integer CHECK (pixel_height > 0),
  ADD COLUMN technical_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE asset_library_entries (
  asset_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 300),
  caption text NOT NULL DEFAULT '' CHECK (length(caption) <= 2000),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 10000),
  tags text[] NOT NULL DEFAULT '{}',
  origin text NOT NULL DEFAULT 'imported' CHECK (origin IN ('generated', 'imported', 'uploaded')),
  reuse_scope text NOT NULL DEFAULT 'private' CHECK (reuse_scope IN ('private', 'campaign', 'world', 'owner_library', 'shared')),
  automatic_reuse_enabled boolean NOT NULL DEFAULT false,
  review_status text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'eligible', 'restricted', 'blocked')),
  content_categories text[] NOT NULL DEFAULT '{}',
  favorite boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  metadata_revision integer NOT NULL DEFAULT 1 CHECK (metadata_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, owner_user_id),
  FOREIGN KEY (asset_id, owner_user_id) REFERENCES assets(id, owner_user_id) ON DELETE CASCADE
);

CREATE TABLE asset_derivatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  source_asset_id uuid NOT NULL,
  derivative_kind text NOT NULL CHECK (derivative_kind IN ('thumbnail', 'responsive')),
  transform_version integer NOT NULL DEFAULT 1 CHECK (transform_version > 0),
  pixel_width integer NOT NULL CHECK (pixel_width > 0),
  pixel_height integer NOT NULL CHECK (pixel_height > 0),
  storage_driver text NOT NULL,
  storage_path text NOT NULL,
  mime_type text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, source_asset_id, derivative_kind, transform_version, pixel_width, pixel_height),
  FOREIGN KEY (source_asset_id, owner_user_id) REFERENCES assets(id, owner_user_id) ON DELETE CASCADE
);

CREATE TABLE asset_generation_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  asset_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  image_job_id uuid,
  world_id uuid,
  world_version_id uuid,
  campaign_id uuid,
  turn_id uuid,
  target_type text NOT NULL DEFAULT 'other' CHECK (target_type IN ('world_cover', 'turn_illustration', 'other')),
  variant_index integer NOT NULL DEFAULT 0 CHECK (variant_index >= 0),
  fiction_prompt text NOT NULL DEFAULT '' CHECK (length(fiction_prompt) <= 20000),
  negative_prompt text CHECK (negative_prompt IS NULL OR length(negative_prompt) <= 10000),
  entities jsonb NOT NULL DEFAULT '[]'::jsonb,
  characters jsonb NOT NULL DEFAULT '[]'::jsonb,
  locations jsonb NOT NULL DEFAULT '[]'::jsonb,
  factions jsonb NOT NULL DEFAULT '[]'::jsonb,
  scene_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_profile_id uuid,
  provider_type text,
  model text NOT NULL DEFAULT '' CHECK (length(model) <= 500),
  generation_parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  parent_asset_ids uuid[] NOT NULL DEFAULT '{}',
  metadata_schema_version integer NOT NULL DEFAULT 1 CHECK (metadata_schema_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (asset_id, owner_user_id) REFERENCES assets(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (image_job_id, owner_user_id) REFERENCES image_jobs(id, owner_user_id) ON DELETE SET NULL (image_job_id),
  FOREIGN KEY (world_id, owner_user_id) REFERENCES worlds(id, owner_user_id) ON DELETE SET NULL (world_id),
  FOREIGN KEY (world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id) ON DELETE SET NULL (world_version_id),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE SET NULL (campaign_id),
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE SET NULL (turn_id),
  FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES provider_profiles(id, owner_user_id) ON DELETE SET NULL (provider_profile_id)
);

ALTER TABLE campaign_illustration_configs
  DROP CONSTRAINT IF EXISTS campaign_illustration_configs_check,
  ADD COLUMN source_policy text NOT NULL DEFAULT 'off'
    CHECK (source_policy IN ('off', 'library_only', 'library_then_generate', 'generate_only')),
  ADD COLUMN matching_scope text NOT NULL DEFAULT 'world'
    CHECK (matching_scope IN ('campaign', 'world', 'owner_library', 'shared')),
  ADD COLUMN confidence_profile text NOT NULL DEFAULT 'balanced'
    CHECK (confidence_profile IN ('strict', 'balanced', 'broad')),
  ADD COLUMN repetition_window integer NOT NULL DEFAULT 5 CHECK (repetition_window BETWEEN 0 AND 100);

UPDATE campaign_illustration_configs
   SET source_policy = CASE WHEN enabled THEN 'generate_only' ELSE 'off' END;

ALTER TABLE campaign_illustration_configs
  ADD CONSTRAINT campaign_illustration_source_enabled_check
    CHECK (enabled = (source_policy <> 'off'));

CREATE TABLE illustration_resolution_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  source_policy text NOT NULL CHECK (source_policy IN ('library_only', 'library_then_generate')),
  matching_scope text NOT NULL CHECK (matching_scope IN ('campaign', 'world', 'owner_library', 'shared')),
  confidence_profile text NOT NULL CHECK (confidence_profile IN ('strict', 'balanced', 'broad')),
  repetition_window integer NOT NULL DEFAULT 5 CHECK (repetition_window BETWEEN 0 AND 100),
  query_context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'matching', 'matched', 'no_match', 'generation_queued', 'completed', 'recoverable', 'failed', 'cancelled')),
  selected_asset_id uuid,
  selected_score numeric,
  matching_algorithm_version text NOT NULL DEFAULT 'library-match-v1',
  resolved_threshold numeric,
  image_job_id uuid,
  reason_code text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (turn_id),
  UNIQUE (id, owner_user_id),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (selected_asset_id, owner_user_id) REFERENCES assets(id, owner_user_id) ON DELETE SET NULL (selected_asset_id),
  FOREIGN KEY (image_job_id, owner_user_id) REFERENCES image_jobs(id, owner_user_id) ON DELETE SET NULL (image_job_id)
);

CREATE TABLE illustration_match_candidates (
  resolution_job_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  asset_id uuid NOT NULL,
  rank integer NOT NULL CHECK (rank > 0),
  score numeric NOT NULL,
  score_components jsonb NOT NULL DEFAULT '{}'::jsonb,
  rejection_reasons text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resolution_job_id, asset_id),
  UNIQUE (resolution_job_id, rank),
  FOREIGN KEY (resolution_job_id, owner_user_id) REFERENCES illustration_resolution_jobs(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id, owner_user_id) REFERENCES assets(id, owner_user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX asset_generation_context_job_variant_idx
  ON asset_generation_contexts(image_job_id, variant_index) WHERE image_job_id IS NOT NULL;

INSERT INTO asset_library_entries (
  asset_id, owner_user_id, created_by_user_id, origin, reuse_scope, automatic_reuse_enabled, review_status, created_at, updated_at
)
SELECT assets.id, assets.owner_user_id, assets.owner_user_id,
       CASE WHEN EXISTS (
         SELECT 1 FROM image_jobs WHERE image_jobs.asset_id = assets.id AND image_jobs.owner_user_id = assets.owner_user_id
       ) THEN 'generated' ELSE 'imported' END,
       CASE WHEN assets.campaign_id IS NOT NULL THEN 'campaign' ELSE 'private' END,
       false, 'unreviewed', assets.created_at, assets.created_at
  FROM assets
ON CONFLICT (asset_id) DO NOTHING;

INSERT INTO asset_generation_contexts (
  owner_user_id, asset_id, created_by_user_id, image_job_id, world_id, campaign_id, turn_id,
  target_type, variant_index, fiction_prompt, provider_profile_id, provider_type, model,
  generation_parameters, created_at
)
SELECT jobs.owner_user_id, jobs.asset_id, jobs.owner_user_id, jobs.id, jobs.world_id, jobs.campaign_id, jobs.turn_id,
       jobs.target_type, 0, jobs.prompt, jobs.provider_profile_id, jobs.provider_type, jobs.requested_model,
       jsonb_build_object(
         'size', jobs.size,
         'aspectRatio', jobs.aspect_ratio,
         'quality', jobs.quality,
         'outputFormat', jobs.output_format
       ), jobs.created_at
  FROM image_jobs jobs
 WHERE jobs.asset_id IS NOT NULL
ON CONFLICT (image_job_id, variant_index) WHERE image_job_id IS NOT NULL DO NOTHING;

CREATE FUNCTION create_default_asset_library_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO asset_library_entries (asset_id, owner_user_id, created_by_user_id, origin, reuse_scope)
  VALUES (NEW.id, NEW.owner_user_id, NEW.owner_user_id, 'imported',
          CASE WHEN NEW.campaign_id IS NULL THEN 'private' ELSE 'campaign' END)
  ON CONFLICT (asset_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER create_default_asset_library_entry_trigger
AFTER INSERT ON assets
FOR EACH ROW EXECUTE FUNCTION create_default_asset_library_entry();

CREATE INDEX asset_library_owner_created_idx
  ON asset_library_entries(owner_user_id, created_at DESC, asset_id DESC);
CREATE INDEX asset_library_owner_scope_idx
  ON asset_library_entries(owner_user_id, reuse_scope, review_status, automatic_reuse_enabled, created_at DESC);
CREATE INDEX asset_library_owner_favorite_idx
  ON asset_library_entries(owner_user_id, favorite, created_at DESC) WHERE favorite = true;
CREATE INDEX asset_library_tags_idx ON asset_library_entries USING gin(tags);
CREATE INDEX asset_generation_context_asset_idx
  ON asset_generation_contexts(owner_user_id, asset_id, created_at DESC);
CREATE INDEX asset_generation_context_campaign_idx
  ON asset_generation_contexts(owner_user_id, campaign_id, created_at DESC) WHERE campaign_id IS NOT NULL;
CREATE INDEX asset_generation_context_world_idx
  ON asset_generation_contexts(owner_user_id, world_id, world_version_id, created_at DESC) WHERE world_id IS NOT NULL;
CREATE INDEX asset_generation_context_entities_idx ON asset_generation_contexts USING gin(entities);
CREATE INDEX asset_generation_context_characters_idx ON asset_generation_contexts USING gin(characters);
CREATE INDEX asset_generation_context_locations_idx ON asset_generation_contexts USING gin(locations);
CREATE INDEX asset_derivatives_source_idx
  ON asset_derivatives(owner_user_id, source_asset_id, derivative_kind, pixel_width);
CREATE INDEX illustration_resolution_claim_idx
  ON illustration_resolution_jobs(status, next_attempt_at, created_at)
  WHERE status IN ('queued', 'matching', 'recoverable');
CREATE INDEX illustration_resolution_campaign_idx
  ON illustration_resolution_jobs(owner_user_id, campaign_id, created_at DESC);

COMMENT ON COLUMN asset_generation_contexts.fiction_prompt IS
  'Validated fiction-only prompt. Never contains mechanics, scratchpads, rejected output, or private reasoning.';
COMMENT ON COLUMN illustration_resolution_jobs.query_context_snapshot IS
  'Bounded sanitized fiction-only matching context. Never contains mechanics or private orchestration.';
