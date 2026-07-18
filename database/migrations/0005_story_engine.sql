CREATE TABLE provider_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  provider_type text NOT NULL CHECK (provider_type IN ('lmstudio', 'openrouter', 'manifest', 'openai_compatible')),
  provider_role text NOT NULL DEFAULT 'text' CHECK (provider_role IN ('text', 'image')),
  base_url text NOT NULL,
  default_model text NOT NULL DEFAULT '',
  context_window_tokens integer NOT NULL DEFAULT 32768 CHECK (context_window_tokens BETWEEN 1024 AND 4000000),
  max_output_tokens integer NOT NULL DEFAULT 4096 CHECK (max_output_tokens BETWEEN 128 AND 262144),
  temperature real NOT NULL DEFAULT 0.8 CHECK (temperature BETWEEN 0 AND 2),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  encrypted_api_key text,
  credential_nonce text,
  credential_auth_tag text,
  credential_key_version integer,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name),
  UNIQUE (id, owner_user_id),
  CHECK ((encrypted_api_key IS NULL AND credential_nonce IS NULL AND credential_auth_tag IS NULL AND credential_key_version IS NULL)
      OR (encrypted_api_key IS NOT NULL AND credential_nonce IS NOT NULL AND credential_auth_tag IS NOT NULL AND credential_key_version IS NOT NULL))
);

CREATE INDEX provider_profiles_owner_role_idx
  ON provider_profiles(owner_user_id, provider_role, enabled, updated_at DESC);

CREATE TABLE generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  provider_profile_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  expected_turn_number integer NOT NULL CHECK (expected_turn_number > 0),
  action text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'generating', 'validating', 'committing', 'indexing', 'completed', 'recoverable', 'failed'
  )),
  requested_model text NOT NULL DEFAULT '',
  context_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt_protocol_version text NOT NULL DEFAULT 'story-v1',
  attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  provider_response_id text,
  provider_finish_reason text,
  partial_output text,
  result_turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
  error_code text,
  error_message text,
  recovery_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (campaign_id, idempotency_key),
  UNIQUE (id, owner_user_id),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id),
  FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES provider_profiles(id, owner_user_id)
);

CREATE UNIQUE INDEX generation_jobs_one_active_campaign_idx
  ON generation_jobs(campaign_id)
  WHERE status IN ('queued', 'generating', 'validating', 'committing', 'indexing');

CREATE INDEX generation_jobs_claim_idx
  ON generation_jobs(status, created_at)
  WHERE status IN ('queued', 'generating', 'validating', 'committing', 'indexing');

CREATE TABLE generation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  generation_job_id uuid NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  recovery_kind text NOT NULL DEFAULT 'initial',
  request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_response_id text,
  finish_reason text,
  raw_output text,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (generation_job_id, attempt_number),
  FOREIGN KEY (generation_job_id, owner_user_id) REFERENCES generation_jobs(id, owner_user_id)
);

CREATE INDEX generation_attempts_job_idx
  ON generation_attempts(owner_user_id, generation_job_id, attempt_number);

CREATE TABLE model_chains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  world_version_id uuid NOT NULL REFERENCES world_versions(id),
  provider_profile_id uuid NOT NULL,
  model text NOT NULL,
  endpoint_identity text NOT NULL,
  prompt_protocol_version text NOT NULL,
  context_fingerprint text NOT NULL,
  previous_response_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, provider_profile_id, model, endpoint_identity, prompt_protocol_version, context_fingerprint),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id),
  FOREIGN KEY (world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id),
  FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES provider_profiles(id, owner_user_id)
);

CREATE INDEX model_chains_scope_idx
  ON model_chains(owner_user_id, campaign_id, active, updated_at DESC);
