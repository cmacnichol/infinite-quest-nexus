-- Up Migration

DROP TRIGGER durable_filesystem_prewrite_authority_trigger
  ON durable_filesystem_prewrite_nodes;

ALTER TABLE durable_filesystem_prewrite_nodes
  ALTER COLUMN device_id DROP NOT NULL,
  ALTER COLUMN file_id DROP NOT NULL,
  ADD COLUMN authority_state text NOT NULL DEFAULT 'identity_bound',
  ADD COLUMN target_recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN identity_bound_at timestamptz,
  ADD COLUMN quarantined_at timestamptz,
  ADD COLUMN quarantine_reason text;

UPDATE durable_filesystem_prewrite_nodes
   SET identity_bound_at = created_at;

ALTER TABLE durable_filesystem_prewrite_nodes
  ADD CONSTRAINT durable_filesystem_prewrite_authority_state_check CHECK (
    authority_state IN ('target_only', 'identity_bound', 'quarantined')
  ),
  ADD CONSTRAINT durable_filesystem_prewrite_identity_state_check CHECK (
    (authority_state = 'target_only'
      AND device_id IS NULL AND file_id IS NULL
      AND identity_bound_at IS NULL
      AND quarantined_at IS NULL AND quarantine_reason IS NULL)
    OR
    (authority_state = 'identity_bound'
      AND device_id IS NOT NULL AND btrim(device_id) <> ''
      AND file_id IS NOT NULL AND btrim(file_id) <> ''
      AND identity_bound_at IS NOT NULL
      AND quarantined_at IS NULL AND quarantine_reason IS NULL)
    OR
    (authority_state = 'quarantined'
      AND device_id IS NULL AND file_id IS NULL
      AND identity_bound_at IS NULL
      AND quarantined_at IS NOT NULL
      AND quarantine_reason IS NOT NULL AND btrim(quarantine_reason) <> '')
  );

CREATE OR REPLACE FUNCTION enforce_durable_filesystem_prewrite_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  operation_lifecycle text;
  operation_expiry timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
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

  IF TG_OP = 'INSERT' THEN
    IF NEW.authority_state <> 'target_only'
      OR NEW.device_id IS NOT NULL OR NEW.file_id IS NOT NULL
      OR operation_lifecycle IS NULL
      OR operation_lifecycle <> 'reserved'
      OR operation_expiry <= clock_timestamp()
    THEN
      RAISE EXCEPTION 'prewrite target requires a live reserved filesystem operation'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.relative_path IS DISTINCT FROM OLD.relative_path
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.target_recorded_at IS DISTINCT FROM OLD.target_recorded_at
  THEN
    RAISE EXCEPTION 'durable filesystem prewrite target is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.authority_state = 'target_only'
    AND NEW.authority_state = 'identity_bound'
    AND OLD.device_id IS NULL AND OLD.file_id IS NULL
    AND NEW.device_id IS NOT NULL AND btrim(NEW.device_id) <> ''
    AND NEW.file_id IS NOT NULL AND btrim(NEW.file_id) <> ''
    AND NEW.identity_bound_at IS NOT NULL
    AND NEW.quarantined_at IS NULL AND NEW.quarantine_reason IS NULL
    AND operation_lifecycle = 'reserved'
    AND operation_expiry > clock_timestamp()
  THEN
    RETURN NEW;
  END IF;

  IF OLD.authority_state = 'target_only'
    AND NEW.authority_state = 'quarantined'
    AND NEW.device_id IS NULL AND NEW.file_id IS NULL
    AND NEW.identity_bound_at IS NULL
    AND NEW.quarantined_at IS NOT NULL
    AND NEW.quarantine_reason IS NOT NULL AND btrim(NEW.quarantine_reason) <> ''
    AND operation_lifecycle = 'cleanup_pending'
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'durable filesystem prewrite authority transition is prohibited'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER durable_filesystem_prewrite_authority_trigger
BEFORE INSERT OR UPDATE OR DELETE ON durable_filesystem_prewrite_nodes
FOR EACH ROW EXECUTE FUNCTION enforce_durable_filesystem_prewrite_authority();

-- Down Migration

DROP TRIGGER durable_filesystem_prewrite_authority_trigger
  ON durable_filesystem_prewrite_nodes;

DELETE FROM durable_filesystem_prewrite_nodes
 WHERE authority_state <> 'identity_bound';

ALTER TABLE durable_filesystem_prewrite_nodes
  DROP CONSTRAINT durable_filesystem_prewrite_identity_state_check,
  DROP CONSTRAINT durable_filesystem_prewrite_authority_state_check,
  DROP COLUMN quarantine_reason,
  DROP COLUMN quarantined_at,
  DROP COLUMN identity_bound_at,
  DROP COLUMN target_recorded_at,
  DROP COLUMN authority_state,
  ALTER COLUMN device_id SET NOT NULL,
  ALTER COLUMN file_id SET NOT NULL;

CREATE OR REPLACE FUNCTION enforce_durable_filesystem_prewrite_authority() RETURNS trigger
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
