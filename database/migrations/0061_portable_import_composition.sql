-- Up Migration

-- Safe preview JSON remains the public projection. These columns retain the
-- complete, normalized commit authority privately so a restart never rebuilds
-- domain mutations from a lossy preview or from staged raw bytes.
ALTER TABLE portable_import_operations
  ADD COLUMN normalized_payload jsonb,
  ADD COLUMN authority_fingerprint text
    CHECK (authority_fingerprint IS NULL OR authority_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN provider_configuration_fingerprint text
    CHECK (provider_configuration_fingerprint IS NULL OR provider_configuration_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN selected_character_id text
    CHECK (selected_character_id IS NULL OR length(selected_character_id) BETWEEN 1 AND 512),
  ADD CONSTRAINT portable_import_private_authority_check CHECK (
    (normalized_payload IS NULL AND authority_fingerprint IS NULL)
    OR
    (normalized_payload IS NOT NULL
      AND jsonb_typeof(normalized_payload) = 'object'
      AND octet_length(normalized_payload::text) <= 16777216
      AND authority_fingerprint IS NOT NULL)
  );

CREATE FUNCTION portable_import_normalized_payload_is_safe(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  WITH RECURSIVE nodes(value) AS (
    SELECT value
    UNION ALL
    SELECT child.value
      FROM nodes parent
      CROSS JOIN LATERAL (
        SELECT object_value AS value
          FROM jsonb_each(CASE WHEN jsonb_typeof(parent.value) = 'object' THEN parent.value ELSE '{}'::jsonb END)
             AS object_child(object_key, object_value)
        UNION ALL
        SELECT array_value AS value
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(parent.value) = 'array' THEN parent.value ELSE '[]'::jsonb END)
             AS array_child(array_value)
      ) child
  ), keys AS (
    SELECT object_key
      FROM nodes
      CROSS JOIN LATERAL jsonb_each(
        CASE WHEN jsonb_typeof(nodes.value) = 'object' THEN nodes.value ELSE '{}'::jsonb END
      ) AS object_child(object_key, object_value)
  )
  SELECT NOT EXISTS (
    SELECT 1 FROM keys
     WHERE object_key ~* '(^|_)(path|bearer|credential|secret|token|provider_response|raw_response)($|_)'
  );
$$;

ALTER TABLE portable_import_operations
  ADD CONSTRAINT portable_import_normalized_payload_safe_check CHECK (
    normalized_payload IS NULL OR portable_import_normalized_payload_is_safe(normalized_payload)
  );

CREATE FUNCTION enforce_portable_import_private_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.normalized_payload IS DISTINCT FROM NEW.normalized_payload
    OR OLD.authority_fingerprint IS DISTINCT FROM NEW.authority_fingerprint
    OR OLD.provider_configuration_fingerprint IS DISTINCT FROM NEW.provider_configuration_fingerprint
    OR OLD.selected_character_id IS DISTINCT FROM NEW.selected_character_id
  THEN
    RAISE EXCEPTION 'portable import normalized authority is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portable_import_private_authority_immutable_trigger
BEFORE UPDATE ON portable_import_operations
FOR EACH ROW
WHEN (OLD.normalized_payload IS NOT NULL)
EXECUTE FUNCTION enforce_portable_import_private_authority();

-- This row is a restart-safe, owner-scoped status projection. It never grants
-- domain or filesystem authority; claim identity and work_version only fence
-- progress/abort writers for the associated portable operation.
CREATE TABLE portable_import_work (
  operation_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  phase text NOT NULL DEFAULT 'previewed' CHECK (phase IN (
    'staged', 'decoding', 'previewed', 'claiming', 'mutating',
    'publishing_assets', 'committing', 'finalizing', 'completed'
  )),
  percentage smallint NOT NULL DEFAULT 20 CHECK (percentage BETWEEN 0 AND 100),
  diagnostic_code text CHECK (diagnostic_code IS NULL OR diagnostic_code IN (
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
  )),
  status text NOT NULL DEFAULT 'running' CHECK (status IN (
    'running', 'recoverable', 'aborted', 'completed', 'expired'
  )),
  work_version integer NOT NULL DEFAULT 1 CHECK (work_version > 0),
  lease_id uuid,
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 512),
  lease_expires_at timestamptz,
  terminal_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (operation_id, owner_user_id)
    REFERENCES portable_import_operations(id, owner_user_id) ON DELETE RESTRICT,
  CONSTRAINT portable_import_work_lease_check CHECK (
    (lease_id IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT portable_import_work_terminal_check CHECK (
    (status IN ('running', 'recoverable') AND terminal_at IS NULL)
    OR (status IN ('aborted', 'completed', 'expired') AND terminal_at IS NOT NULL)
  )
);

CREATE INDEX portable_import_work_owner_status_idx
  ON portable_import_work(owner_user_id, status, updated_at DESC, operation_id);
CREATE INDEX portable_import_work_expiry_idx
  ON portable_import_work(status, expires_at, updated_at, operation_id)
  WHERE status IN ('running', 'recoverable', 'completed', 'aborted', 'expired');
CREATE INDEX portable_import_work_lease_idx
  ON portable_import_work(status, lease_expires_at, operation_id)
  WHERE lease_id IS NOT NULL AND status IN ('running', 'recoverable');

CREATE FUNCTION enforce_portable_import_work_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portable import work authority cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'running' OR NEW.phase <> 'previewed' OR NEW.percentage <> 20
      OR NEW.work_version <> 1 OR NEW.lease_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'portable import work initial state is invalid'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id
    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR NEW.work_version < OLD.work_version
  THEN
    RAISE EXCEPTION 'portable import work authority is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('aborted', 'completed', 'expired')
    AND ROW(OLD.status,OLD.phase,OLD.percentage,OLD.diagnostic_code,OLD.work_version,
            OLD.lease_id,OLD.lease_owner,OLD.lease_expires_at,OLD.terminal_at)
      IS DISTINCT FROM
        ROW(NEW.status,NEW.phase,NEW.percentage,NEW.diagnostic_code,NEW.work_version,
            NEW.lease_id,NEW.lease_owner,NEW.lease_expires_at,NEW.terminal_at)
  THEN
    RAISE EXCEPTION 'portable import terminal work is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portable_import_work_transition_trigger
BEFORE INSERT OR UPDATE OR DELETE ON portable_import_work
FOR EACH ROW EXECUTE FUNCTION enforce_portable_import_work_transition();

-- Down Migration

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM portable_import_work)
    OR EXISTS (SELECT 1 FROM portable_import_operations WHERE normalized_payload IS NOT NULL)
  THEN
    RAISE EXCEPTION 'portable import composition downgrade would discard durable authority'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

DROP TRIGGER portable_import_work_transition_trigger ON portable_import_work;
DROP FUNCTION enforce_portable_import_work_transition();
DROP INDEX portable_import_work_lease_idx;
DROP INDEX portable_import_work_expiry_idx;
DROP INDEX portable_import_work_owner_status_idx;
DROP TABLE portable_import_work;

DROP TRIGGER portable_import_private_authority_immutable_trigger ON portable_import_operations;
DROP FUNCTION enforce_portable_import_private_authority();
ALTER TABLE portable_import_operations
  DROP CONSTRAINT portable_import_normalized_payload_safe_check,
  DROP CONSTRAINT portable_import_private_authority_check,
  DROP COLUMN selected_character_id,
  DROP COLUMN provider_configuration_fingerprint,
  DROP COLUMN authority_fingerprint,
  DROP COLUMN normalized_payload;
DROP FUNCTION portable_import_normalized_payload_is_safe(jsonb);
