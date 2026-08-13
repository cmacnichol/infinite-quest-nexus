-- Up Migration

-- Task 14e3b1 is additive. Existing path-backed assets remain unclassified
-- (filesystem_operation_id IS NULL) until a later, explicit migration proves
-- an identity-bound operation. No path is interpreted or backfilled here.

ALTER TABLE durable_filesystem_operations
  ADD CONSTRAINT durable_filesystem_asset_scope_unique
  UNIQUE (id, owner_user_id, purpose, asset_id);

ALTER TABLE assets
  ADD COLUMN filesystem_operation_id uuid,
  ADD COLUMN filesystem_operation_purpose text
    GENERATED ALWAYS AS ('asset_original'::text) STORED NOT NULL,
  ADD CONSTRAINT assets_filesystem_operation_fk
    FOREIGN KEY (
      filesystem_operation_id,
      owner_user_id,
      filesystem_operation_purpose,
      id
    ) REFERENCES durable_filesystem_operations(id, owner_user_id, purpose, asset_id)
    ON DELETE RESTRICT;

ALTER TABLE asset_derivatives
  ADD COLUMN filesystem_operation_id uuid,
  ADD COLUMN filesystem_operation_purpose text
    GENERATED ALWAYS AS ('asset_derivative'::text) STORED NOT NULL,
  ADD CONSTRAINT asset_derivatives_filesystem_operation_fk
    FOREIGN KEY (
      filesystem_operation_id,
      owner_user_id,
      filesystem_operation_purpose,
      source_asset_id
    ) REFERENCES durable_filesystem_operations(id, owner_user_id, purpose, asset_id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX assets_filesystem_operation_idx
  ON assets(filesystem_operation_id)
  WHERE filesystem_operation_id IS NOT NULL;
CREATE UNIQUE INDEX asset_derivatives_filesystem_operation_idx
  ON asset_derivatives(filesystem_operation_id)
  WHERE filesystem_operation_id IS NOT NULL;

CREATE FUNCTION enforce_asset_filesystem_binding_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.filesystem_operation_id IS NOT NULL
    AND OLD.filesystem_operation_id IS DISTINCT FROM NEW.filesystem_operation_id
  THEN
    RAISE EXCEPTION 'asset filesystem operation binding is write-once'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assets_filesystem_binding_immutable_trigger
BEFORE UPDATE ON assets
FOR EACH ROW EXECUTE FUNCTION enforce_asset_filesystem_binding_immutability();

CREATE TRIGGER asset_derivatives_filesystem_binding_immutable_trigger
BEFORE UPDATE ON asset_derivatives
FOR EACH ROW EXECUTE FUNCTION enforce_asset_filesystem_binding_immutability();

-- The candidate is a restart-realizable relation, not merely an attachment
-- column. Only the SHA-256 digest of the raw candidate is retained.
CREATE TABLE durable_filesystem_candidate_authorities (
  candidate_token_hash text PRIMARY KEY CHECK (candidate_token_hash ~ '^[0-9a-f]{64}$'),
  operation_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN (
    'asset_original', 'asset_derivative', 'portable_staging', 'portable_export'
  )),
  resource_kind text NOT NULL CHECK (resource_kind IN ('asset', 'portable')),
  asset_id uuid,
  operation_scope_hash text CHECK (
    operation_scope_hash IS NULL OR operation_scope_hash ~ '^[0-9a-f]{64}$'
  ),
  relative_path text NOT NULL CHECK (
    relative_path <> ''
    AND relative_path !~ '(^/|^[A-Za-z]:|^\\\\|\\\\|(^|/)\.\.?(/|$))'
  ),
  device_id text NOT NULL CHECK (btrim(device_id) <> ''),
  file_id text NOT NULL CHECK (btrim(file_id) <> ''),
  change_token text NOT NULL CHECK (btrim(change_token) <> ''),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  lifecycle text NOT NULL DEFAULT 'issued'
    CHECK (lifecycle IN ('issued', 'attached', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_token_hash, operation_id, owner_user_id, purpose),
  FOREIGN KEY (operation_id, owner_user_id, purpose)
    REFERENCES durable_filesystem_operations(id, owner_user_id, purpose)
    ON DELETE RESTRICT,
  CONSTRAINT durable_candidate_scope_check CHECK (
    (resource_kind = 'asset'
      AND purpose IN ('asset_original', 'asset_derivative')
      AND asset_id IS NOT NULL
      AND operation_scope_hash IS NULL)
    OR
    (resource_kind = 'portable'
      AND purpose IN ('portable_staging', 'portable_export')
      AND asset_id IS NULL
      AND operation_scope_hash IS NOT NULL)
  )
);

CREATE INDEX durable_filesystem_candidate_authorities_expiry_idx
  ON durable_filesystem_candidate_authorities(lifecycle, expires_at, created_at, operation_id)
  WHERE lifecycle = 'issued';

CREATE FUNCTION enforce_durable_filesystem_candidate_authority() RETURNS trigger
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

CREATE TRIGGER durable_filesystem_candidate_authorities_trigger
BEFORE INSERT OR UPDATE OR DELETE ON durable_filesystem_candidate_authorities
FOR EACH ROW EXECUTE FUNCTION enforce_durable_filesystem_candidate_authority();

-- Raw delivery grants are returned once to the trusted adapter. The database
-- retains only their hashes plus the exact finalized candidate and descriptor.
CREATE TABLE private_filesystem_delivery_grants (
  grant_token_hash text PRIMARY KEY CHECK (grant_token_hash ~ '^[0-9a-f]{64}$'),
  candidate_token_hash text NOT NULL CHECK (candidate_token_hash ~ '^[0-9a-f]{64}$'),
  operation_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN (
    'asset_original', 'asset_derivative', 'portable_staging', 'portable_export'
  )),
  resource_kind text NOT NULL CHECK (resource_kind IN ('asset', 'portable')),
  asset_id uuid,
  operation_scope_hash text CHECK (
    operation_scope_hash IS NULL OR operation_scope_hash ~ '^[0-9a-f]{64}$'
  ),
  descriptor_role text GENERATED ALWAYS AS ('delivery'::text) STORED,
  descriptor_ordinal integer GENERATED ALWAYS AS (0) STORED,
  lifecycle text NOT NULL DEFAULT 'issued'
    CHECK (lifecycle IN ('issued', 'redeemed', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  expired_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (candidate_token_hash, operation_id, owner_user_id, purpose)
    REFERENCES durable_filesystem_candidate_authorities(
      candidate_token_hash, operation_id, owner_user_id, purpose
    ) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id, owner_user_id, descriptor_role, descriptor_ordinal)
    REFERENCES durable_filesystem_descriptors(operation_id, owner_user_id, descriptor_role, ordinal)
    ON DELETE RESTRICT,
  CONSTRAINT private_delivery_grant_scope_check CHECK (
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
  CONSTRAINT private_delivery_grant_completion_check CHECK (
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

CREATE INDEX private_filesystem_delivery_grants_expiry_idx
  ON private_filesystem_delivery_grants(lifecycle, expires_at, created_at, operation_id)
  WHERE lifecycle = 'issued';

-- This named 60-second ceiling mirrors
-- PRIVATE_FILESYSTEM_DELIVERY_GRANT_MAX_LIFETIME_MS in the adapter-private
-- application contract. The grant is a raw, one-time bearer capability.
CREATE FUNCTION private_filesystem_delivery_grant_max_lifetime() RETURNS interval
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT interval '60 seconds';
$$;

CREATE FUNCTION enforce_private_filesystem_delivery_grant() RETURNS trigger
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

CREATE TRIGGER private_filesystem_delivery_grants_trigger
BEFORE INSERT OR UPDATE OR DELETE ON private_filesystem_delivery_grants
FOR EACH ROW EXECUTE FUNCTION enforce_private_filesystem_delivery_grant();

-- Down Migration

DROP TRIGGER IF EXISTS private_filesystem_delivery_grants_trigger
  ON private_filesystem_delivery_grants;
DROP FUNCTION IF EXISTS enforce_private_filesystem_delivery_grant();
DROP TABLE IF EXISTS private_filesystem_delivery_grants;
DROP FUNCTION IF EXISTS private_filesystem_delivery_grant_max_lifetime();

DROP TRIGGER IF EXISTS durable_filesystem_candidate_authorities_trigger
  ON durable_filesystem_candidate_authorities;
DROP FUNCTION IF EXISTS enforce_durable_filesystem_candidate_authority();
DROP TABLE IF EXISTS durable_filesystem_candidate_authorities;

DROP TRIGGER IF EXISTS asset_derivatives_filesystem_binding_immutable_trigger
  ON asset_derivatives;
DROP TRIGGER IF EXISTS assets_filesystem_binding_immutable_trigger ON assets;
DROP FUNCTION IF EXISTS enforce_asset_filesystem_binding_immutability();

DROP INDEX IF EXISTS asset_derivatives_filesystem_operation_idx;
DROP INDEX IF EXISTS assets_filesystem_operation_idx;

ALTER TABLE asset_derivatives
  DROP CONSTRAINT IF EXISTS asset_derivatives_filesystem_operation_fk,
  DROP COLUMN IF EXISTS filesystem_operation_purpose,
  DROP COLUMN IF EXISTS filesystem_operation_id;

ALTER TABLE assets
  DROP CONSTRAINT IF EXISTS assets_filesystem_operation_fk,
  DROP COLUMN IF EXISTS filesystem_operation_purpose,
  DROP COLUMN IF EXISTS filesystem_operation_id;

ALTER TABLE durable_filesystem_operations
  DROP CONSTRAINT IF EXISTS durable_filesystem_asset_scope_unique;
