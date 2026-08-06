-- Up Migration

-- Durable asset/archive persistence is additive. Existing assets and legacy
-- archive previews remain authoritative for the currently composed services.

CREATE TABLE asset_metadata_backfill_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  asset_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'recoverable', 'completed', 'failed')),
  diagnostic_code text CHECK (diagnostic_code IS NULL OR diagnostic_code IN (
    'asset_content_invalid',
    'asset_hash_mismatch',
    'asset_metadata_unavailable',
    'asset_storage_unavailable',
    'asset_unsupported_media',
    'asset_too_large',
    'filesystem_containment_denied',
    'filesystem_link_denied',
    'filesystem_path_invalid',
    'filesystem_race_detected'
  )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  work_version integer NOT NULL DEFAULT 1 CHECK (work_version > 0),
  lease_id uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (asset_id, owner_user_id),
  FOREIGN KEY (asset_id, owner_user_id) REFERENCES assets(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT asset_metadata_backfill_lease_check CHECK (
    (status = 'running'
      AND lease_id IS NOT NULL
      AND lease_owner IS NOT NULL
      AND btrim(lease_owner) <> ''
      AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'running'
      AND lease_id IS NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL)
  ),
  CONSTRAINT asset_metadata_backfill_completed_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);

CREATE INDEX asset_metadata_backfill_claim_idx
  ON asset_metadata_backfill_jobs(status, next_attempt_at, lease_expires_at, created_at, id)
  WHERE status IN ('queued', 'running', 'recoverable');

CREATE TABLE asset_mutation_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  mutation_kind text NOT NULL CHECK (mutation_kind IN (
    'asset_metadata_update', 'turn_asset_selection', 'world_asset_selection'
  )),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  target_asset_id uuid,
  campaign_id uuid,
  turn_id uuid,
  world_id uuid,
  selected_asset_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (owner_user_id, mutation_kind, idempotency_key_hash),
  FOREIGN KEY (target_asset_id, owner_user_id) REFERENCES assets(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id, campaign_id, owner_user_id)
    REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id, owner_user_id) REFERENCES worlds(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (selected_asset_id, owner_user_id) REFERENCES assets(id, owner_user_id),
  CONSTRAINT asset_mutation_scope_check CHECK (
    (mutation_kind = 'asset_metadata_update'
      AND target_asset_id IS NOT NULL
      AND campaign_id IS NULL
      AND turn_id IS NULL
      AND world_id IS NULL
      AND selected_asset_id IS NULL)
    OR
    (mutation_kind = 'turn_asset_selection'
      AND target_asset_id IS NULL
      AND campaign_id IS NOT NULL
      AND turn_id IS NOT NULL
      AND world_id IS NULL)
    OR
    (mutation_kind = 'world_asset_selection'
      AND target_asset_id IS NULL
      AND campaign_id IS NULL
      AND turn_id IS NULL
      AND world_id IS NOT NULL)
  ),
  CONSTRAINT asset_mutation_completion_check CHECK (
    (status = 'pending' AND completed_at IS NULL)
    OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX asset_mutation_target_idx
  ON asset_mutation_idempotency(owner_user_id, mutation_kind, target_asset_id, campaign_id, turn_id, world_id);

CREATE TABLE durable_filesystem_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  operation_token_hash text NOT NULL UNIQUE CHECK (operation_token_hash ~ '^[0-9a-f]{64}$'),
  purpose text NOT NULL CHECK (purpose IN (
    'asset_original', 'asset_derivative', 'portable_staging', 'portable_export'
  )),
  resource_kind text NOT NULL CHECK (resource_kind IN ('asset', 'portable')),
  asset_id uuid,
  operation_scope_hash text CHECK (operation_scope_hash IS NULL OR operation_scope_hash ~ '^[0-9a-f]{64}$'),
  lifecycle text NOT NULL DEFAULT 'reserved'
    CHECK (lifecycle IN ('reserved', 'attached', 'finalized', 'cleanup_pending', 'cleaned')),
  candidate_token_hash text CHECK (candidate_token_hash IS NULL OR candidate_token_hash ~ '^[0-9a-f]{64}$'),
  locator_token_hash text CHECK (locator_token_hash IS NULL OR locator_token_hash ~ '^[0-9a-f]{64}$'),
  diagnostic_code text CHECK (diagnostic_code IS NULL OR diagnostic_code IN (
    'asset_content_invalid',
    'asset_hash_mismatch',
    'asset_metadata_unavailable',
    'asset_storage_unavailable',
    'asset_unsupported_media',
    'asset_too_large',
    'filesystem_containment_denied',
    'filesystem_link_denied',
    'filesystem_path_invalid',
    'filesystem_race_detected'
  )),
  lease_id uuid NOT NULL,
  lease_owner text NOT NULL CHECK (btrim(lease_owner) <> ''),
  work_version integer NOT NULL DEFAULT 1 CHECK (work_version > 0),
  lease_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attached_at timestamptz,
  finalized_at timestamptz,
  cleanup_requested_at timestamptz,
  cleaned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_user_id),
  UNIQUE (id, owner_user_id, purpose),
  FOREIGN KEY (asset_id, owner_user_id)
    REFERENCES assets(id, owner_user_id) ON DELETE RESTRICT,
  CONSTRAINT durable_filesystem_scope_check CHECK (
    (resource_kind = 'asset'
      AND purpose IN ('asset_original', 'asset_derivative')
      AND asset_id IS NOT NULL
      AND operation_scope_hash IS NULL)
    OR
    (resource_kind = 'portable'
      AND purpose IN ('portable_staging', 'portable_export')
      AND asset_id IS NULL
      AND operation_scope_hash IS NOT NULL)
  ),
  CONSTRAINT durable_filesystem_attachment_check CHECK (
    (lifecycle = 'reserved'
      AND candidate_token_hash IS NULL
      AND locator_token_hash IS NULL
      AND attached_at IS NULL)
    OR lifecycle IN ('cleanup_pending', 'cleaned')
    OR
    (lifecycle IN ('attached', 'finalized')
      AND candidate_token_hash IS NOT NULL
      AND locator_token_hash IS NOT NULL
      AND attached_at IS NOT NULL)
  ),
  CONSTRAINT durable_filesystem_terminal_check CHECK (
    (lifecycle = 'finalized' AND finalized_at IS NOT NULL AND cleaned_at IS NULL)
    OR (lifecycle = 'cleaned' AND cleaned_at IS NOT NULL)
    OR lifecycle IN ('reserved', 'attached', 'cleanup_pending')
  )
);

CREATE UNIQUE INDEX durable_filesystem_candidate_hash_idx
  ON durable_filesystem_operations(candidate_token_hash) WHERE candidate_token_hash IS NOT NULL;
CREATE UNIQUE INDEX durable_filesystem_locator_hash_idx
  ON durable_filesystem_operations(locator_token_hash) WHERE locator_token_hash IS NOT NULL;
CREATE INDEX durable_filesystem_operations_recovery_idx
  ON durable_filesystem_operations(lifecycle, lease_expires_at, expires_at, created_at, id)
  WHERE lifecycle IN ('reserved', 'attached', 'cleanup_pending');

CREATE FUNCTION enforce_durable_filesystem_operation_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.operation_token_hash IS DISTINCT FROM NEW.operation_token_hash
    OR OLD.purpose IS DISTINCT FROM NEW.purpose
    OR OLD.resource_kind IS DISTINCT FROM NEW.resource_kind
    OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
    OR OLD.operation_scope_hash IS DISTINCT FROM NEW.operation_scope_hash
    OR (OLD.candidate_token_hash IS NOT NULL
      AND OLD.candidate_token_hash IS DISTINCT FROM NEW.candidate_token_hash)
    OR (OLD.locator_token_hash IS NOT NULL
      AND OLD.locator_token_hash IS DISTINCT FROM NEW.locator_token_hash)
  THEN
    RAISE EXCEPTION 'durable filesystem operation authority is write-once'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER durable_filesystem_operations_authority_trigger
BEFORE UPDATE ON durable_filesystem_operations
FOR EACH ROW EXECUTE FUNCTION enforce_durable_filesystem_operation_authority();

-- Filesystem identities are append-only evidence. Repositories update the
-- operation lifecycle but never rewrite a descriptor after attachment.
CREATE TABLE durable_filesystem_descriptors (
  operation_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  descriptor_role text NOT NULL CHECK (descriptor_role IN ('delivery', 'cleanup')),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  relative_path text NOT NULL CHECK (
    relative_path <> ''
    AND relative_path !~ '(^/|^[A-Za-z]:|^\\\\|\\\\|(^|/)\.\.?(/|$))'
  ),
  device_id text NOT NULL CHECK (btrim(device_id) <> ''),
  file_id text NOT NULL CHECK (btrim(file_id) <> ''),
  change_token text NOT NULL CHECK (btrim(change_token) <> ''),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, descriptor_role, ordinal),
  UNIQUE (operation_id, owner_user_id, descriptor_role, ordinal),
  FOREIGN KEY (operation_id, owner_user_id)
    REFERENCES durable_filesystem_operations(id, owner_user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX durable_filesystem_delivery_descriptor_idx
  ON durable_filesystem_descriptors(operation_id) WHERE descriptor_role = 'delivery';

CREATE FUNCTION reject_durable_filesystem_descriptor_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'durable filesystem descriptors are immutable';
END;
$$;

CREATE TRIGGER durable_filesystem_descriptors_immutable_trigger
BEFORE UPDATE OR DELETE ON durable_filesystem_descriptors
FOR EACH ROW EXECUTE FUNCTION reject_durable_filesystem_descriptor_mutation();

CREATE TABLE portable_staged_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  handle_token_hash text NOT NULL UNIQUE CHECK (handle_token_hash ~ '^[0-9a-f]{64}$'),
  filesystem_operation_id uuid NOT NULL,
  filesystem_operation_purpose text GENERATED ALWAYS AS ('portable_staging'::text) STORED,
  status text NOT NULL DEFAULT 'staged'
    CHECK (status IN ('staged', 'consumed', 'expired', 'failed', 'cleanup_pending', 'cleaned')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_user_id),
  FOREIGN KEY (filesystem_operation_id, owner_user_id, filesystem_operation_purpose)
    REFERENCES durable_filesystem_operations(id, owner_user_id, purpose),
  CONSTRAINT portable_staged_consumption_check CHECK (
    (status = 'staged' AND consumed_at IS NULL)
    OR status IN ('expired', 'failed', 'cleanup_pending', 'cleaned')
    OR (status = 'consumed' AND consumed_at IS NOT NULL)
  )
);

CREATE INDEX portable_staged_inputs_expiry_idx
  ON portable_staged_inputs(status, expires_at, created_at, id)
  WHERE status IN ('staged', 'expired', 'cleanup_pending');

CREATE TABLE portable_import_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  staged_input_id uuid NOT NULL,
  import_kind text NOT NULL CHECK (import_kind IN (
    'campaign_zip', 'legacy_story', 'infinite_worlds', 'cyoa', 'world_json', 'world_text', 'story_text'
  )),
  preview_token_hash text NOT NULL UNIQUE CHECK (preview_token_hash ~ '^[0-9a-f]{64}$'),
  result_retrieval_token_hash text
    CHECK (result_retrieval_token_hash IS NULL OR result_retrieval_token_hash ~ '^[0-9a-f]{64}$'),
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
  destination_fingerprint text NOT NULL CHECK (destination_fingerprint ~ '^[0-9a-f]{64}$'),
  destination_kind text NOT NULL CHECK (destination_kind IN (
    'embedded_create_world', 'existing_world_version', 'create_world'
  )),
  destination_world_id uuid,
  destination_world_version_id uuid,
  source_installation_id text,
  source_record_id text,
  status text NOT NULL DEFAULT 'previewed' CHECK (status IN (
    'previewed', 'superseded', 'consuming', 'committed', 'expired', 'failed', 'cleanup_pending', 'cleaned'
  )),
  preview_projection jsonb NOT NULL,
  diagnostic_codes text[] NOT NULL DEFAULT '{}'
    CHECK (
      array_position(diagnostic_codes, NULL) IS NULL
      AND diagnostic_codes <@ ARRAY[
        'archive_cleanup_required',
        'archive_containment_denied',
        'archive_entry_limit_exceeded',
        'archive_expired',
        'archive_format_invalid',
        'archive_link_denied',
        'archive_path_invalid',
        'archive_size_limit_exceeded',
        'archive_truncated',
        'archive_unavailable',
        'import_conflict',
        'import_idempotency_mismatch',
        'import_invalid',
        'transaction_unavailable'
      ]::text[]
    ),
  idempotency_key_hash text CHECK (idempotency_key_hash IS NULL OR idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  commit_request_fingerprint text
    CHECK (commit_request_fingerprint IS NULL OR commit_request_fingerprint ~ '^[0-9a-f]{64}$'),
  import_id uuid,
  result_projection jsonb,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_user_id),
  FOREIGN KEY (staged_input_id, owner_user_id)
    REFERENCES portable_staged_inputs(id, owner_user_id),
  FOREIGN KEY (destination_world_id, owner_user_id)
    REFERENCES worlds(id, owner_user_id),
  FOREIGN KEY (destination_world_version_id, owner_user_id)
    REFERENCES world_versions(id, owner_user_id),
  FOREIGN KEY (import_id) REFERENCES imports(id),
  CONSTRAINT portable_import_kind_destination_check CHECK (
    (import_kind = 'campaign_zip' AND destination_kind IN ('embedded_create_world', 'existing_world_version'))
    OR (import_kind IN ('legacy_story', 'story_text') AND destination_kind = 'existing_world_version')
    OR (import_kind IN ('infinite_worlds', 'cyoa', 'world_json', 'world_text') AND destination_kind = 'create_world')
  ),
  CONSTRAINT portable_import_destination_scope_check CHECK (
    (destination_kind = 'existing_world_version'
      AND destination_world_id IS NOT NULL
      AND destination_world_version_id IS NOT NULL)
    OR
    (destination_kind IN ('embedded_create_world', 'create_world')
      AND destination_world_id IS NULL
      AND destination_world_version_id IS NULL)
  ),
  CONSTRAINT portable_import_idempotency_check CHECK (
    (idempotency_key_hash IS NULL AND commit_request_fingerprint IS NULL)
    OR (idempotency_key_hash IS NOT NULL AND commit_request_fingerprint IS NOT NULL)
  ),
  CONSTRAINT portable_import_commit_check CHECK (
    (status = 'committed'
      AND idempotency_key_hash IS NOT NULL
      AND result_retrieval_token_hash IS NOT NULL
      AND import_id IS NOT NULL
      AND result_projection IS NOT NULL
      AND completed_at IS NOT NULL)
    OR status <> 'committed'
  )
);

CREATE UNIQUE INDEX portable_import_result_retrieval_hash_idx
  ON portable_import_operations(result_retrieval_token_hash)
  WHERE result_retrieval_token_hash IS NOT NULL;
CREATE UNIQUE INDEX portable_import_idempotency_idx
  ON portable_import_operations(owner_user_id, import_kind, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;
CREATE UNIQUE INDEX portable_import_live_preview_idx
  ON portable_import_operations(owner_user_id, import_kind, content_fingerprint, destination_fingerprint)
  WHERE status = 'previewed';
CREATE INDEX portable_import_operations_expiry_idx
  ON portable_import_operations(status, expires_at, created_at, id)
  WHERE status IN ('previewed', 'superseded', 'expired', 'cleanup_pending');

COMMENT ON COLUMN portable_import_operations.source_installation_id IS
  'Opaque source provenance only. It is never a local owner or authorization key.';
COMMENT ON COLUMN portable_import_operations.source_record_id IS
  'Opaque source-record provenance only. It is never a local foreign key or authorization key.';

CREATE FUNCTION validate_portable_import_operation_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.destination_kind = 'existing_world_version' THEN
    PERFORM 1
      FROM world_versions
     WHERE id = NEW.destination_world_version_id
       AND world_id = NEW.destination_world_id
       AND owner_user_id = NEW.owner_user_id
       FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'portable import destination world/version scope is invalid'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF NEW.import_id IS NOT NULL THEN
    PERFORM 1
      FROM imports
     WHERE id = NEW.import_id
       AND owner_user_id = NEW.owner_user_id
       FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'portable import result owner scope is invalid'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portable_import_operations_scope_trigger
BEFORE INSERT OR UPDATE ON portable_import_operations
FOR EACH ROW EXECUTE FUNCTION validate_portable_import_operation_scope();

CREATE TABLE portable_export_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  retrieval_token_hash text NOT NULL UNIQUE CHECK (retrieval_token_hash ~ '^[0-9a-f]{64}$'),
  filesystem_operation_id uuid NOT NULL,
  filesystem_operation_purpose text GENERATED ALWAYS AS ('portable_export'::text) STORED,
  export_kind text NOT NULL CHECK (export_kind IN ('campaign_zip', 'world_json')),
  campaign_id uuid,
  world_id uuid NOT NULL,
  world_version_id uuid NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('application/zip', 'application/json')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'consumed', 'expired', 'failed', 'cleanup_pending', 'cleaned')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_user_id),
  FOREIGN KEY (filesystem_operation_id, owner_user_id, filesystem_operation_purpose)
    REFERENCES durable_filesystem_operations(id, owner_user_id, purpose),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id),
  FOREIGN KEY (world_id, owner_user_id) REFERENCES worlds(id, owner_user_id),
  FOREIGN KEY (world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id),
  CONSTRAINT portable_export_scope_check CHECK (
    (export_kind = 'campaign_zip' AND campaign_id IS NOT NULL AND content_type = 'application/zip')
    OR (export_kind = 'world_json' AND campaign_id IS NULL AND content_type = 'application/json')
  )
);

CREATE INDEX portable_export_artifacts_expiry_idx
  ON portable_export_artifacts(status, expires_at, created_at, id)
  WHERE status IN ('ready', 'expired', 'cleanup_pending');

CREATE FUNCTION validate_portable_export_artifact_scope() RETURNS trigger
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
  ELSE
    PERFORM 1
      FROM world_versions
     WHERE id = NEW.world_version_id
       AND world_id = NEW.world_id
       AND owner_user_id = NEW.owner_user_id
       FOR NO KEY UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'portable export campaign/world/version scope is invalid'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portable_export_artifacts_scope_trigger
BEFORE INSERT OR UPDATE ON portable_export_artifacts
FOR EACH ROW EXECUTE FUNCTION validate_portable_export_artifact_scope();

CREATE FUNCTION protect_portable_scope_parent_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'imports' THEN
    IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      AND EXISTS (
        SELECT 1 FROM portable_import_operations WHERE import_id = OLD.id
      )
    THEN
      RAISE EXCEPTION 'referenced import owner scope is immutable'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'world_versions' THEN
    IF (OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      OR OLD.world_id IS DISTINCT FROM NEW.world_id)
      AND (
        EXISTS (
          SELECT 1 FROM portable_import_operations
           WHERE destination_world_version_id = OLD.id
        )
        OR EXISTS (
          SELECT 1 FROM portable_export_artifacts WHERE world_version_id = OLD.id
        )
      )
    THEN
      RAISE EXCEPTION 'referenced world version portable scope is immutable'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'campaigns' THEN
    IF (OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      OR OLD.world_version_id IS DISTINCT FROM NEW.world_version_id)
      AND EXISTS (
        SELECT 1 FROM portable_export_artifacts WHERE campaign_id = OLD.id
      )
    THEN
      RAISE EXCEPTION 'referenced campaign portable scope is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER imports_portable_scope_parent_trigger
BEFORE UPDATE ON imports
FOR EACH ROW EXECUTE FUNCTION protect_portable_scope_parent_update();

CREATE TRIGGER world_versions_portable_scope_parent_trigger
BEFORE UPDATE ON world_versions
FOR EACH ROW EXECUTE FUNCTION protect_portable_scope_parent_update();

CREATE TRIGGER campaigns_portable_scope_parent_trigger
BEFORE UPDATE ON campaigns
FOR EACH ROW EXECUTE FUNCTION protect_portable_scope_parent_update();

-- Pre-migration path-only rows have no persisted filesystem identity and must
-- never unlink a path which may now name a replacement. New compatibility rows
-- keep the live path cleanup contract until the secure staging cutover.
ALTER TABLE archive_previews
  ADD COLUMN storage_security_state text NOT NULL DEFAULT 'legacy_path_v1',
  ADD COLUMN secure_staged_input_id uuid,
  ADD COLUMN legacy_drain_policy text NOT NULL DEFAULT 'live_path_cleanup_compatibility',
  ADD CONSTRAINT archive_previews_storage_security_state_check
    CHECK (storage_security_state IN ('legacy_path_v1', 'identity_bound_v2')) NOT VALID,
  ADD CONSTRAINT archive_previews_legacy_drain_policy_check
    CHECK (legacy_drain_policy IN (
      'retain_until_secure_cleanup', 'live_path_cleanup_compatibility'
    )) NOT VALID,
  ADD CONSTRAINT archive_previews_secure_staged_owner_fk
    FOREIGN KEY (secure_staged_input_id, owner_user_id)
    REFERENCES portable_staged_inputs(id, owner_user_id) NOT VALID,
  ADD CONSTRAINT archive_previews_storage_security_check CHECK (
    (storage_security_state = 'legacy_path_v1' AND secure_staged_input_id IS NULL)
    OR (storage_security_state = 'identity_bound_v2' AND secure_staged_input_id IS NOT NULL)
  ) NOT VALID;

UPDATE archive_previews
   SET legacy_drain_policy = 'retain_until_secure_cleanup';

COMMENT ON COLUMN archive_previews.storage_security_state IS
  'legacy_path_v1 rows are path-only compatibility records; identity_bound_v2 requires an explicit secure staged-input migration.';
COMMENT ON COLUMN archive_previews.legacy_drain_policy IS
  'Pre-migration path-only rows are retained because unlinking without persisted identity could delete a replacement.';

-- Seed durable jobs without making existing asset rows reaper candidates.
-- Historical failure text is reduced to one generic allowlisted code while
-- retaining the legacy key so the currently composed worker will not retry it.
INSERT INTO asset_metadata_backfill_jobs (
  owner_user_id, asset_id, status, diagnostic_code, next_attempt_at
)
SELECT assets.owner_user_id,
       assets.id,
       CASE WHEN assets.technical_metadata ? 'backfillError' THEN 'recoverable' ELSE 'queued' END,
       CASE WHEN assets.technical_metadata ? 'backfillError' THEN 'asset_metadata_unavailable' ELSE NULL END,
       now()
  FROM assets
 WHERE assets.pixel_width IS NULL
    OR assets.pixel_height IS NULL
    OR NOT EXISTS (
      SELECT 1
        FROM asset_derivatives derivatives
       WHERE derivatives.owner_user_id = assets.owner_user_id
         AND derivatives.source_asset_id = assets.id
         AND derivatives.derivative_kind = 'thumbnail'
         AND derivatives.transform_version = 1
    )
ON CONFLICT (asset_id, owner_user_id) DO NOTHING;

UPDATE assets
   SET technical_metadata = jsonb_set(
     technical_metadata,
     '{backfillError}',
     to_jsonb('asset_metadata_unavailable'::text),
     true
   )
 WHERE technical_metadata ? 'backfillError';

-- Down Migration

ALTER TABLE archive_previews
  DROP CONSTRAINT IF EXISTS archive_previews_storage_security_check,
  DROP CONSTRAINT IF EXISTS archive_previews_secure_staged_owner_fk,
  DROP CONSTRAINT IF EXISTS archive_previews_legacy_drain_policy_check,
  DROP CONSTRAINT IF EXISTS archive_previews_storage_security_state_check,
  DROP COLUMN IF EXISTS legacy_drain_policy,
  DROP COLUMN IF EXISTS secure_staged_input_id,
  DROP COLUMN IF EXISTS storage_security_state;

DROP TRIGGER IF EXISTS imports_portable_scope_parent_trigger ON imports;
DROP TRIGGER IF EXISTS world_versions_portable_scope_parent_trigger ON world_versions;
DROP TRIGGER IF EXISTS campaigns_portable_scope_parent_trigger ON campaigns;
DROP FUNCTION IF EXISTS protect_portable_scope_parent_update();

DROP TRIGGER IF EXISTS portable_export_artifacts_scope_trigger
  ON portable_export_artifacts;
DROP FUNCTION IF EXISTS validate_portable_export_artifact_scope();
DROP TRIGGER IF EXISTS portable_import_operations_scope_trigger
  ON portable_import_operations;
DROP FUNCTION IF EXISTS validate_portable_import_operation_scope();

DROP TABLE IF EXISTS portable_export_artifacts;
DROP TABLE IF EXISTS portable_import_operations;
DROP TABLE IF EXISTS portable_staged_inputs;
DROP TRIGGER IF EXISTS durable_filesystem_descriptors_immutable_trigger
  ON durable_filesystem_descriptors;
DROP FUNCTION IF EXISTS reject_durable_filesystem_descriptor_mutation();
DROP TABLE IF EXISTS durable_filesystem_descriptors;
DROP TRIGGER IF EXISTS durable_filesystem_operations_authority_trigger
  ON durable_filesystem_operations;
DROP FUNCTION IF EXISTS enforce_durable_filesystem_operation_authority();
DROP TABLE IF EXISTS durable_filesystem_operations;
DROP TABLE IF EXISTS asset_mutation_idempotency;
DROP TABLE IF EXISTS asset_metadata_backfill_jobs;
