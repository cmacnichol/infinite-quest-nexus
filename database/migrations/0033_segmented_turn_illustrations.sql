ALTER TABLE campaign_illustration_configs
  ADD COLUMN segment_word_count integer NOT NULL DEFAULT 500 CHECK (segment_word_count BETWEEN 100 AND 5000),
  ADD COLUMN images_per_segment integer NOT NULL DEFAULT 1 CHECK (images_per_segment BETWEEN 1 AND 2),
  ADD COLUMN segment_prompt_mode text NOT NULL DEFAULT 'direct'
    CHECK (segment_prompt_mode IN ('direct', 'ai_refined'));

CREATE TABLE turn_illustration_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  source_text_hash text NOT NULL,
  segment_word_count integer NOT NULL CHECK (segment_word_count BETWEEN 100 AND 5000),
  images_per_segment integer NOT NULL CHECK (images_per_segment BETWEEN 1 AND 2),
  prompt_mode text NOT NULL CHECK (prompt_mode IN ('direct', 'ai_refined', 'legacy')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'refining', 'generating', 'completed', 'partial', 'failed', 'superseded')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (id, owner_user_id),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX turn_illustration_sets_active_turn_idx
  ON turn_illustration_sets(turn_id) WHERE is_active;

CREATE TABLE turn_illustration_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  illustration_set_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset >= start_offset),
  start_word integer NOT NULL CHECK (start_word >= 0),
  end_word integer NOT NULL CHECK (end_word >= start_word),
  source_text text NOT NULL,
  source_text_hash text NOT NULL,
  direct_prompt text NOT NULL,
  resolved_prompt text NOT NULL DEFAULT '',
  prompt_source text NOT NULL DEFAULT 'direct'
    CHECK (prompt_source IN ('direct', 'ai_refined', 'ai_fallback', 'legacy')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'refining', 'generating', 'completed', 'recoverable', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (illustration_set_id, ordinal),
  UNIQUE (id, owner_user_id),
  FOREIGN KEY (illustration_set_id, owner_user_id) REFERENCES turn_illustration_sets(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE CASCADE
);

CREATE INDEX turn_illustration_segments_turn_idx
  ON turn_illustration_segments(owner_user_id, turn_id, ordinal);

CREATE TABLE turn_illustration_segment_assets (
  segment_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  asset_id uuid NOT NULL,
  image_job_id uuid,
  variant_index integer NOT NULL CHECK (variant_index BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, variant_index),
  UNIQUE (segment_id, asset_id),
  FOREIGN KEY (segment_id, owner_user_id) REFERENCES turn_illustration_segments(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id, owner_user_id) REFERENCES assets(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (image_job_id, owner_user_id) REFERENCES image_jobs(id, owner_user_id) ON DELETE SET NULL (image_job_id)
);

CREATE TABLE illustration_prompt_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  segment_id uuid NOT NULL,
  provider_profile_id uuid,
  requested_model text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'refining', 'completed', 'fallback', 'recoverable', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  response_id text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (segment_id),
  UNIQUE (id, owner_user_id),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (segment_id, owner_user_id) REFERENCES turn_illustration_segments(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES provider_profiles(id, owner_user_id) ON DELETE SET NULL (provider_profile_id)
);

CREATE INDEX illustration_prompt_jobs_claim_idx
  ON illustration_prompt_jobs(status, next_attempt_at, created_at)
  WHERE status IN ('queued', 'refining', 'recoverable');

CREATE TABLE illustration_backfill_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  mode text NOT NULL DEFAULT 'missing' CHECK (mode IN ('missing', 'rebuild')),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  config_snapshot jsonb NOT NULL,
  estimated_turns integer NOT NULL CHECK (estimated_turns >= 0),
  estimated_segments integer NOT NULL CHECK (estimated_segments >= 0),
  estimated_images integer NOT NULL CHECK (estimated_images >= 0),
  queued_sets integer NOT NULL DEFAULT 0 CHECK (queued_sets >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (campaign_id, idempotency_key),
  UNIQUE (id, owner_user_id),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE
);

ALTER TABLE image_jobs
  ADD COLUMN segment_id uuid,
  ADD COLUMN image_count integer NOT NULL DEFAULT 1 CHECK (image_count BETWEEN 1 AND 2),
  ADD CONSTRAINT image_jobs_segment_owner_fk
    FOREIGN KEY (segment_id, owner_user_id) REFERENCES turn_illustration_segments(id, owner_user_id) ON DELETE CASCADE;

DROP INDEX image_jobs_one_active_turn_idx;
CREATE UNIQUE INDEX image_jobs_one_active_segment_idx
  ON image_jobs(segment_id)
  WHERE segment_id IS NOT NULL
    AND target_type = 'turn_illustration'
    AND status IN ('queued', 'generating', 'provider_pending', 'downloading');
CREATE UNIQUE INDEX image_jobs_one_active_legacy_turn_idx
  ON image_jobs(turn_id)
  WHERE segment_id IS NULL
    AND target_type = 'turn_illustration'
    AND status IN ('queued', 'generating', 'provider_pending', 'downloading');

ALTER TABLE illustration_resolution_jobs
  ADD COLUMN segment_id uuid,
  ADD CONSTRAINT illustration_resolution_segment_owner_fk
    FOREIGN KEY (segment_id, owner_user_id) REFERENCES turn_illustration_segments(id, owner_user_id) ON DELETE CASCADE;

ALTER TABLE illustration_resolution_jobs
  DROP CONSTRAINT illustration_resolution_jobs_turn_id_key;
CREATE UNIQUE INDEX illustration_resolution_jobs_segment_idx
  ON illustration_resolution_jobs(segment_id) WHERE segment_id IS NOT NULL;
CREATE UNIQUE INDEX illustration_resolution_jobs_legacy_turn_idx
  ON illustration_resolution_jobs(turn_id) WHERE segment_id IS NULL;

INSERT INTO turn_illustration_sets (
  owner_user_id, campaign_id, turn_id, source_text_hash, segment_word_count,
  images_per_segment, prompt_mode, status, is_active, completed_at
)
SELECT turns.owner_user_id, turns.campaign_id, turns.id,
       md5(turns.narration), 500, 1, 'legacy',
       CASE WHEN turns.image_url <> '' THEN 'completed' ELSE 'partial' END,
       true, CASE WHEN turns.image_url <> '' THEN now() ELSE NULL END
  FROM turns
 WHERE turns.image_url <> ''
    OR EXISTS (SELECT 1 FROM image_jobs WHERE image_jobs.turn_id = turns.id)
ON CONFLICT DO NOTHING;

INSERT INTO turn_illustration_segments (
  owner_user_id, illustration_set_id, campaign_id, turn_id, ordinal,
  start_offset, end_offset, start_word, end_word, source_text, source_text_hash,
  direct_prompt, resolved_prompt, prompt_source, status
)
SELECT sets.owner_user_id, sets.id, sets.campaign_id, sets.turn_id, 0,
       0, length(turns.narration), 0,
       COALESCE(array_length(regexp_split_to_array(trim(turns.narration), '\s+'), 1), 0),
       turns.narration, md5(turns.narration),
       COALESCE(NULLIF(turns.image_prompt, ''), turns.narration),
       COALESCE(NULLIF(turns.image_prompt, ''), turns.narration),
       'legacy', CASE WHEN turns.image_url <> '' THEN 'completed' ELSE 'queued' END
  FROM turn_illustration_sets sets
  JOIN turns ON turns.id = sets.turn_id AND turns.owner_user_id = sets.owner_user_id
 WHERE sets.prompt_mode = 'legacy'
ON CONFLICT DO NOTHING;

UPDATE image_jobs jobs
   SET segment_id = segments.id
  FROM turn_illustration_segments segments
 WHERE jobs.turn_id = segments.turn_id
   AND jobs.owner_user_id = segments.owner_user_id
   AND segments.ordinal = 0
   AND jobs.segment_id IS NULL;

UPDATE illustration_resolution_jobs jobs
   SET segment_id = segments.id
  FROM turn_illustration_segments segments
 WHERE jobs.turn_id = segments.turn_id
   AND jobs.owner_user_id = segments.owner_user_id
   AND segments.ordinal = 0
   AND jobs.segment_id IS NULL;

INSERT INTO turn_illustration_segment_assets (segment_id, owner_user_id, asset_id, image_job_id, variant_index)
SELECT segments.id, contexts.owner_user_id, contexts.asset_id, contexts.image_job_id, contexts.variant_index
  FROM asset_generation_contexts contexts
  JOIN turn_illustration_segments segments
    ON segments.turn_id = contexts.turn_id AND segments.owner_user_id = contexts.owner_user_id
 WHERE contexts.target_type = 'turn_illustration'
   AND contexts.variant_index BETWEEN 0 AND 1
ON CONFLICT DO NOTHING;
