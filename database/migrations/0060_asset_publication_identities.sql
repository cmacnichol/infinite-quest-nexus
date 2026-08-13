-- Up Migration

-- A durable asset operation must be able to reserve a stable logical identity
-- before any filesystem mutation, without first creating a path-bearing asset
-- row. These records are deliberately owner-scoped and retain only hashed
-- idempotency material; they are not delivery or filesystem authority.
CREATE TABLE asset_publication_identities (
  asset_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key_hash text,
  request_fingerprint text,
  lifecycle text NOT NULL DEFAULT 'prepared'
    CHECK (lifecycle IN ('legacy', 'prepared', 'attached', 'published', 'cleanup_pending')),
  result jsonb,
  pending_finalization jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  UNIQUE (asset_id, owner_user_id),
  CONSTRAINT asset_publication_identity_hashes_check CHECK (
    (lifecycle = 'legacy'
      AND idempotency_key_hash IS NULL
      AND request_fingerprint IS NULL
      AND result IS NULL
      AND pending_finalization IS NULL
      AND published_at IS NULL)
    OR
    (lifecycle IN ('prepared', 'cleanup_pending')
      AND idempotency_key_hash ~ '^[0-9a-f]{64}$'
      AND request_fingerprint ~ '^[0-9a-f]{64}$'
      AND result IS NULL
      AND pending_finalization IS NULL
      AND published_at IS NULL)
    OR
    (lifecycle = 'attached'
      AND idempotency_key_hash ~ '^[0-9a-f]{64}$'
      AND request_fingerprint ~ '^[0-9a-f]{64}$'
      AND result IS NOT NULL
      AND pending_finalization IS NOT NULL
      AND published_at IS NULL)
    OR
    (lifecycle = 'published'
      AND idempotency_key_hash ~ '^[0-9a-f]{64}$'
      AND request_fingerprint ~ '^[0-9a-f]{64}$'
      AND result IS NOT NULL
      AND pending_finalization IS NULL
      AND published_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX asset_publication_identity_idempotency_idx
  ON asset_publication_identities(owner_user_id, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;

-- Existing assets retain their logical identity without being assigned a new
-- idempotency key or mutable publication result.
INSERT INTO asset_publication_identities (asset_id, owner_user_id, lifecycle)
SELECT id, owner_user_id, 'legacy'
  FROM assets
ON CONFLICT (asset_id) DO NOTHING;

-- The retargeted durable-operation foreign key also applies to legacy writers
-- that create an asset before they reserve a later operation. Those rows get a
-- non-retryable legacy identity; publication's prepared identity wins on the
-- same UUID through the conflict guard below.
CREATE FUNCTION create_legacy_asset_publication_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO asset_publication_identities (asset_id, owner_user_id, lifecycle)
  VALUES (NEW.id, NEW.owner_user_id, 'legacy')
  ON CONFLICT (asset_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER create_legacy_asset_publication_identity_trigger
AFTER INSERT ON assets
FOR EACH ROW EXECUTE FUNCTION create_legacy_asset_publication_identity();

-- Retargeting the durable-operation foreign key preserves the identity needed
-- before an asset exists. Preserve the former assets-row retention invariant
-- separately for assets that do exist: a durable asset operation may not lose
-- its physical asset row while it remains authoritative.
CREATE FUNCTION enforce_durable_asset_operation_retention() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  identity_lifecycle text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.resource_kind <> 'asset' THEN RETURN NEW; END IF;

    -- The insert-side guard is deliberately reciprocal to the DELETE guard:
    -- if deletion wins this identity lock, an operation insert that resumes
    -- later must re-observe the missing legacy asset and fail instead of
    -- becoming a durable orphan. Prepared identities intentionally have no
    -- physical asset row yet, so only legacy identities require that row.
    SELECT lifecycle INTO identity_lifecycle
      FROM asset_publication_identities
     WHERE asset_id = NEW.asset_id
       AND owner_user_id = NEW.owner_user_id
     FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'durable asset operation requires a publication identity'
        USING ERRCODE = '23503';
    END IF;
    IF identity_lifecycle = 'legacy' THEN
      PERFORM 1
        FROM assets
       WHERE id = NEW.asset_id
         AND owner_user_id = NEW.owner_user_id
       FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'durable asset operation requires a physical asset for a legacy identity'
          USING ERRCODE = '23503';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Coordinate with the reciprocal insert guard. An in-flight operation
  -- insert holds a key-share lock on this identity; locking it here ensures
  -- the retention check observes a committed operation before an asset can
  -- leave, and prevents an insert from slipping through after this DELETE.
  PERFORM 1
    FROM asset_publication_identities
   WHERE asset_id = OLD.id
     AND owner_user_id = OLD.owner_user_id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM durable_filesystem_operations operation
     WHERE operation.resource_kind = 'asset'
       AND operation.asset_id = OLD.id
       AND operation.owner_user_id = OLD.owner_user_id
  ) THEN
    RAISE EXCEPTION 'asset referenced by a durable filesystem operation cannot be deleted'
      USING ERRCODE = '23503';
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER durable_asset_operation_retention_trigger
BEFORE DELETE ON assets
FOR EACH ROW EXECUTE FUNCTION enforce_durable_asset_operation_retention();

CREATE TRIGGER durable_asset_operation_retention_insert_trigger
BEFORE INSERT ON durable_filesystem_operations
FOR EACH ROW EXECUTE FUNCTION enforce_durable_asset_operation_retention();

ALTER TABLE durable_filesystem_operations
  DROP CONSTRAINT durable_filesystem_operations_asset_id_owner_user_id_fkey,
  ADD CONSTRAINT durable_filesystem_operations_asset_identity_fk
    FOREIGN KEY (asset_id, owner_user_id)
    REFERENCES asset_publication_identities(asset_id, owner_user_id)
    ON DELETE RESTRICT;

-- Asset publication records an immutable, hash-addressed target before its
-- first filesystem mutation. Portable targets retain their operation-derived
-- paths; asset targets are content-derived so separately owned operations can
-- verify and share the same physical bytes without sharing authorization.
ALTER TABLE durable_filesystem_prewrite_nodes
  DROP CONSTRAINT durable_filesystem_prewrite_nodes_check,
  ADD CONSTRAINT durable_filesystem_prewrite_target_check CHECK (
    (purpose IN ('asset_original', 'asset_derivative')
      AND relative_path ~ '^assets/content/[0-9a-f]{64}$')
    OR
    (purpose IN ('portable_staging', 'portable_export')
      AND relative_path = durable_filesystem_expected_prewrite_path(operation_id, purpose))
  );

-- Down Migration

-- Never discard a retry/cleanup identity or an operation that no longer has a
-- legacy assets-row parent merely to make a downgrade succeed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM asset_publication_identities identity
      LEFT JOIN assets asset
        ON asset.id = identity.asset_id
       AND asset.owner_user_id = identity.owner_user_id
     WHERE identity.lifecycle <> 'legacy'
        OR asset.id IS NULL
  ) OR EXISTS (
    SELECT 1
      FROM durable_filesystem_operations operation
      LEFT JOIN assets asset
        ON asset.id = operation.asset_id
       AND asset.owner_user_id = operation.owner_user_id
     WHERE operation.resource_kind = 'asset'
       AND asset.id IS NULL
  ) THEN
    RAISE EXCEPTION 'asset publication identity downgrade would discard pending authority'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

ALTER TABLE durable_filesystem_operations
  DROP CONSTRAINT durable_filesystem_operations_asset_identity_fk,
  ADD CONSTRAINT durable_filesystem_operations_asset_id_owner_user_id_fkey
    FOREIGN KEY (asset_id, owner_user_id)
    REFERENCES assets(id, owner_user_id)
    ON DELETE RESTRICT;

ALTER TABLE durable_filesystem_prewrite_nodes
  DROP CONSTRAINT durable_filesystem_prewrite_target_check,
  ADD CONSTRAINT durable_filesystem_prewrite_nodes_check CHECK (
    relative_path = durable_filesystem_expected_prewrite_path(operation_id, purpose)
  );

DROP TRIGGER durable_asset_operation_retention_insert_trigger ON durable_filesystem_operations;
DROP TRIGGER durable_asset_operation_retention_trigger ON assets;
DROP FUNCTION enforce_durable_asset_operation_retention();

DROP TRIGGER create_legacy_asset_publication_identity_trigger ON assets;
DROP FUNCTION create_legacy_asset_publication_identity();

DROP INDEX asset_publication_identity_idempotency_idx;
DROP TABLE asset_publication_identities;
