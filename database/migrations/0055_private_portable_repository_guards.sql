-- Up Migration

-- One durable filesystem operation identifies exactly one portable capability.
-- The composite lookup indexes match the private repository's exact authority
-- predicates; raw bearer values remain hashed at rest.
CREATE UNIQUE INDEX portable_staged_inputs_filesystem_operation_key
  ON portable_staged_inputs(filesystem_operation_id);
CREATE INDEX portable_staged_inputs_authority_lookup_idx
  ON portable_staged_inputs(owner_user_id, handle_token_hash, filesystem_operation_id);

CREATE UNIQUE INDEX portable_export_artifacts_filesystem_operation_key
  ON portable_export_artifacts(filesystem_operation_id);
CREATE INDEX portable_export_artifacts_authority_lookup_idx
  ON portable_export_artifacts(
    owner_user_id,
    export_kind,
    campaign_id,
    world_id,
    world_version_id,
    retrieval_token_hash,
    filesystem_operation_id
  );

CREATE FUNCTION enforce_portable_staged_input_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portable staged input authority cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'staged' OR NEW.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'portable staged input initial lifecycle is invalid'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.handle_token_hash IS DISTINCT FROM NEW.handle_token_hash
    OR OLD.filesystem_operation_id IS DISTINCT FROM NEW.filesystem_operation_id
    OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
    OR OLD.byte_length IS DISTINCT FROM NEW.byte_length
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'portable staged input authority is write-once'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.consumed_at IS NOT NULL
    AND OLD.consumed_at IS DISTINCT FROM NEW.consumed_at
  THEN
    RAISE EXCEPTION 'portable staged input consumption evidence is write-once'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status
    AND NOT (
      (OLD.status = 'staged'
        AND NEW.status IN ('consumed', 'expired', 'failed', 'cleanup_pending'))
      OR (OLD.status IN ('consumed', 'expired', 'failed')
        AND NEW.status = 'cleanup_pending')
      OR (OLD.status = 'cleanup_pending' AND NEW.status = 'cleaned')
    )
  THEN
    RAISE EXCEPTION 'portable staged input lifecycle transition is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
    AND NOT (OLD.status = 'staged' AND NEW.status = 'consumed')
  THEN
    RAISE EXCEPTION 'portable staged input consumption evidence is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portable_staged_inputs_authority_trigger
BEFORE INSERT OR UPDATE OR DELETE ON portable_staged_inputs
FOR EACH ROW EXECUTE FUNCTION enforce_portable_staged_input_authority();

CREATE FUNCTION enforce_portable_export_artifact_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portable export artifact authority cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ready' OR NEW.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'portable export artifact initial lifecycle is invalid'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.retrieval_token_hash IS DISTINCT FROM NEW.retrieval_token_hash
    OR OLD.filesystem_operation_id IS DISTINCT FROM NEW.filesystem_operation_id
    OR OLD.export_kind IS DISTINCT FROM NEW.export_kind
    OR OLD.campaign_id IS DISTINCT FROM NEW.campaign_id
    OR OLD.world_id IS DISTINCT FROM NEW.world_id
    OR OLD.world_version_id IS DISTINCT FROM NEW.world_version_id
    OR OLD.content_type IS DISTINCT FROM NEW.content_type
    OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
    OR OLD.byte_length IS DISTINCT FROM NEW.byte_length
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'portable export artifact authority is write-once'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.consumed_at IS NOT NULL
    AND OLD.consumed_at IS DISTINCT FROM NEW.consumed_at
  THEN
    RAISE EXCEPTION 'portable export artifact consumption evidence is write-once'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status
    AND NOT (
      (OLD.status = 'ready'
        AND NEW.status IN ('consumed', 'expired', 'failed', 'cleanup_pending'))
      OR (OLD.status IN ('consumed', 'expired', 'failed')
        AND NEW.status = 'cleanup_pending')
      OR (OLD.status = 'cleanup_pending' AND NEW.status = 'cleaned')
    )
  THEN
    RAISE EXCEPTION 'portable export artifact lifecycle transition is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
    AND NOT (OLD.status = 'ready' AND NEW.status = 'consumed')
  THEN
    RAISE EXCEPTION 'portable export artifact consumption evidence is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portable_export_artifacts_authority_trigger
BEFORE INSERT OR UPDATE OR DELETE ON portable_export_artifacts
FOR EACH ROW EXECUTE FUNCTION enforce_portable_export_artifact_authority();

-- Cleanup is one logical transition split across two rows. Deferred constraint
-- triggers let either update run first while rejecting any split state at the
-- transaction boundary.
CREATE FUNCTION enforce_portable_filesystem_cleanup_match() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_operation_id uuid;
  operation_lifecycle text;
  operation_purpose text;
  portable_status text;
BEGIN
  IF TG_TABLE_NAME = 'durable_filesystem_operations' THEN
    target_operation_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    target_operation_id := CASE
      WHEN TG_OP = 'DELETE' THEN OLD.filesystem_operation_id
      ELSE NEW.filesystem_operation_id
    END;
  END IF;

  SELECT lifecycle, purpose
    INTO operation_lifecycle, operation_purpose
    FROM durable_filesystem_operations
   WHERE id = target_operation_id;

  IF operation_purpose = 'portable_staging' THEN
    SELECT status INTO portable_status
      FROM portable_staged_inputs
     WHERE filesystem_operation_id = target_operation_id;
  ELSIF operation_purpose = 'portable_export' THEN
    SELECT status INTO portable_status
      FROM portable_export_artifacts
     WHERE filesystem_operation_id = target_operation_id;
  ELSIF TG_TABLE_NAME = 'portable_staged_inputs' THEN
    portable_status := CASE WHEN TG_OP = 'DELETE' THEN OLD.status ELSE NEW.status END;
    IF portable_status IN ('cleanup_pending', 'cleaned') THEN
      RAISE EXCEPTION 'portable staged cleanup is missing its filesystem journal'
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  ELSIF TG_TABLE_NAME = 'portable_export_artifacts' THEN
    portable_status := CASE WHEN TG_OP = 'DELETE' THEN OLD.status ELSE NEW.status END;
    IF portable_status IN ('cleanup_pending', 'cleaned') THEN
      RAISE EXCEPTION 'portable export cleanup is missing its filesystem journal'
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  ELSE
    RETURN NULL;
  END IF;

  -- A reserved/attached portable-purpose operation may be abandoned before a
  -- staged input or export artifact is issued. With no portable row there is
  -- no second lifecycle to split; the journal remains its sole cleanup owner.
  IF portable_status IS NULL THEN
    RETURN NULL;
  END IF;

  IF operation_lifecycle IN ('cleanup_pending', 'cleaned')
    OR portable_status IN ('cleanup_pending', 'cleaned')
  THEN
    IF operation_lifecycle IS DISTINCT FROM portable_status THEN
      RAISE EXCEPTION 'portable and filesystem cleanup lifecycle must transition together'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER durable_filesystem_portable_cleanup_match_trigger
AFTER INSERT OR UPDATE OR DELETE ON durable_filesystem_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_portable_filesystem_cleanup_match();

CREATE CONSTRAINT TRIGGER portable_staged_inputs_cleanup_match_trigger
AFTER INSERT OR UPDATE ON portable_staged_inputs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_portable_filesystem_cleanup_match();

CREATE CONSTRAINT TRIGGER portable_export_artifacts_cleanup_match_trigger
AFTER INSERT OR UPDATE ON portable_export_artifacts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_portable_filesystem_cleanup_match();

-- Down Migration

DROP TRIGGER IF EXISTS portable_export_artifacts_cleanup_match_trigger
  ON portable_export_artifacts;
DROP TRIGGER IF EXISTS portable_staged_inputs_cleanup_match_trigger
  ON portable_staged_inputs;
DROP TRIGGER IF EXISTS durable_filesystem_portable_cleanup_match_trigger
  ON durable_filesystem_operations;
DROP FUNCTION IF EXISTS enforce_portable_filesystem_cleanup_match();

DROP TRIGGER IF EXISTS portable_export_artifacts_authority_trigger
  ON portable_export_artifacts;
DROP FUNCTION IF EXISTS enforce_portable_export_artifact_authority();
DROP TRIGGER IF EXISTS portable_staged_inputs_authority_trigger
  ON portable_staged_inputs;
DROP FUNCTION IF EXISTS enforce_portable_staged_input_authority();

DROP INDEX IF EXISTS portable_export_artifacts_authority_lookup_idx;
DROP INDEX IF EXISTS portable_export_artifacts_filesystem_operation_key;
DROP INDEX IF EXISTS portable_staged_inputs_authority_lookup_idx;
DROP INDEX IF EXISTS portable_staged_inputs_filesystem_operation_key;
