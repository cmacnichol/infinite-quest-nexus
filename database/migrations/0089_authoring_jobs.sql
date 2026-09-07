CREATE TABLE authoring_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('world_concept', 'character')),
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'running', 'awaiting_review', 'recoverable', 'failed',
    'cancel_requested', 'cancelled', 'applied', 'expired'
  )),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  execution_generation integer NOT NULL DEFAULT 0 CHECK (execution_generation >= 0),
  execution_snapshot jsonb CHECK (execution_snapshot IS NULL OR jsonb_typeof(execution_snapshot) = 'object'),
  reviewed_content jsonb CHECK (reviewed_content IS NULL OR jsonb_typeof(reviewed_content) = 'object'),
  review_generation integer NOT NULL DEFAULT 0 CHECK (review_generation >= 0),
  apply_key text,
  apply_hash text CHECK (apply_hash IS NULL OR apply_hash ~ '^[0-9a-f]{64}$'),
  apply_receipt jsonb CHECK (apply_receipt IS NULL OR jsonb_typeof(apply_receipt) = 'object'),
  last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '7 days',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner_user_id),
  UNIQUE (owner_user_id, idempotency_key)
);

CREATE TABLE authoring_job_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  stage_key text NOT NULL CHECK (btrim(stage_key) <> ''),
  generation integer NOT NULL DEFAULT 1 CHECK (generation >= 1),
  parent_generations jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parent_generations) = 'object'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'validated', 'recoverable', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  output jsonb CHECK (output IS NULL OR jsonb_typeof(output) = 'object'),
  failure jsonb CHECK (failure IS NULL OR jsonb_typeof(failure) = 'object'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, stage_key, generation),
  FOREIGN KEY (job_id, owner_user_id) REFERENCES authoring_jobs(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT authoring_job_stages_lease_check CHECK (
    (status = 'running' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL AND btrim(lease_owner) <> '' AND lease_expires_at IS NOT NULL)
    OR (status <> 'running' AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX authoring_job_stages_claim_idx
  ON authoring_job_stages(status, next_attempt_at, lease_expires_at, created_at, id)
  WHERE status IN ('queued', 'running', 'recoverable');
CREATE INDEX authoring_jobs_owner_status_created_idx ON authoring_jobs(owner_user_id, status, created_at DESC, id DESC);
CREATE INDEX authoring_jobs_expiry_idx ON authoring_jobs(expires_at);
