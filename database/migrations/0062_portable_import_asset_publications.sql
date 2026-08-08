-- Up Migration

-- A committed portable import must retain the exact publication identities it
-- attached. Campaign references are deliberately insufficient: later assets
-- may belong to the same campaign but not to this import operation.
ALTER TABLE imports
  ADD CONSTRAINT imports_id_owner_unique UNIQUE (id, owner_user_id);

-- A reservation intent closes the process-loss interval between publication-
-- identity creation and the transaction that claims the portable preview. It
-- carries hashes and UUIDs only: archive bytes and filesystem authority remain
-- in their existing bounded/durable stores.
CREATE TABLE portable_import_asset_reservation_intents (
  operation_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 1000),
  asset_id uuid NOT NULL,
  commit_idempotency_key_hash text NOT NULL
    CHECK (commit_idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  command_fingerprint text NOT NULL
    CHECK (command_fingerprint ~ '^[0-9a-f]{64}$'),
  asset_idempotency_key_hash text NOT NULL
    CHECK (asset_idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  asset_request_fingerprint text NOT NULL
    CHECK (asset_request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation_id, ordinal),
  UNIQUE (operation_id, asset_id),
  UNIQUE (owner_user_id, asset_id),
  FOREIGN KEY (operation_id, owner_user_id)
    REFERENCES portable_import_operations(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id, owner_user_id)
    REFERENCES asset_publication_identities(asset_id, owner_user_id) ON DELETE RESTRICT
);

CREATE INDEX portable_import_asset_reservation_intents_owner_idx
  ON portable_import_asset_reservation_intents(owner_user_id, operation_id, ordinal);

CREATE FUNCTION enforce_portable_import_asset_reservation_intent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'portable import asset reservation intent is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM portable_import_operations operation
        LEFT JOIN asset_publication_identities publication
          ON publication.asset_id=OLD.asset_id
         AND publication.owner_user_id=OLD.owner_user_id
       WHERE operation.id=OLD.operation_id
         AND operation.owner_user_id=OLD.owner_user_id
         AND (
           EXISTS (
             SELECT 1 FROM portable_import_asset_publications mapped
              WHERE mapped.operation_id=OLD.operation_id
                AND mapped.owner_user_id=OLD.owner_user_id
                AND mapped.asset_id=OLD.asset_id
           )
           OR (
             operation.status IN ('previewed','consuming','expired','failed')
             AND publication.lifecycle IN ('prepared','cleanup_pending')
             AND NOT EXISTS (
               SELECT 1 FROM durable_filesystem_operations durable
                WHERE durable.asset_id=OLD.asset_id
                  AND durable.owner_user_id=OLD.owner_user_id
                  AND durable.lifecycle <> 'cleaned'
             )
           )
         )
    ) THEN
      RAISE EXCEPTION 'portable import asset reservation retirement is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM portable_import_operations operation
      JOIN portable_import_work work
        ON work.operation_id=operation.id
       AND work.owner_user_id=operation.owner_user_id
      JOIN asset_publication_identities publication
        ON publication.asset_id=NEW.asset_id
       AND publication.owner_user_id=NEW.owner_user_id
     WHERE operation.id=NEW.operation_id
       AND operation.owner_user_id=NEW.owner_user_id
       AND operation.import_kind='campaign_zip'
       AND operation.status='previewed'
       AND operation.authority_fingerprint IS NOT NULL
       AND operation.expires_at > clock_timestamp()
       AND work.status IN ('running','recoverable')
       AND work.expires_at > clock_timestamp()
       AND publication.lifecycle='prepared'
       AND publication.idempotency_key_hash=NEW.asset_idempotency_key_hash
       AND publication.request_fingerprint=NEW.asset_request_fingerprint
  ) THEN
    RAISE EXCEPTION 'portable import asset reservation intent is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portable_import_asset_reservation_intents_guard_trigger
BEFORE INSERT OR UPDATE OR DELETE ON portable_import_asset_reservation_intents
FOR EACH ROW EXECUTE FUNCTION enforce_portable_import_asset_reservation_intent();

CREATE TABLE portable_import_asset_publications (
  operation_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  import_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation_id, asset_id),
  UNIQUE (import_id, asset_id),
  FOREIGN KEY (operation_id, owner_user_id)
    REFERENCES portable_import_operations(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (import_id, owner_user_id)
    REFERENCES imports(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id, owner_user_id)
    REFERENCES asset_publication_identities(asset_id, owner_user_id) ON DELETE RESTRICT
);

CREATE INDEX portable_import_asset_publications_import_idx
  ON portable_import_asset_publications(owner_user_id, import_id, asset_id);

CREATE FUNCTION enforce_portable_import_asset_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'portable import asset publication association is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM portable_import_operations operation
      JOIN portable_import_work work
        ON work.operation_id=operation.id
       AND work.owner_user_id=operation.owner_user_id
      JOIN imports imported
        ON imported.id=NEW.import_id
       AND imported.owner_user_id=NEW.owner_user_id
      JOIN asset_publication_identities publication
        ON publication.asset_id=NEW.asset_id
       AND publication.owner_user_id=NEW.owner_user_id
      JOIN asset_references reference
        ON reference.asset_id=NEW.asset_id
       AND reference.owner_user_id=NEW.owner_user_id
       AND reference.campaign_id=imported.campaign_id
       AND reference.asset_role='import_attachment'
     WHERE operation.id=NEW.operation_id
       AND operation.owner_user_id=NEW.owner_user_id
       AND operation.import_kind='campaign_zip'
       AND operation.status='consuming'
       AND operation.import_id IS NULL
       AND operation.authority_fingerprint=imported.source_hash
       AND work.status='running'
       AND work.lease_id IS NOT NULL
       AND work.lease_expires_at > clock_timestamp()
       AND imported.status='completed'
       AND imported.source_type='portable_campaign_zip'
       AND imported.campaign_id IS NOT NULL
       AND publication.lifecycle IN ('attached','published')
  ) THEN
    RAISE EXCEPTION 'portable import asset publication association is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portable_import_asset_publications_guard_trigger
BEFORE INSERT OR UPDATE OR DELETE ON portable_import_asset_publications
FOR EACH ROW EXECUTE FUNCTION enforce_portable_import_asset_publication();

-- Down Migration

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM portable_import_asset_publications)
    OR EXISTS (SELECT 1 FROM portable_import_asset_reservation_intents) THEN
    RAISE EXCEPTION 'cannot downgrade portable import asset publications while retained mappings exist'
      USING ERRCODE = '55006';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS portable_import_asset_publications_guard_trigger
  ON portable_import_asset_publications;
DROP FUNCTION IF EXISTS enforce_portable_import_asset_publication();
DROP TABLE IF EXISTS portable_import_asset_publications;
DROP TRIGGER IF EXISTS portable_import_asset_reservation_intents_guard_trigger
  ON portable_import_asset_reservation_intents;
DROP FUNCTION IF EXISTS enforce_portable_import_asset_reservation_intent();
DROP TABLE IF EXISTS portable_import_asset_reservation_intents;
ALTER TABLE imports DROP CONSTRAINT IF EXISTS imports_id_owner_unique;
