ALTER TABLE turns
  ADD CONSTRAINT turns_id_campaign_owner_unique UNIQUE (id, campaign_id, owner_user_id);

ALTER TABLE provider_profiles
  ADD COLUMN health_status text NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'unavailable')),
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  ADD COLUMN last_health_check_at timestamptz,
  ADD COLUMN last_health_error text;

CREATE TABLE campaign_illustration_configs (
  campaign_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  enabled boolean NOT NULL DEFAULT false,
  provider_profile_id uuid,
  model text NOT NULL DEFAULT '',
  size text NOT NULL DEFAULT '1024x1024',
  aspect_ratio text NOT NULL DEFAULT '1:1',
  quality text NOT NULL DEFAULT 'auto' CHECK (quality IN ('auto', 'low', 'medium', 'high')),
  output_format text NOT NULL DEFAULT 'png' CHECK (output_format IN ('png', 'jpeg', 'webp')),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, owner_user_id),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES provider_profiles(id, owner_user_id),
  CHECK (NOT enabled OR (provider_profile_id IS NOT NULL AND model <> ''))
);

CREATE TABLE image_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  provider_profile_id uuid NOT NULL,
  requested_model text NOT NULL,
  prompt text NOT NULL,
  prompt_hash text NOT NULL,
  size text NOT NULL DEFAULT '1024x1024',
  aspect_ratio text NOT NULL DEFAULT '1:1',
  quality text NOT NULL DEFAULT 'auto' CHECK (quality IN ('auto', 'low', 'medium', 'high')),
  output_format text NOT NULL DEFAULT 'png' CHECK (output_format IN ('png', 'jpeg', 'webp')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'generating', 'completed', 'recoverable', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  asset_id uuid,
  provider_response_id text,
  response_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (id, owner_user_id),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES provider_profiles(id, owner_user_id),
  FOREIGN KEY (asset_id, owner_user_id) REFERENCES assets(id, owner_user_id)
);

CREATE UNIQUE INDEX image_jobs_one_active_turn_idx
  ON image_jobs(turn_id)
  WHERE status IN ('queued', 'generating');

CREATE INDEX image_jobs_claim_idx
  ON image_jobs(status, next_attempt_at, created_at)
  WHERE status IN ('queued', 'generating');

CREATE INDEX image_jobs_campaign_idx
  ON image_jobs(owner_user_id, campaign_id, created_at DESC);

COMMENT ON COLUMN image_jobs.prompt IS
  'Validated fiction-only illustration prompt copied from an accepted turn. Never contains mechanics or private orchestration.';
