-- Up Migration

-- Transaction timestamps are frozen at BEGIN. Authority expiry is a wall-clock
-- boundary, so trigger checks must still advance after a statement waits on a
-- row lock.
CREATE OR REPLACE FUNCTION enforce_durable_filesystem_candidate_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  operation durable_filesystem_operations%ROWTYPE;
  descriptor durable_filesystem_descriptors%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'durable filesystem candidate authority cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO operation
    FROM durable_filesystem_operations
   WHERE id = NEW.operation_id;

  IF NOT FOUND
    OR operation.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR operation.purpose IS DISTINCT FROM NEW.purpose
    OR operation.resource_kind IS DISTINCT FROM NEW.resource_kind
    OR operation.asset_id IS DISTINCT FROM NEW.asset_id
    OR operation.operation_scope_hash IS DISTINCT FROM NEW.operation_scope_hash
  THEN
    RAISE EXCEPTION 'candidate authority filesystem scope is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle <> 'issued'
      OR operation.lifecycle <> 'reserved'
      OR NEW.expires_at <= clock_timestamp()
      OR NEW.expires_at > operation.expires_at
    THEN
      RAISE EXCEPTION 'candidate authority reservation lifecycle is invalid'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.candidate_token_hash IS DISTINCT FROM NEW.candidate_token_hash
    OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.purpose IS DISTINCT FROM NEW.purpose
    OR OLD.resource_kind IS DISTINCT FROM NEW.resource_kind
    OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
    OR OLD.operation_scope_hash IS DISTINCT FROM NEW.operation_scope_hash
    OR OLD.relative_path IS DISTINCT FROM NEW.relative_path
    OR OLD.device_id IS DISTINCT FROM NEW.device_id
    OR OLD.file_id IS DISTINCT FROM NEW.file_id
    OR OLD.change_token IS DISTINCT FROM NEW.change_token
    OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
    OR OLD.byte_length IS DISTINCT FROM NEW.byte_length
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'candidate authority descriptor and scope are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.lifecycle IS DISTINCT FROM NEW.lifecycle
    AND NOT (
      (OLD.lifecycle = 'issued' AND NEW.lifecycle IN ('attached', 'expired', 'revoked'))
      OR (OLD.lifecycle = 'attached' AND NEW.lifecycle IN ('expired', 'revoked'))
    )
  THEN
    RAISE EXCEPTION 'candidate authority lifecycle transition is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.lifecycle = 'issued' AND NEW.lifecycle = 'attached' THEN
    IF operation.lifecycle NOT IN ('attached', 'finalized')
      OR operation.candidate_token_hash IS DISTINCT FROM NEW.candidate_token_hash
    THEN
      RAISE EXCEPTION 'candidate authority attachment evidence is invalid'
        USING ERRCODE = '55000';
    END IF;
    SELECT * INTO descriptor
      FROM durable_filesystem_descriptors
     WHERE operation_id = NEW.operation_id
       AND owner_user_id = NEW.owner_user_id
       AND descriptor_role = 'delivery'
       AND ordinal = 0;
    IF NOT FOUND
      OR descriptor.relative_path IS DISTINCT FROM NEW.relative_path
      OR descriptor.device_id IS DISTINCT FROM NEW.device_id
      OR descriptor.file_id IS DISTINCT FROM NEW.file_id
      OR descriptor.change_token IS DISTINCT FROM NEW.change_token
      OR descriptor.content_hash IS DISTINCT FROM NEW.content_hash
      OR descriptor.byte_length IS DISTINCT FROM NEW.byte_length
    THEN
      RAISE EXCEPTION 'candidate authority descriptor evidence is invalid'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.lifecycle = 'expired' AND clock_timestamp() < NEW.expires_at THEN
    RAISE EXCEPTION 'candidate authority is not expired'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_private_filesystem_delivery_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  operation durable_filesystem_operations%ROWTYPE;
  candidate durable_filesystem_candidate_authorities%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'private filesystem delivery grant cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO operation
    FROM durable_filesystem_operations
   WHERE id = NEW.operation_id;
  SELECT * INTO candidate
    FROM durable_filesystem_candidate_authorities
   WHERE candidate_token_hash = NEW.candidate_token_hash;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.grant_token_hash IS DISTINCT FROM NEW.grant_token_hash
      OR OLD.candidate_token_hash IS DISTINCT FROM NEW.candidate_token_hash
      OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
      OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      OR OLD.purpose IS DISTINCT FROM NEW.purpose
      OR OLD.resource_kind IS DISTINCT FROM NEW.resource_kind
      OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
      OR OLD.operation_scope_hash IS DISTINCT FROM NEW.operation_scope_hash
      OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'private filesystem delivery grant authority is immutable'
        USING ERRCODE = '55000';
    END IF;

    IF OLD.lifecycle <> 'issued' THEN
      RAISE EXCEPTION 'terminal private filesystem delivery grant cannot be replayed'
        USING ERRCODE = '55000';
    END IF;

    IF OLD.lifecycle IS DISTINCT FROM NEW.lifecycle
      AND NOT (OLD.lifecycle = 'issued' AND NEW.lifecycle IN ('redeemed', 'expired', 'revoked'))
    THEN
      RAISE EXCEPTION 'private filesystem delivery grant lifecycle transition is invalid'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.lifecycle = 'redeemed' AND clock_timestamp() >= NEW.expires_at THEN
      RAISE EXCEPTION 'private filesystem delivery grant is stale'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.lifecycle = 'redeemed'
      AND (
        operation.lifecycle <> 'finalized'
        OR operation.candidate_token_hash IS DISTINCT FROM NEW.candidate_token_hash
        OR candidate.lifecycle <> 'attached'
        OR candidate.expires_at <= clock_timestamp()
      )
    THEN
      RAISE EXCEPTION 'private filesystem delivery grant authority is no longer active'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.lifecycle = 'expired' AND clock_timestamp() < NEW.expires_at THEN
      RAISE EXCEPTION 'private filesystem delivery grant is not expired'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.lifecycle <> 'issued'
    OR NEW.expires_at <= clock_timestamp()
    OR NEW.expires_at > clock_timestamp() + private_filesystem_delivery_grant_max_lifetime()
    OR NEW.expires_at > candidate.expires_at
    OR operation.lifecycle <> 'finalized'
    OR operation.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR operation.purpose IS DISTINCT FROM NEW.purpose
    OR operation.resource_kind IS DISTINCT FROM NEW.resource_kind
    OR operation.asset_id IS DISTINCT FROM NEW.asset_id
    OR operation.operation_scope_hash IS DISTINCT FROM NEW.operation_scope_hash
    OR operation.candidate_token_hash IS DISTINCT FROM NEW.candidate_token_hash
    OR candidate.lifecycle <> 'attached'
    OR candidate.operation_id IS DISTINCT FROM NEW.operation_id
    OR candidate.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR candidate.purpose IS DISTINCT FROM NEW.purpose
    OR candidate.resource_kind IS DISTINCT FROM NEW.resource_kind
    OR candidate.asset_id IS DISTINCT FROM NEW.asset_id
    OR candidate.operation_scope_hash IS DISTINCT FROM NEW.operation_scope_hash
    OR candidate.expires_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'private filesystem delivery grant scope or lifecycle is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- Down Migration

CREATE OR REPLACE FUNCTION enforce_durable_filesystem_candidate_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  operation durable_filesystem_operations%ROWTYPE;
  descriptor durable_filesystem_descriptors%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'durable filesystem candidate authority cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO operation
    FROM durable_filesystem_operations
   WHERE id = NEW.operation_id;

  IF NOT FOUND
    OR operation.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR operation.purpose IS DISTINCT FROM NEW.purpose
    OR operation.resource_kind IS DISTINCT FROM NEW.resource_kind
    OR operation.asset_id IS DISTINCT FROM NEW.asset_id
    OR operation.operation_scope_hash IS DISTINCT FROM NEW.operation_scope_hash
  THEN
    RAISE EXCEPTION 'candidate authority filesystem scope is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle <> 'issued'
      OR operation.lifecycle <> 'reserved'
      OR NEW.expires_at <= now()
      OR NEW.expires_at > operation.expires_at
    THEN
      RAISE EXCEPTION 'candidate authority reservation lifecycle is invalid'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.candidate_token_hash IS DISTINCT FROM NEW.candidate_token_hash
    OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.purpose IS DISTINCT FROM NEW.purpose
    OR OLD.resource_kind IS DISTINCT FROM NEW.resource_kind
    OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
    OR OLD.operation_scope_hash IS DISTINCT FROM NEW.operation_scope_hash
    OR OLD.relative_path IS DISTINCT FROM NEW.relative_path
    OR OLD.device_id IS DISTINCT FROM NEW.device_id
    OR OLD.file_id IS DISTINCT FROM NEW.file_id
    OR OLD.change_token IS DISTINCT FROM NEW.change_token
    OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
    OR OLD.byte_length IS DISTINCT FROM NEW.byte_length
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'candidate authority descriptor and scope are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.lifecycle IS DISTINCT FROM NEW.lifecycle
    AND NOT (
      (OLD.lifecycle = 'issued' AND NEW.lifecycle IN ('attached', 'expired', 'revoked'))
      OR (OLD.lifecycle = 'attached' AND NEW.lifecycle IN ('expired', 'revoked'))
    )
  THEN
    RAISE EXCEPTION 'candidate authority lifecycle transition is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.lifecycle = 'issued' AND NEW.lifecycle = 'attached' THEN
    IF operation.lifecycle NOT IN ('attached', 'finalized')
      OR operation.candidate_token_hash IS DISTINCT FROM NEW.candidate_token_hash
    THEN
      RAISE EXCEPTION 'candidate authority attachment evidence is invalid'
        USING ERRCODE = '55000';
    END IF;
    SELECT * INTO descriptor
      FROM durable_filesystem_descriptors
     WHERE operation_id = NEW.operation_id
       AND owner_user_id = NEW.owner_user_id
       AND descriptor_role = 'delivery'
       AND ordinal = 0;
    IF NOT FOUND
      OR descriptor.relative_path IS DISTINCT FROM NEW.relative_path
      OR descriptor.device_id IS DISTINCT FROM NEW.device_id
      OR descriptor.file_id IS DISTINCT FROM NEW.file_id
      OR descriptor.change_token IS DISTINCT FROM NEW.change_token
      OR descriptor.content_hash IS DISTINCT FROM NEW.content_hash
      OR descriptor.byte_length IS DISTINCT FROM NEW.byte_length
    THEN
      RAISE EXCEPTION 'candidate authority descriptor evidence is invalid'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.lifecycle = 'expired' AND now() < NEW.expires_at THEN
    RAISE EXCEPTION 'candidate authority is not expired'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_private_filesystem_delivery_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  operation durable_filesystem_operations%ROWTYPE;
  candidate durable_filesystem_candidate_authorities%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'private filesystem delivery grant cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO operation
    FROM durable_filesystem_operations
   WHERE id = NEW.operation_id;
  SELECT * INTO candidate
    FROM durable_filesystem_candidate_authorities
   WHERE candidate_token_hash = NEW.candidate_token_hash;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.grant_token_hash IS DISTINCT FROM NEW.grant_token_hash
      OR OLD.candidate_token_hash IS DISTINCT FROM NEW.candidate_token_hash
      OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
      OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      OR OLD.purpose IS DISTINCT FROM NEW.purpose
      OR OLD.resource_kind IS DISTINCT FROM NEW.resource_kind
      OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
      OR OLD.operation_scope_hash IS DISTINCT FROM NEW.operation_scope_hash
      OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'private filesystem delivery grant authority is immutable'
        USING ERRCODE = '55000';
    END IF;

    IF OLD.lifecycle <> 'issued' THEN
      RAISE EXCEPTION 'terminal private filesystem delivery grant cannot be replayed'
        USING ERRCODE = '55000';
    END IF;

    IF OLD.lifecycle IS DISTINCT FROM NEW.lifecycle
      AND NOT (OLD.lifecycle = 'issued' AND NEW.lifecycle IN ('redeemed', 'expired', 'revoked'))
    THEN
      RAISE EXCEPTION 'private filesystem delivery grant lifecycle transition is invalid'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.lifecycle = 'redeemed' AND now() >= NEW.expires_at THEN
      RAISE EXCEPTION 'private filesystem delivery grant is stale'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.lifecycle = 'redeemed'
      AND (
        operation.lifecycle <> 'finalized'
        OR operation.candidate_token_hash IS DISTINCT FROM NEW.candidate_token_hash
        OR candidate.lifecycle <> 'attached'
        OR candidate.expires_at <= now()
      )
    THEN
      RAISE EXCEPTION 'private filesystem delivery grant authority is no longer active'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.lifecycle = 'expired' AND now() < NEW.expires_at THEN
      RAISE EXCEPTION 'private filesystem delivery grant is not expired'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.lifecycle <> 'issued'
    OR NEW.expires_at <= now()
    OR NEW.expires_at > clock_timestamp() + private_filesystem_delivery_grant_max_lifetime()
    OR NEW.expires_at > candidate.expires_at
    OR operation.lifecycle <> 'finalized'
    OR operation.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR operation.purpose IS DISTINCT FROM NEW.purpose
    OR operation.resource_kind IS DISTINCT FROM NEW.resource_kind
    OR operation.asset_id IS DISTINCT FROM NEW.asset_id
    OR operation.operation_scope_hash IS DISTINCT FROM NEW.operation_scope_hash
    OR operation.candidate_token_hash IS DISTINCT FROM NEW.candidate_token_hash
    OR candidate.lifecycle <> 'attached'
    OR candidate.operation_id IS DISTINCT FROM NEW.operation_id
    OR candidate.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR candidate.purpose IS DISTINCT FROM NEW.purpose
    OR candidate.resource_kind IS DISTINCT FROM NEW.resource_kind
    OR candidate.asset_id IS DISTINCT FROM NEW.asset_id
    OR candidate.operation_scope_hash IS DISTINCT FROM NEW.operation_scope_hash
    OR candidate.expires_at <= now()
  THEN
    RAISE EXCEPTION 'private filesystem delivery grant scope or lifecycle is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
