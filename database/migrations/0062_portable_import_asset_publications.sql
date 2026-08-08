-- Up Migration

-- A committed portable import must retain the exact publication identities it
-- attached. Campaign references are deliberately insufficient: later assets
-- may belong to the same campaign but not to this import operation.
ALTER TABLE imports
  ADD CONSTRAINT imports_id_owner_unique UNIQUE (id, owner_user_id);

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

DROP TRIGGER IF EXISTS portable_import_asset_publications_guard_trigger
  ON portable_import_asset_publications;
DROP FUNCTION IF EXISTS enforce_portable_import_asset_publication();
DROP TABLE IF EXISTS portable_import_asset_publications;
ALTER TABLE imports DROP CONSTRAINT IF EXISTS imports_id_owner_unique;
