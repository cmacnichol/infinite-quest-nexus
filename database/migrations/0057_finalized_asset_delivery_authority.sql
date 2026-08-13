-- Up Migration

-- Finalized delivery authority is separate from the raw-candidate grant in
-- 0054. The trusted adapter receives the bearer once; PostgreSQL retains only
-- its SHA-256 hash plus an exact immutable snapshot of the selected domain row
-- and the finalized 0054 operation/descriptor binding.
CREATE TABLE private_finalized_asset_delivery_grants (
  grant_token_hash text PRIMARY KEY CHECK (grant_token_hash ~ '^[0-9a-f]{64}$'),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  asset_id uuid NOT NULL,
  delivery_intent text NOT NULL CHECK (delivery_intent IN ('original', 'thumbnail')),
  selected_row_kind text NOT NULL CHECK (selected_row_kind IN ('asset', 'asset_derivative')),
  selected_row_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  operation_purpose text NOT NULL CHECK (operation_purpose IN ('asset_original', 'asset_derivative')),
  candidate_token_hash text NOT NULL CHECK (candidate_token_hash ~ '^[0-9a-f]{64}$'),
  descriptor_role text GENERATED ALWAYS AS ('delivery'::text) STORED,
  descriptor_ordinal integer GENERATED ALWAYS AS (0) STORED,
  relative_path text NOT NULL CHECK (
    relative_path <> ''
    AND relative_path !~ '(^/|^[A-Za-z]:|^\\\\|\\\\|(^|/)\.\.?(/|$))'
  ),
  device_id text NOT NULL CHECK (btrim(device_id) <> ''),
  file_id text NOT NULL CHECK (btrim(file_id) <> ''),
  change_token text NOT NULL CHECK (btrim(change_token) <> ''),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  mime_type text NOT NULL CHECK (btrim(mime_type) <> ''),
  lifecycle text NOT NULL DEFAULT 'issued'
    CHECK (lifecycle IN ('issued', 'redeemed', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  expired_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (asset_id, owner_user_id)
    REFERENCES assets(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id, owner_user_id, operation_purpose, asset_id)
    REFERENCES durable_filesystem_operations(id, owner_user_id, purpose, asset_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (candidate_token_hash, operation_id, owner_user_id, operation_purpose)
    REFERENCES durable_filesystem_candidate_authorities(
      candidate_token_hash, operation_id, owner_user_id, purpose
    ) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id, owner_user_id, descriptor_role, descriptor_ordinal)
    REFERENCES durable_filesystem_descriptors(operation_id, owner_user_id, descriptor_role, ordinal)
    ON DELETE RESTRICT,
  CONSTRAINT private_finalized_delivery_selection_check CHECK (
    (selected_row_kind = 'asset' AND operation_purpose = 'asset_original')
    OR
    (selected_row_kind = 'asset_derivative'
      AND delivery_intent = 'thumbnail'
      AND operation_purpose = 'asset_derivative')
  ),
  CONSTRAINT private_finalized_delivery_completion_check CHECK (
    (lifecycle = 'issued'
      AND redeemed_at IS NULL AND expired_at IS NULL AND revoked_at IS NULL)
    OR (lifecycle = 'redeemed'
      AND redeemed_at IS NOT NULL AND expired_at IS NULL AND revoked_at IS NULL)
    OR (lifecycle = 'expired'
      AND redeemed_at IS NULL AND expired_at IS NOT NULL AND revoked_at IS NULL)
    OR (lifecycle = 'revoked'
      AND redeemed_at IS NULL AND expired_at IS NULL AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX private_finalized_asset_delivery_grants_expiry_idx
  ON private_finalized_asset_delivery_grants(lifecycle, expires_at, created_at, grant_token_hash)
  WHERE lifecycle = 'issued';
CREATE INDEX private_finalized_asset_delivery_grants_scope_idx
  ON private_finalized_asset_delivery_grants(
    owner_user_id, asset_id, delivery_intent, selected_row_kind, selected_row_id
  );

-- Legacy rows have no 0054 identity descriptor. Their one-time read authority
-- snapshots only the authoritative legacy row fields needed by b4 to perform a
-- bounded, hash-verified read. It never carries a cleanup or recovery claim.
CREATE TABLE private_legacy_asset_read_capabilities (
  capability_token_hash text PRIMARY KEY CHECK (capability_token_hash ~ '^[0-9a-f]{64}$'),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  asset_id uuid NOT NULL,
  delivery_intent text NOT NULL CHECK (delivery_intent IN ('original', 'thumbnail')),
  selected_row_kind text NOT NULL CHECK (selected_row_kind IN ('asset', 'asset_derivative')),
  selected_row_id uuid NOT NULL,
  relative_path text NOT NULL CHECK (
    relative_path <> ''
    AND relative_path !~ '(^/|^[A-Za-z]:|^\\\\|\\\\|(^|/)\.\.?(/|$))'
  ),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  mime_type text NOT NULL CHECK (btrim(mime_type) <> ''),
  lifecycle text NOT NULL DEFAULT 'issued'
    CHECK (lifecycle IN ('issued', 'redeemed', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  expired_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (asset_id, owner_user_id)
    REFERENCES assets(id, owner_user_id) ON DELETE RESTRICT,
  CONSTRAINT private_legacy_read_selection_check CHECK (
    selected_row_kind = 'asset'
    OR (selected_row_kind = 'asset_derivative' AND delivery_intent = 'thumbnail')
  ),
  CONSTRAINT private_legacy_read_completion_check CHECK (
    (lifecycle = 'issued'
      AND redeemed_at IS NULL AND expired_at IS NULL AND revoked_at IS NULL)
    OR (lifecycle = 'redeemed'
      AND redeemed_at IS NOT NULL AND expired_at IS NULL AND revoked_at IS NULL)
    OR (lifecycle = 'expired'
      AND redeemed_at IS NULL AND expired_at IS NOT NULL AND revoked_at IS NULL)
    OR (lifecycle = 'revoked'
      AND redeemed_at IS NULL AND expired_at IS NULL AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX private_legacy_asset_read_capabilities_expiry_idx
  ON private_legacy_asset_read_capabilities(
    lifecycle, expires_at, created_at, capability_token_hash
  ) WHERE lifecycle = 'issued';
CREATE INDEX private_legacy_asset_read_capabilities_scope_idx
  ON private_legacy_asset_read_capabilities(
    owner_user_id, asset_id, delivery_intent, selected_row_kind, selected_row_id
  );

CREATE FUNCTION private_asset_delivery_capability_max_lifetime() RETURNS interval
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT interval '60 seconds';
$$;

CREATE FUNCTION assert_private_finalized_asset_delivery_binding(
  grant_row private_finalized_asset_delivery_grants
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  operation durable_filesystem_operations%ROWTYPE;
  descriptor durable_filesystem_descriptors%ROWTYPE;
  selected_operation_id uuid;
  selected_relative_path text;
  selected_content_hash text;
  selected_byte_length bigint;
  selected_mime_type text;
BEGIN
  SELECT * INTO operation
    FROM durable_filesystem_operations
   WHERE id = grant_row.operation_id;
  SELECT * INTO descriptor
    FROM durable_filesystem_descriptors
   WHERE operation_id = grant_row.operation_id
     AND owner_user_id = grant_row.owner_user_id
     AND descriptor_role = 'delivery'
     AND ordinal = 0;

  IF grant_row.selected_row_kind = 'asset' THEN
    SELECT filesystem_operation_id, storage_path, content_hash, byte_length, mime_type
      INTO selected_operation_id, selected_relative_path, selected_content_hash,
           selected_byte_length, selected_mime_type
      FROM assets
     WHERE id = grant_row.selected_row_id
       AND id = grant_row.asset_id
       AND owner_user_id = grant_row.owner_user_id;
  ELSE
    SELECT filesystem_operation_id, storage_path, content_hash, byte_length, mime_type
      INTO selected_operation_id, selected_relative_path, selected_content_hash,
           selected_byte_length, selected_mime_type
      FROM asset_derivatives
     WHERE id = grant_row.selected_row_id
       AND source_asset_id = grant_row.asset_id
       AND owner_user_id = grant_row.owner_user_id
       AND derivative_kind = 'thumbnail';
  END IF;

  IF operation.id IS NULL
    OR operation.lifecycle <> 'finalized'
    OR operation.resource_kind <> 'asset'
    OR operation.owner_user_id IS DISTINCT FROM grant_row.owner_user_id
    OR operation.asset_id IS DISTINCT FROM grant_row.asset_id
    OR operation.purpose IS DISTINCT FROM grant_row.operation_purpose
    OR operation.candidate_token_hash IS DISTINCT FROM grant_row.candidate_token_hash
    OR selected_operation_id IS DISTINCT FROM grant_row.operation_id
    OR selected_relative_path IS DISTINCT FROM grant_row.relative_path
    OR selected_content_hash IS DISTINCT FROM grant_row.content_hash
    OR selected_byte_length IS DISTINCT FROM grant_row.byte_length
    OR selected_mime_type IS DISTINCT FROM grant_row.mime_type
    OR descriptor.operation_id IS NULL
    OR descriptor.relative_path IS DISTINCT FROM grant_row.relative_path
    OR descriptor.device_id IS DISTINCT FROM grant_row.device_id
    OR descriptor.file_id IS DISTINCT FROM grant_row.file_id
    OR descriptor.change_token IS DISTINCT FROM grant_row.change_token
    OR descriptor.content_hash IS DISTINCT FROM grant_row.content_hash
    OR descriptor.byte_length IS DISTINCT FROM grant_row.byte_length
  THEN
    RAISE EXCEPTION 'finalized asset delivery binding is invalid'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE FUNCTION enforce_private_finalized_asset_delivery_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finalized asset delivery grant cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.grant_token_hash IS DISTINCT FROM NEW.grant_token_hash
      OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
      OR OLD.delivery_intent IS DISTINCT FROM NEW.delivery_intent
      OR OLD.selected_row_kind IS DISTINCT FROM NEW.selected_row_kind
      OR OLD.selected_row_id IS DISTINCT FROM NEW.selected_row_id
      OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
      OR OLD.operation_purpose IS DISTINCT FROM NEW.operation_purpose
      OR OLD.candidate_token_hash IS DISTINCT FROM NEW.candidate_token_hash
      OR OLD.relative_path IS DISTINCT FROM NEW.relative_path
      OR OLD.device_id IS DISTINCT FROM NEW.device_id
      OR OLD.file_id IS DISTINCT FROM NEW.file_id
      OR OLD.change_token IS DISTINCT FROM NEW.change_token
      OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
      OR OLD.byte_length IS DISTINCT FROM NEW.byte_length
      OR OLD.mime_type IS DISTINCT FROM NEW.mime_type
      OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'finalized asset delivery authority is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.lifecycle <> 'issued'
      OR NEW.lifecycle NOT IN ('redeemed', 'expired', 'revoked')
    THEN
      RAISE EXCEPTION 'finalized asset delivery grant cannot be replayed'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.lifecycle = 'redeemed' THEN
      IF clock_timestamp() >= NEW.expires_at THEN
        RAISE EXCEPTION 'finalized asset delivery grant is stale'
          USING ERRCODE = '55000';
      END IF;
      PERFORM assert_private_finalized_asset_delivery_binding(NEW);
    ELSIF NEW.lifecycle = 'expired' AND clock_timestamp() < NEW.expires_at THEN
      RAISE EXCEPTION 'finalized asset delivery grant is not expired'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.lifecycle <> 'issued'
    OR NEW.expires_at <= clock_timestamp()
    OR NEW.expires_at > clock_timestamp() + private_asset_delivery_capability_max_lifetime()
  THEN
    RAISE EXCEPTION 'finalized asset delivery grant lifetime is invalid'
      USING ERRCODE = '55000';
  END IF;
  PERFORM assert_private_finalized_asset_delivery_binding(NEW);
  RETURN NEW;
END;
$$;

CREATE TRIGGER private_finalized_asset_delivery_grants_trigger
BEFORE INSERT OR UPDATE OR DELETE ON private_finalized_asset_delivery_grants
FOR EACH ROW EXECUTE FUNCTION enforce_private_finalized_asset_delivery_grant();

CREATE FUNCTION assert_private_legacy_asset_read_binding(
  capability_row private_legacy_asset_read_capabilities
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  selected_operation_id uuid;
  selected_relative_path text;
  selected_content_hash text;
  selected_byte_length bigint;
  selected_mime_type text;
BEGIN
  IF capability_row.selected_row_kind = 'asset' THEN
    SELECT filesystem_operation_id, storage_path, content_hash, byte_length, mime_type
      INTO selected_operation_id, selected_relative_path, selected_content_hash,
           selected_byte_length, selected_mime_type
      FROM assets
     WHERE id = capability_row.selected_row_id
       AND id = capability_row.asset_id
       AND owner_user_id = capability_row.owner_user_id;
  ELSE
    SELECT filesystem_operation_id, storage_path, content_hash, byte_length, mime_type
      INTO selected_operation_id, selected_relative_path, selected_content_hash,
           selected_byte_length, selected_mime_type
      FROM asset_derivatives
     WHERE id = capability_row.selected_row_id
       AND source_asset_id = capability_row.asset_id
       AND owner_user_id = capability_row.owner_user_id
       AND derivative_kind = 'thumbnail';
  END IF;

  IF selected_relative_path IS NULL
    OR selected_operation_id IS NOT NULL
    OR selected_relative_path IS DISTINCT FROM capability_row.relative_path
    OR selected_content_hash IS DISTINCT FROM capability_row.content_hash
    OR selected_byte_length IS DISTINCT FROM capability_row.byte_length
    OR selected_mime_type IS DISTINCT FROM capability_row.mime_type
  THEN
    RAISE EXCEPTION 'legacy asset read binding is invalid'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE FUNCTION enforce_private_legacy_asset_read_capability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legacy asset read capability cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.capability_token_hash IS DISTINCT FROM NEW.capability_token_hash
      OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
      OR OLD.delivery_intent IS DISTINCT FROM NEW.delivery_intent
      OR OLD.selected_row_kind IS DISTINCT FROM NEW.selected_row_kind
      OR OLD.selected_row_id IS DISTINCT FROM NEW.selected_row_id
      OR OLD.relative_path IS DISTINCT FROM NEW.relative_path
      OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
      OR OLD.byte_length IS DISTINCT FROM NEW.byte_length
      OR OLD.mime_type IS DISTINCT FROM NEW.mime_type
      OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'legacy asset read authority is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.lifecycle <> 'issued'
      OR NEW.lifecycle NOT IN ('redeemed', 'expired', 'revoked')
    THEN
      RAISE EXCEPTION 'legacy asset read capability cannot be replayed'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.lifecycle = 'redeemed' THEN
      IF clock_timestamp() >= NEW.expires_at THEN
        RAISE EXCEPTION 'legacy asset read capability is stale'
          USING ERRCODE = '55000';
      END IF;
      PERFORM assert_private_legacy_asset_read_binding(NEW);
    ELSIF NEW.lifecycle = 'expired' AND clock_timestamp() < NEW.expires_at THEN
      RAISE EXCEPTION 'legacy asset read capability is not expired'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.lifecycle <> 'issued'
    OR NEW.expires_at <= clock_timestamp()
    OR NEW.expires_at > clock_timestamp() + private_asset_delivery_capability_max_lifetime()
  THEN
    RAISE EXCEPTION 'legacy asset read capability lifetime is invalid'
      USING ERRCODE = '55000';
  END IF;
  PERFORM assert_private_legacy_asset_read_binding(NEW);
  RETURN NEW;
END;
$$;

CREATE TRIGGER private_legacy_asset_read_capabilities_trigger
BEFORE INSERT OR UPDATE OR DELETE ON private_legacy_asset_read_capabilities
FOR EACH ROW EXECUTE FUNCTION enforce_private_legacy_asset_read_capability();

-- Down Migration

DROP TRIGGER IF EXISTS private_legacy_asset_read_capabilities_trigger
  ON private_legacy_asset_read_capabilities;
DROP FUNCTION IF EXISTS enforce_private_legacy_asset_read_capability();
DROP FUNCTION IF EXISTS assert_private_legacy_asset_read_binding(
  private_legacy_asset_read_capabilities
);
DROP TABLE IF EXISTS private_legacy_asset_read_capabilities;

DROP TRIGGER IF EXISTS private_finalized_asset_delivery_grants_trigger
  ON private_finalized_asset_delivery_grants;
DROP FUNCTION IF EXISTS enforce_private_finalized_asset_delivery_grant();
DROP FUNCTION IF EXISTS assert_private_finalized_asset_delivery_binding(
  private_finalized_asset_delivery_grants
);
DROP TABLE IF EXISTS private_finalized_asset_delivery_grants;

DROP FUNCTION IF EXISTS private_asset_delivery_capability_max_lifetime();
