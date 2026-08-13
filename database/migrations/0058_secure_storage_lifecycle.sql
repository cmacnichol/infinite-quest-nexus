-- Up Migration

CREATE FUNCTION durable_filesystem_expected_prewrite_path(
  operation_id uuid,
  operation_purpose text
) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE operation_purpose
    WHEN 'portable_staging' THEN 'staging/' || operation_id::text || '.pending'
    WHEN 'portable_export' THEN 'exports/' || operation_id::text || '.pending'
    WHEN 'asset_original' THEN 'assets/' || operation_id::text || '.pending'
    WHEN 'asset_derivative' THEN 'assets/' || operation_id::text || '.pending'
    ELSE NULL
  END
$$;

-- A crash after O_EXCL create but before the first byte still leaves enough
-- database-derived identity to remove that exact node without trusting a path
-- recovered from memory, a bearer, or a browser.
CREATE TABLE durable_filesystem_prewrite_nodes (
  operation_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN (
    'asset_original', 'asset_derivative', 'portable_staging', 'portable_export'
  )),
  relative_path text NOT NULL CHECK (
    relative_path = durable_filesystem_expected_prewrite_path(operation_id, purpose)
  ),
  device_id text NOT NULL CHECK (btrim(device_id) <> ''),
  file_id text NOT NULL CHECK (btrim(file_id) <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (operation_id, owner_user_id, purpose),
  FOREIGN KEY (operation_id, owner_user_id, purpose)
    REFERENCES durable_filesystem_operations(id, owner_user_id, purpose)
);

CREATE FUNCTION enforce_durable_filesystem_prewrite_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  operation_lifecycle text;
  operation_expiry timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'durable filesystem prewrite authority is immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT lifecycle, expires_at
    INTO operation_lifecycle, operation_expiry
    FROM durable_filesystem_operations
   WHERE id = NEW.operation_id
     AND owner_user_id = NEW.owner_user_id
     AND purpose = NEW.purpose
   FOR UPDATE;

  IF operation_lifecycle IS NULL
    OR operation_lifecycle <> 'reserved'
    OR operation_expiry <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'prewrite node requires a live reserved filesystem operation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER durable_filesystem_prewrite_authority_trigger
BEFORE INSERT OR UPDATE OR DELETE ON durable_filesystem_prewrite_nodes
FOR EACH ROW EXECUTE FUNCTION enforce_durable_filesystem_prewrite_authority();

CREATE INDEX durable_filesystem_prewrite_recovery_idx
  ON durable_filesystem_prewrite_nodes(created_at, operation_id);

CREATE INDEX durable_filesystem_portable_expiry_recovery_idx
  ON durable_filesystem_operations(lifecycle, lease_expires_at, expires_at, created_at, id)
  WHERE resource_kind = 'portable'
    AND lifecycle IN ('reserved', 'attached', 'finalized', 'cleanup_pending');

-- Down Migration

DROP INDEX IF EXISTS durable_filesystem_portable_expiry_recovery_idx;
DROP INDEX IF EXISTS durable_filesystem_prewrite_recovery_idx;
DROP TRIGGER IF EXISTS durable_filesystem_prewrite_authority_trigger
  ON durable_filesystem_prewrite_nodes;
DROP FUNCTION IF EXISTS enforce_durable_filesystem_prewrite_authority();
DROP TABLE IF EXISTS durable_filesystem_prewrite_nodes;
DROP FUNCTION IF EXISTS durable_filesystem_expected_prewrite_path(uuid, text);
