-- Up Migration

-- The helper keeps array validation inside database constraints without relying
-- on application callers to trim, de-duplicate, or preserve primary precedence.
CREATE FUNCTION provider_model_fallbacks_are_valid(fallback_models text[], primary_model text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(fallback_models) <= 4
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(fallback_models) AS model_id
      WHERE length(btrim(model_id)) = 0 OR model_id = primary_model
    )
    AND cardinality(fallback_models) = (
      SELECT count(DISTINCT model_id)
      FROM unnest(fallback_models) AS model_id
    );
$$;

CREATE FUNCTION openrouter_provider_policy_is_allowed(provider_policy jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT jsonb_typeof(provider_policy) = 'object'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_object_keys(provider_policy) AS policy_key
      WHERE policy_key NOT IN (
        'order', 'only', 'ignore', 'allow_fallbacks', 'require_parameters',
        'data_collection', 'zdr', 'quantizations', 'sort', 'max_price'
      )
    )
    AND provider_policy #>> '{sort,partition}' IS DISTINCT FROM 'none';
$$;

ALTER TABLE provider_profiles
  ADD COLUMN fallback_models text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN routing_source text NOT NULL DEFAULT 'models',
  ADD COLUMN preset_slug text,
  ADD COLUMN preset_designated_version_id text,
  ADD COLUMN preset_version integer,
  ADD COLUMN preset_config_hash text,
  ADD COLUMN preset_provider_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT provider_profiles_fallback_models_check
    CHECK (provider_model_fallbacks_are_valid(fallback_models, default_model)),
  ADD CONSTRAINT provider_profiles_fallback_role_check
    CHECK (cardinality(fallback_models) = 0 OR provider_role IN ('text', 'intent')),
  ADD CONSTRAINT provider_profiles_routing_source_check
    CHECK (routing_source IN ('models', 'openrouter_preset')),
  ADD CONSTRAINT provider_profiles_routing_plan_check CHECK (
    (
      routing_source = 'models'
      AND preset_slug IS NULL
      AND preset_designated_version_id IS NULL
      AND preset_version IS NULL
      AND preset_config_hash IS NULL
      AND preset_provider_policy = '{}'::jsonb
    )
    OR (
      routing_source = 'openrouter_preset'
      AND provider_type = 'openrouter'
      AND provider_role IN ('text', 'intent')
      AND length(btrim(default_model)) > 0
      AND length(btrim(preset_slug)) BETWEEN 1 AND 160
      AND preset_slug ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
      AND length(btrim(preset_designated_version_id)) BETWEEN 1 AND 500
      AND preset_version > 0
      AND preset_config_hash ~ '^[a-f0-9]{64}$'
      AND openrouter_provider_policy_is_allowed(preset_provider_policy)
    )
  );

ALTER TABLE generation_jobs
  ADD COLUMN requested_fallback_models text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN requested_routing_source text NOT NULL DEFAULT 'models',
  ADD COLUMN requested_preset_slug text,
  ADD COLUMN requested_preset_designated_version_id text,
  ADD COLUMN requested_preset_version integer,
  ADD COLUMN requested_preset_config_hash text,
  ADD COLUMN requested_provider_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT generation_jobs_requested_fallback_models_check
    CHECK (provider_model_fallbacks_are_valid(requested_fallback_models, requested_model)),
  ADD CONSTRAINT generation_jobs_requested_routing_source_check
    CHECK (requested_routing_source IN ('models', 'openrouter_preset')),
  ADD CONSTRAINT generation_jobs_requested_routing_plan_check CHECK (
    (
      requested_routing_source = 'models'
      AND requested_preset_slug IS NULL
      AND requested_preset_designated_version_id IS NULL
      AND requested_preset_version IS NULL
      AND requested_preset_config_hash IS NULL
      AND requested_provider_policy = '{}'::jsonb
    )
    OR (
      requested_routing_source = 'openrouter_preset'
      AND length(btrim(requested_model)) > 0
      AND length(btrim(requested_preset_slug)) BETWEEN 1 AND 160
      AND requested_preset_slug ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
      AND length(btrim(requested_preset_designated_version_id)) BETWEEN 1 AND 500
      AND requested_preset_version > 0
      AND requested_preset_config_hash ~ '^[a-f0-9]{64}$'
      AND openrouter_provider_policy_is_allowed(requested_provider_policy)
    )
  );

-- Only jobs that have not reached a terminal outcome can safely inherit a
-- newly-materialized profile plan. Historical completed/failed/recoverable
-- snapshots retain their existing requested model and receive only defaults.
UPDATE generation_jobs AS jobs
SET requested_model = profiles.default_model,
    requested_fallback_models = profiles.fallback_models,
    requested_routing_source = profiles.routing_source,
    requested_preset_slug = profiles.preset_slug,
    requested_preset_designated_version_id = profiles.preset_designated_version_id,
    requested_preset_version = profiles.preset_version,
    requested_preset_config_hash = profiles.preset_config_hash,
    requested_provider_policy = profiles.preset_provider_policy
FROM provider_profiles AS profiles
WHERE jobs.provider_profile_id = profiles.id
  AND jobs.owner_user_id = profiles.owner_user_id
  AND jobs.status IN ('queued', 'replacement_queued', 'assessing', 'generating', 'validating', 'committing')
  AND jobs.requested_model = ''
  AND profiles.default_model <> '';

COMMENT ON COLUMN provider_profiles.fallback_models IS
  'Ordered text or intent fallback model IDs after default_model; at most four and never the primary.';
COMMENT ON COLUMN provider_profiles.routing_source IS
  'Explicit ordered models or a server-validated OpenRouter preset snapshot.';
COMMENT ON COLUMN provider_profiles.preset_provider_policy IS
  'Safe allowlisted OpenRouter routing policy only; raw preset content is never persisted.';
COMMENT ON COLUMN generation_jobs.requested_fallback_models IS
  'Durable ordered fallback snapshot resolved when the generation job was queued.';
COMMENT ON COLUMN generation_jobs.requested_routing_source IS
  'Durable routing source snapshot resolved when the generation job was queued.';
COMMENT ON COLUMN generation_jobs.requested_provider_policy IS
  'Durable safe provider routing policy snapshot; never raw provider configuration.';

-- Down Migration

-- Keep additive routing columns on rollback so an older application cannot
-- erase saved provider selections or durable job audit history.
