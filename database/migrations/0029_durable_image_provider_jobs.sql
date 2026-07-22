ALTER TABLE provider_profiles
  DROP CONSTRAINT provider_profiles_provider_type_check,
  ADD CONSTRAINT provider_profiles_provider_type_check CHECK (
    provider_type IN ('lmstudio', 'openrouter', 'manifest', 'openai_compatible', 'sogni')
  ),
  DROP CONSTRAINT provider_profiles_request_timeout_ms_check,
  ADD CONSTRAINT provider_profiles_request_timeout_ms_check CHECK (
    request_timeout_ms BETWEEN 5000 AND 3600000
  );

ALTER TABLE image_jobs
  DROP CONSTRAINT image_jobs_status_check;

ALTER TABLE image_jobs
  ADD CONSTRAINT image_jobs_status_check CHECK (status IN (
    'queued', 'generating', 'provider_pending', 'downloading', 'completed', 'recoverable', 'failed', 'cancelled', 'expired'
  )),
  ADD COLUMN provider_type text,
  ADD COLUMN generation_revision integer NOT NULL DEFAULT 0 CHECK (generation_revision >= 0),
  ADD COLUMN remote_job_id text,
  ADD COLUMN provider_status text,
  ADD COLUMN provider_progress numeric(5,2) CHECK (provider_progress BETWEEN 0 AND 100),
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN last_polled_at timestamptz,
  ADD COLUMN next_poll_at timestamptz,
  ADD COLUMN generation_deadline timestamptz,
  ADD COLUMN provider_request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN provider_result_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN usage_quantity numeric,
  ADD COLUMN usage_unit text,
  ADD COLUMN reported_cost numeric,
  ADD COLUMN reported_currency text;

UPDATE image_jobs jobs
   SET provider_type = profiles.provider_type
  FROM provider_profiles profiles
 WHERE profiles.id = jobs.provider_profile_id
   AND profiles.owner_user_id = jobs.owner_user_id;

ALTER TABLE image_jobs ALTER COLUMN provider_type SET NOT NULL;

CREATE UNIQUE INDEX image_jobs_remote_provider_job_idx
  ON image_jobs(provider_profile_id, remote_job_id)
  WHERE remote_job_id IS NOT NULL;

DROP INDEX image_jobs_one_active_turn_idx;
CREATE UNIQUE INDEX image_jobs_one_active_turn_idx
  ON image_jobs(turn_id)
  WHERE status IN ('queued', 'generating', 'provider_pending', 'downloading');

DROP INDEX image_jobs_claim_idx;
CREATE INDEX image_jobs_claim_idx
  ON image_jobs(status, next_attempt_at, next_poll_at, created_at)
  WHERE status IN ('queued', 'generating', 'provider_pending', 'downloading');

COMMENT ON COLUMN image_jobs.remote_job_id IS
  'Durable provider-side generation identifier. A worker must poll rather than resubmit whenever this is present.';
COMMENT ON COLUMN image_jobs.provider_request_metadata IS
  'Sanitized, non-secret request lifecycle metadata. Never contains credentials or story-engine private reasoning.';
COMMENT ON COLUMN image_jobs.provider_result_metadata IS
  'Sanitized provider result metadata. Temporary artifact URLs must be removed after assets are stored.';
