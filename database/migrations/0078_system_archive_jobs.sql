-- System Archive work is operational and never portable. Jobs retain only hashed
-- idempotency authority plus owner-scoped links to existing portable staging and
-- artifact records.

ALTER TABLE portable_export_artifacts
  DROP CONSTRAINT portable_export_artifacts_export_kind_check,
  DROP CONSTRAINT portable_export_scope_check,
  ALTER COLUMN world_id DROP NOT NULL,
  ALTER COLUMN world_version_id DROP NOT NULL;

ALTER TABLE portable_export_artifacts
  ADD CONSTRAINT portable_export_artifacts_export_kind_check
    CHECK (export_kind IN ('campaign_zip', 'world_json', 'system_zip')),
  ADD CONSTRAINT portable_export_scope_check CHECK (
    (export_kind = 'campaign_zip'
      AND campaign_id IS NOT NULL
      AND world_id IS NOT NULL
      AND world_version_id IS NOT NULL
      AND content_type = 'application/zip')
    OR
    (export_kind = 'world_json'
      AND campaign_id IS NULL
      AND world_id IS NOT NULL
      AND world_version_id IS NOT NULL
      AND content_type = 'application/json')
    OR
    (export_kind = 'system_zip'
      AND campaign_id IS NULL
      AND world_id IS NULL
      AND world_version_id IS NULL
      AND content_type = 'application/zip')
  );

CREATE OR REPLACE FUNCTION validate_portable_export_artifact_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.export_kind = 'campaign_zip' THEN
    PERFORM 1
      FROM campaigns campaigns
      JOIN world_versions versions
        ON versions.id = campaigns.world_version_id
       AND versions.owner_user_id = campaigns.owner_user_id
     WHERE campaigns.id = NEW.campaign_id
       AND campaigns.owner_user_id = NEW.owner_user_id
       AND campaigns.world_version_id = NEW.world_version_id
       AND versions.id = NEW.world_version_id
       AND versions.world_id = NEW.world_id
       AND versions.owner_user_id = NEW.owner_user_id
       FOR NO KEY UPDATE OF campaigns, versions;
  ELSIF NEW.export_kind = 'world_json' THEN
    PERFORM 1
      FROM world_versions
     WHERE id = NEW.world_version_id
       AND world_id = NEW.world_id
       AND owner_user_id = NEW.owner_user_id
       FOR NO KEY UPDATE;
  ELSE
    RETURN NEW;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'portable export campaign/world/version scope is invalid'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE system_archive_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('export', 'import')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'capturing', 'writing', 'verifying', 'published',
    'uploading', 'validating', 'previewed', 'revalidating',
    'waiting_for_gate', 'importing', 'authoritative_committed',
    'rebuilding', 'completed', 'cancelling', 'cancelled',
    'rolled_back', 'failed', 'expired'
  )),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  staged_input_id uuid,
  export_artifact_id uuid,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(progress) = 'object'),
  report jsonb CHECK (report IS NULL OR jsonb_typeof(report) = 'object'),
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_user_id),
  UNIQUE (owner_user_id, kind, idempotency_key_hash),
  FOREIGN KEY (staged_input_id, owner_user_id)
    REFERENCES portable_staged_inputs(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (export_artifact_id, owner_user_id)
    REFERENCES portable_export_artifacts(id, owner_user_id) ON DELETE RESTRICT,
  CONSTRAINT system_archive_jobs_resource_scope_check CHECK (
    (kind = 'export' AND staged_input_id IS NULL)
    OR (kind = 'import' AND staged_input_id IS NOT NULL AND export_artifact_id IS NULL)
  ),
  CONSTRAINT system_archive_jobs_published_artifact_check CHECK (
    kind <> 'export' OR status <> 'published' OR export_artifact_id IS NOT NULL
  ),
  CONSTRAINT system_archive_jobs_lease_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_owner IS NOT NULL
      AND btrim(lease_owner) <> ''
      AND lease_expires_at IS NOT NULL
      AND status IN (
        'capturing', 'writing', 'verifying', 'uploading', 'validating',
        'revalidating', 'waiting_for_gate', 'importing',
        'authoritative_committed', 'rebuilding', 'cancelling'
      ))
  )
);

CREATE UNIQUE INDEX system_archive_jobs_one_active_export_per_owner_idx
  ON system_archive_jobs(owner_user_id)
  WHERE kind = 'export' AND status IN (
    'queued', 'capturing', 'writing', 'verifying', 'cancelling'
  );

CREATE UNIQUE INDEX system_archive_jobs_one_active_import_idx
  ON system_archive_jobs((kind))
  WHERE kind = 'import' AND status IN (
    'queued', 'uploading', 'validating', 'previewed', 'revalidating',
    'waiting_for_gate', 'importing', 'authoritative_committed',
    'rebuilding', 'cancelling'
  );

CREATE INDEX system_archive_jobs_claim_idx
  ON system_archive_jobs(status, lease_expires_at, created_at, id)
  WHERE status IN (
    'queued', 'capturing', 'writing', 'verifying', 'uploading', 'validating',
    'revalidating', 'waiting_for_gate', 'importing',
    'authoritative_committed', 'rebuilding', 'cancelling'
  );

CREATE FUNCTION enforce_system_archive_job_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.id IS DISTINCT FROM NEW.id
      OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      OR OLD.kind IS DISTINCT FROM NEW.kind
      OR OLD.idempotency_key_hash IS DISTINCT FROM NEW.idempotency_key_hash
      OR OLD.staged_input_id IS DISTINCT FROM NEW.staged_input_id
      OR (OLD.export_artifact_id IS NOT NULL
        AND OLD.export_artifact_id IS DISTINCT FROM NEW.export_artifact_id)
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'system archive job authority is write-once'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.staged_input_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD.staged_input_id IS DISTINCT FROM NEW.staged_input_id)
  THEN
    PERFORM 1
      FROM portable_staged_inputs
     WHERE id = NEW.staged_input_id
       AND owner_user_id = NEW.owner_user_id
       AND status = 'staged'
     FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'system archive import staged-input scope is invalid'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF NEW.export_artifact_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD.export_artifact_id IS DISTINCT FROM NEW.export_artifact_id)
  THEN
    PERFORM 1
      FROM portable_export_artifacts
     WHERE id = NEW.export_artifact_id
       AND owner_user_id = NEW.owner_user_id
       AND export_kind = 'system_zip'
       AND status = 'ready'
     FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'system archive export artifact scope is invalid'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER system_archive_jobs_scope_trigger
BEFORE INSERT OR UPDATE ON system_archive_jobs
FOR EACH ROW EXECUTE FUNCTION enforce_system_archive_job_scope();
