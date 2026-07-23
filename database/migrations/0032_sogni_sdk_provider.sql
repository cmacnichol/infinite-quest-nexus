-- Add the SDK-backed Sogni provider after the context-aware image library migration.
ALTER TABLE provider_profiles
  DROP CONSTRAINT IF EXISTS provider_profiles_provider_type_check,
  ADD CONSTRAINT provider_profiles_provider_type_check CHECK (
    provider_type IN ('lmstudio', 'openrouter', 'manifest', 'openai_compatible', 'sogni', 'sogni_sdk')
  );

UPDATE provider_profiles
   SET configuration = configuration - 'sensitiveContentFilter' - 'workflowSafeContentFilterSupported',
       updated_at = now()
 WHERE provider_type = 'sogni'
   AND (configuration ? 'sensitiveContentFilter' OR configuration ? 'workflowSafeContentFilterSupported');

ALTER TABLE image_jobs
  ADD COLUMN IF NOT EXISTS provider_queue_position integer CHECK (provider_queue_position >= 0),
  ADD COLUMN IF NOT EXISTS provider_eta_at timestamptz;

COMMENT ON COLUMN image_jobs.provider_queue_position IS
  'Best-effort provider queue position for user-visible image generation status.';
COMMENT ON COLUMN image_jobs.provider_eta_at IS
  'Best-effort provider ETA. Durable completion never depends on this value.';
