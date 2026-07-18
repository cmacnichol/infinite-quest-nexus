CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_key text UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users (system_key, display_name)
VALUES ('initial-owner', 'Initial Owner')
ON CONFLICT (system_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS worlds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS worlds_owner_idx ON worlds(owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS world_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  version_number integer NOT NULL CHECK (version_number > 0),
  content jsonb NOT NULL,
  source_hash text,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, version_number)
);

CREATE INDEX IF NOT EXISTS world_versions_owner_idx ON world_versions(owner_user_id, world_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  world_version_id uuid NOT NULL REFERENCES world_versions(id),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  active_turn_number integer NOT NULL DEFAULT 0 CHECK (active_turn_number >= 0),
  legacy_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaigns_owner_idx ON campaigns(owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS campaign_state (
  campaign_id uuid PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  scratchpad_private text NOT NULL DEFAULT '',
  trackers jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_triggers jsonb NOT NULL DEFAULT '[]'::jsonb,
  event_triggers jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending_event_triggers jsonb NOT NULL DEFAULT '[]'::jsonb,
  rpg_stats jsonb NOT NULL DEFAULT '[]'::jsonb,
  import_provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number integer NOT NULL CHECK (turn_number > 0),
  source_turn_id text,
  action text NOT NULL DEFAULT '',
  narration text NOT NULL,
  choices jsonb NOT NULL DEFAULT '[]'::jsonb,
  custom_action_suggestion text NOT NULL DEFAULT '',
  image_prompt text NOT NULL DEFAULT '',
  image_url text NOT NULL DEFAULT '',
  mechanics_private jsonb,
  state_snapshot_private jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  import_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, turn_number)
);

CREATE INDEX IF NOT EXISTS turns_owner_campaign_idx ON turns(owner_user_id, campaign_id, turn_number);

CREATE TABLE IF NOT EXISTS chronicle_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  world_version_id uuid NOT NULL REFERENCES world_versions(id),
  turn_id uuid REFERENCES turns(id) ON DELETE CASCADE,
  memory_kind text NOT NULL CHECK (memory_kind IN ('turn_fiction', 'legacy_summary', 'campaign_summary', 'canonical_fact', 'open_thread')),
  ordinal integer NOT NULL DEFAULT 0,
  content text NOT NULL,
  token_estimate integer NOT NULL CHECK (token_estimate >= 0),
  importance real NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  entities text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector,
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (campaign_id, turn_id, memory_kind)
);

CREATE INDEX IF NOT EXISTS chronicle_memory_scope_idx
  ON chronicle_memories(owner_user_id, campaign_id, ordinal DESC);
CREATE INDEX IF NOT EXISTS chronicle_memory_search_idx
  ON chronicle_memories USING gin(search_document);

CREATE TABLE IF NOT EXISTS summary_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  through_turn integer NOT NULL DEFAULT 0,
  summary_kind text NOT NULL,
  content jsonb NOT NULL,
  token_estimate integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS summary_checkpoints_scope_idx
  ON summary_checkpoints(owner_user_id, campaign_id, through_turn DESC);

CREATE TABLE IF NOT EXISTS imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  source_type text NOT NULL,
  source_name text NOT NULL DEFAULT '',
  source_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  world_id uuid REFERENCES worlds(id),
  world_version_id uuid REFERENCES world_versions(id),
  campaign_id uuid REFERENCES campaigns(id),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (owner_user_id, source_hash)
);

CREATE TABLE IF NOT EXISTS chronicle_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  job_type text NOT NULL CHECK (job_type IN ('reindex_campaign')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS chronicle_jobs_claim_idx
  ON chronicle_jobs(status, created_at) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
  content_hash text NOT NULL,
  storage_driver text NOT NULL,
  storage_path text NOT NULL,
  mime_type text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, content_hash)
);

CREATE TABLE IF NOT EXISTS activity_events (
  id bigserial PRIMARY KEY,
  owner_user_id uuid REFERENCES users(id),
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  correlation_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
