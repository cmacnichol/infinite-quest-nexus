-- Up Migration

-- Legacy Story imports use the same durable reservation and exact publication
-- mapping lifecycle as Campaign ZIP. The source type remains family-specific.
CREATE OR REPLACE FUNCTION enforce_portable_import_asset_reservation_intent() RETURNS trigger
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
       AND operation.import_kind IN ('campaign_zip','legacy_story')
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

CREATE OR REPLACE FUNCTION enforce_portable_import_asset_publication() RETURNS trigger
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
       AND operation.import_kind IN ('campaign_zip','legacy_story')
       AND operation.status='consuming'
       AND operation.import_id IS NULL
       AND operation.authority_fingerprint=imported.source_hash
       AND work.status='running'
       AND work.lease_id IS NOT NULL
       AND work.lease_expires_at > clock_timestamp()
       AND imported.status='completed'
       AND (
         (operation.import_kind='campaign_zip' AND imported.source_type='portable_campaign_zip')
         OR
         (operation.import_kind='legacy_story' AND imported.source_type='portable_legacy_story')
       )
       AND imported.campaign_id IS NOT NULL
       AND publication.lifecycle IN ('attached','published')
  ) THEN
    RAISE EXCEPTION 'portable import asset publication association is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Down Migration

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM portable_import_asset_publications mapped
      JOIN portable_import_operations operation
        ON operation.id=mapped.operation_id
       AND operation.owner_user_id=mapped.owner_user_id
     WHERE operation.import_kind='legacy_story'
  ) OR EXISTS (
    SELECT 1
      FROM portable_import_asset_reservation_intents intent
      JOIN portable_import_operations operation
        ON operation.id=intent.operation_id
       AND operation.owner_user_id=intent.owner_user_id
     WHERE operation.import_kind='legacy_story'
  ) THEN
    RAISE EXCEPTION 'cannot downgrade portable Legacy Story asset publications while retained mappings exist'
      USING ERRCODE = '55006';
  END IF;
END;
$$;

-- Restore the Campaign-ZIP-only 0062 guards exactly.
CREATE OR REPLACE FUNCTION enforce_portable_import_asset_reservation_intent() RETURNS trigger
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

CREATE OR REPLACE FUNCTION enforce_portable_import_asset_publication() RETURNS trigger
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
