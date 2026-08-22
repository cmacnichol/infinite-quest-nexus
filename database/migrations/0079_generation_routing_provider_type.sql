-- Up Migration

-- Provider type is part of a model-plan execution descriptor.  Backfill it
-- once so workers never need to consult mutable profile routing state.
ALTER TABLE generation_jobs
  ADD COLUMN requested_provider_type text;

UPDATE generation_jobs AS jobs
SET requested_provider_type = profiles.provider_type
FROM provider_profiles AS profiles
WHERE jobs.requested_provider_type IS NULL
  AND jobs.provider_profile_id = profiles.id
  AND jobs.owner_user_id = profiles.owner_user_id;

COMMENT ON COLUMN generation_jobs.requested_provider_type IS
  'Durable provider-type component of the snapshotted text model routing plan.';

-- Down Migration

-- Retain the additive snapshot on rollback so queued or historical jobs keep
-- their routing provenance.
