-- Up Migration

-- 0060 owns the durable filesystem lifecycle for one logical asset.  A
-- publication request is deliberately separate: several owner-scoped requests
-- may converge on one canonical asset while retaining their own idempotency,
-- provenance, library intent, and later context/reference children.
CREATE TABLE asset_publication_content_arbitrations (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  canonical_asset_id uuid NOT NULL,
  verification_state text NOT NULL CHECK (verification_state IN ('verified', 'verification_required')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_user_id, content_hash),
  UNIQUE (owner_user_id, canonical_asset_id),
  FOREIGN KEY (canonical_asset_id, owner_user_id)
    REFERENCES asset_publication_identities(asset_id, owner_user_id) ON DELETE CASCADE
);

CREATE TABLE asset_publication_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  canonical_content_hash text CHECK (canonical_content_hash IS NULL OR canonical_content_hash ~ '^[0-9a-f]{64}$'),
  canonical_asset_id uuid,
  lifecycle text NOT NULL DEFAULT 'prepared'
    CHECK (lifecycle IN ('prepared', 'attached', 'published', 'cleanup_pending', 'failed')),
  requested_library_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  UNIQUE (owner_user_id, idempotency_key_hash),
  UNIQUE (id, owner_user_id),
  FOREIGN KEY (canonical_asset_id, owner_user_id)
    REFERENCES asset_publication_identities(asset_id, owner_user_id) ON DELETE SET NULL (canonical_asset_id),
  FOREIGN KEY (owner_user_id, canonical_content_hash)
    REFERENCES asset_publication_content_arbitrations(owner_user_id, content_hash) ON DELETE SET NULL (canonical_content_hash),
  CONSTRAINT asset_publication_request_result_lifecycle_check CHECK (
    (lifecycle IN ('prepared', 'cleanup_pending', 'failed') AND result IS NULL AND published_at IS NULL)
    OR (lifecycle = 'attached' AND result IS NOT NULL AND published_at IS NULL)
    OR (lifecycle = 'published' AND result IS NOT NULL AND published_at IS NOT NULL)
  )
);

CREATE TABLE asset_publication_request_results (
  request_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (request_id, owner_user_id),
  FOREIGN KEY (request_id, owner_user_id)
    REFERENCES asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT
);

CREATE TABLE asset_publication_request_sources (
  request_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 1000),
  source_kind text NOT NULL CHECK (source_kind IN ('campaign_zip', 'legacy_story')),
  source_asset_id text NOT NULL CHECK (length(source_asset_id) BETWEEN 1 AND 500),
  source_record_id text,
  source_key text,
  requested_library_snapshot jsonb NOT NULL,
  binding_intent_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (request_id, owner_user_id, ordinal),
  UNIQUE (request_id, owner_user_id, source_kind, source_asset_id, source_record_id, source_key),
  FOREIGN KEY (request_id, owner_user_id)
    REFERENCES asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT,
  CHECK (source_record_id IS NULL OR length(source_record_id) BETWEEN 1 AND 500),
  CHECK (source_key IS NULL OR length(source_key) BETWEEN 1 AND 1000),
  CHECK (jsonb_typeof(binding_intent_keys) = 'array')
);

CREATE TABLE asset_publication_request_contexts (
  request_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  intent_key text NOT NULL CHECK (length(intent_key) BETWEEN 1 AND 500),
  context_snapshot jsonb NOT NULL,
  context_id uuid,
  PRIMARY KEY (request_id, owner_user_id, intent_key),
  FOREIGN KEY (request_id, owner_user_id)
    REFERENCES asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT
);

CREATE TABLE asset_publication_request_references (
  request_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  intent_key text NOT NULL CHECK (length(intent_key) BETWEEN 1 AND 500),
  reference_snapshot jsonb NOT NULL,
  reference_id uuid,
  PRIMARY KEY (request_id, owner_user_id, intent_key),
  FOREIGN KEY (request_id, owner_user_id)
    REFERENCES asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT
);

CREATE TABLE asset_publication_request_derivatives (
  request_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 100),
  slot_snapshot jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  technical_metadata jsonb NOT NULL,
  derivative_id uuid,
  PRIMARY KEY (request_id, owner_user_id, ordinal),
  UNIQUE (request_id, owner_user_id, content_hash),
  FOREIGN KEY (request_id, owner_user_id)
    REFERENCES asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT
);

-- The existing assets INSERT trigger remains the single library-row creator.
-- A normalized request stages its frozen representative snapshot before that
-- INSERT; the trigger consumes it atomically instead of manufacturing a legacy
-- default that a later request would need to overwrite.
CREATE TABLE asset_publication_library_initializations (
  request_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  canonical_asset_id uuid NOT NULL,
  library_snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'applied')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  PRIMARY KEY (request_id, owner_user_id),
  UNIQUE (owner_user_id, canonical_asset_id),
  FOREIGN KEY (request_id, owner_user_id)
    REFERENCES asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (canonical_asset_id, owner_user_id)
    REFERENCES asset_publication_identities(asset_id, owner_user_id) ON DELETE RESTRICT,
  CHECK ((state = 'pending' AND applied_at IS NULL) OR (state = 'applied' AND applied_at IS NOT NULL))
);

-- Backfill every physical legacy asset into the owner/hash arbitration table.
-- Historical assets predate the normalized SHA-256 contract and can carry an
-- arbitrary legacy content label.  Preserve such an asset's identity without
-- laundering that label into the normalized namespace: a deterministic,
-- owner-and-asset-scoped SHA-256 sentinel is always verification_required.
-- It cannot authorize reuse, and the original legacy label never leaves the
-- existing assets row or enter normalized request/arbitration snapshots.
INSERT INTO asset_publication_content_arbitrations (
  owner_user_id,content_hash,canonical_asset_id,verification_state
)
SELECT asset.owner_user_id,
       CASE WHEN asset.content_hash ~ '^[0-9a-f]{64}$' THEN asset.content_hash
            ELSE encode(sha256(convert_to(
              'legacy-unverified-content:' || asset.owner_user_id::text || ':' || asset.id::text,
              'UTF8'
            )), 'hex')
       END,
       asset.id,
       CASE WHEN asset.content_hash ~ '^[0-9a-f]{64}$'
                   AND asset.pixel_width IS NOT NULL
                   AND asset.pixel_height IS NOT NULL
                   AND asset.technical_metadata ? 'format'
            THEN 'verified' ELSE 'verification_required' END
  FROM assets asset
ON CONFLICT (owner_user_id, content_hash) DO NOTHING;

-- A prewrite descriptor is the authoritative source for a prepared identity
-- that has not created its assets row yet.  This preserves recovery authority
-- rather than silently dropping in-flight work during the migration.
INSERT INTO asset_publication_content_arbitrations (
  owner_user_id,content_hash,canonical_asset_id,verification_state
)
SELECT identity.owner_user_id,
       descriptor.content_hash,
       identity.asset_id,
       'verified'
  FROM asset_publication_identities identity
  JOIN LATERAL (
    SELECT filesystem_descriptor.content_hash
      FROM durable_filesystem_operations operation
      JOIN durable_filesystem_descriptors filesystem_descriptor
        ON filesystem_descriptor.operation_id=operation.id
       AND filesystem_descriptor.owner_user_id=operation.owner_user_id
     WHERE operation.resource_kind='asset'
       AND operation.owner_user_id=identity.owner_user_id
       AND operation.asset_id=identity.asset_id
       AND filesystem_descriptor.descriptor_role='delivery'
     ORDER BY operation.created_at, filesystem_descriptor.ordinal
     LIMIT 1
  ) descriptor ON true
 WHERE identity.lifecycle <> 'legacy'
ON CONFLICT (owner_user_id, content_hash) DO NOTHING;

-- Retryable 0060 identities become one request each.  Some early prepared
-- identities have not reached a descriptor yet; retain their immutable retry
-- key and canonical identity with a null content hash until e1c reloads the
-- verified artifact rather than fabricating an authority hash.
INSERT INTO asset_publication_requests (
  owner_user_id,idempotency_key_hash,request_fingerprint,canonical_content_hash,
  canonical_asset_id,lifecycle,requested_library_snapshot,provenance_snapshot,result,published_at
)
SELECT identity.owner_user_id,
       identity.idempotency_key_hash,
       identity.request_fingerprint,
       arbitration.content_hash,
       identity.asset_id,
       CASE identity.lifecycle
         WHEN 'attached' THEN 'attached'
         WHEN 'published' THEN 'published'
         WHEN 'cleanup_pending' THEN 'cleanup_pending'
         ELSE 'prepared'
       END,
       '{}'::jsonb,
       jsonb_build_object('kind','0060_backfill'),
       identity.result,
       identity.published_at
  FROM asset_publication_identities identity
  LEFT JOIN asset_publication_content_arbitrations arbitration
    ON arbitration.owner_user_id=identity.owner_user_id
   AND arbitration.canonical_asset_id=identity.asset_id
 WHERE identity.lifecycle <> 'legacy'
ON CONFLICT (owner_user_id, idempotency_key_hash) DO NOTHING;

-- A request result is deliberately independent of the canonical 0060 result.
-- Preserve historical attached/published retry responses as an immutable child
-- so e1c can return the request's own result without reading identity state.
INSERT INTO asset_publication_request_results (request_id,owner_user_id,result)
SELECT request.id,request.owner_user_id,request.result
  FROM asset_publication_requests request
 WHERE request.result IS NOT NULL
ON CONFLICT (request_id, owner_user_id) DO NOTHING;

-- 0062/0063 originally tied an import reservation to its physical identity.
-- That prevents a later normalized request from deliberately reusing a
-- published canonical asset. Keep asset_id as the canonical result/binding,
-- but make request_id the immutable import authority instead.
ALTER TABLE portable_import_asset_reservation_intents
  ADD COLUMN request_id uuid;
ALTER TABLE portable_import_asset_publications
  ADD COLUMN request_id uuid;

-- The historical guards make their rows immutable. They remain enabled for
-- normal runtime writes, but must be suspended while this one-time schema
-- migration backfills a new non-semantic authority column.
ALTER TABLE portable_import_asset_reservation_intents
  DISABLE TRIGGER portable_import_asset_reservation_intents_guard_trigger;
ALTER TABLE portable_import_asset_publications
  DISABLE TRIGGER portable_import_asset_publications_guard_trigger;

UPDATE portable_import_asset_reservation_intents intent
   SET request_id=request.id
  FROM asset_publication_requests request
 WHERE request.owner_user_id=intent.owner_user_id
   AND request.idempotency_key_hash=intent.asset_idempotency_key_hash
   AND request.request_fingerprint=intent.asset_request_fingerprint
   AND request.canonical_asset_id=intent.asset_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM portable_import_asset_reservation_intents
     WHERE request_id IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot bind portable import reservation intent to a normalized publication request'
      USING ERRCODE='23514';
  END IF;
END;
$$;

UPDATE portable_import_asset_publications publication
   SET request_id=intent.request_id
  FROM portable_import_asset_reservation_intents intent
 WHERE intent.operation_id=publication.operation_id
   AND intent.owner_user_id=publication.owner_user_id
   AND intent.asset_id=publication.asset_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM portable_import_asset_publications
     WHERE request_id IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot bind portable import publication mapping to its normalized reservation request'
      USING ERRCODE='23514';
  END IF;
END;
$$;

ALTER TABLE portable_import_asset_reservation_intents
  ALTER COLUMN request_id SET NOT NULL;

-- PostgreSQL truncates the 0062 auto-generated name on some server versions;
-- identify the old semantic unique rather than coupling 0064 to its spelling.
DO $$
DECLARE
  legacy_owner_asset_unique text;
BEGIN
  SELECT constraint_name INTO legacy_owner_asset_unique
    FROM information_schema.table_constraints
   WHERE table_schema='public'
     AND table_name='portable_import_asset_reservation_intents'
     AND constraint_type='UNIQUE'
     AND constraint_name IN (
       SELECT legacy_constraint.conname
         FROM pg_constraint legacy_constraint
        WHERE legacy_constraint.conrelid='portable_import_asset_reservation_intents'::regclass
          AND pg_get_constraintdef(legacy_constraint.oid)='UNIQUE (owner_user_id, asset_id)'
     );
  IF legacy_owner_asset_unique IS NULL THEN
    RAISE EXCEPTION 'portable import legacy owner/asset uniqueness is missing'
      USING ERRCODE='23514';
  END IF;
  EXECUTE format(
    'ALTER TABLE portable_import_asset_reservation_intents DROP CONSTRAINT %I',
    legacy_owner_asset_unique
  );
END;
$$;

ALTER TABLE portable_import_asset_reservation_intents
  ADD CONSTRAINT portable_import_asset_reservation_intents_request_fk
    FOREIGN KEY (request_id, owner_user_id)
    REFERENCES asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT portable_import_asset_reservation_intents_operation_request_unique
    UNIQUE (operation_id, request_id);
ALTER TABLE portable_import_asset_publications
  ALTER COLUMN request_id SET NOT NULL,
  ADD CONSTRAINT portable_import_asset_publications_request_fk
    FOREIGN KEY (request_id, owner_user_id)
    REFERENCES asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT portable_import_asset_publications_import_request_unique
    UNIQUE (import_id, request_id);

CREATE INDEX portable_import_asset_reservation_intents_request_idx
  ON portable_import_asset_reservation_intents(owner_user_id, request_id, operation_id);
CREATE INDEX portable_import_asset_publications_request_idx
  ON portable_import_asset_publications(owner_user_id, request_id, import_id);

ALTER TABLE portable_import_asset_reservation_intents
  ENABLE TRIGGER portable_import_asset_reservation_intents_guard_trigger;
ALTER TABLE portable_import_asset_publications
  ENABLE TRIGGER portable_import_asset_publications_guard_trigger;

-- The legacy portable composition remains live through e3g and still sends
-- the old hashes/asset UUID. Its insert is translated once, under the same
-- owner/idempotency uniqueness authority, to the exact normalized request.
-- New repositories supply request_id directly; neither path resolves a
-- collision through an application-level generic retry.
CREATE OR REPLACE FUNCTION enforce_portable_import_asset_reservation_intent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  normalized_request asset_publication_requests%ROWTYPE;
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
        LEFT JOIN asset_publication_requests request
          ON request.id=OLD.request_id
         AND request.owner_user_id=OLD.owner_user_id
       WHERE operation.id=OLD.operation_id
         AND operation.owner_user_id=OLD.owner_user_id
         AND (
           EXISTS (
             SELECT 1 FROM portable_import_asset_publications mapped
              WHERE mapped.operation_id=OLD.operation_id
                AND mapped.owner_user_id=OLD.owner_user_id
                AND mapped.request_id=OLD.request_id
           )
           OR (
             operation.status IN ('previewed','consuming','expired','failed')
             AND request.lifecycle IN ('prepared','cleanup_pending')
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

  IF NEW.request_id IS NULL THEN
    INSERT INTO asset_publication_requests (
      owner_user_id,idempotency_key_hash,request_fingerprint,canonical_content_hash,
      canonical_asset_id,lifecycle,requested_library_snapshot,provenance_snapshot
    )
    SELECT identity.owner_user_id,
           identity.idempotency_key_hash,
           identity.request_fingerprint,
           arbitration.content_hash,
           identity.asset_id,
           'prepared',
           '{}'::jsonb,
           jsonb_build_object('kind','0064_legacy_portable_intent')
      FROM asset_publication_identities identity
      LEFT JOIN asset_publication_content_arbitrations arbitration
        ON arbitration.owner_user_id=identity.owner_user_id
       AND arbitration.canonical_asset_id=identity.asset_id
     WHERE identity.asset_id=NEW.asset_id
       AND identity.owner_user_id=NEW.owner_user_id
       AND identity.lifecycle='prepared'
       AND identity.idempotency_key_hash=NEW.asset_idempotency_key_hash
       AND identity.request_fingerprint=NEW.asset_request_fingerprint
    ON CONFLICT (owner_user_id, idempotency_key_hash) DO NOTHING;

    SELECT * INTO normalized_request
      FROM asset_publication_requests request
     WHERE request.owner_user_id=NEW.owner_user_id
       AND request.idempotency_key_hash=NEW.asset_idempotency_key_hash;
    IF FOUND THEN
      NEW.request_id:=normalized_request.id;
    END IF;
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
      JOIN asset_publication_requests request
        ON request.id=NEW.request_id
       AND request.owner_user_id=NEW.owner_user_id
     WHERE operation.id=NEW.operation_id
       AND operation.owner_user_id=NEW.owner_user_id
       AND operation.import_kind IN ('campaign_zip','legacy_story')
       AND operation.status='previewed'
       AND operation.authority_fingerprint IS NOT NULL
       AND operation.expires_at > clock_timestamp()
       AND work.status IN ('running','recoverable')
       AND work.expires_at > clock_timestamp()
       AND publication.lifecycle='prepared'
       AND request.lifecycle='prepared'
       AND request.canonical_asset_id=NEW.asset_id
       AND request.idempotency_key_hash=NEW.asset_idempotency_key_hash
       AND request.request_fingerprint=NEW.asset_request_fingerprint
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

  IF NEW.request_id IS NULL THEN
    SELECT intent.request_id INTO NEW.request_id
      FROM portable_import_asset_reservation_intents intent
     WHERE intent.operation_id=NEW.operation_id
       AND intent.owner_user_id=NEW.owner_user_id
       AND intent.asset_id=NEW.asset_id;
  END IF;

  -- Compatibility bridge for the live 0060 writer: its identity is still the
  -- lifecycle authority until e1c, so mirror a successful attachment into the
  -- normalized request before this mapping is accepted. New repositories will
  -- advance both records explicitly and this update becomes a no-op.
  UPDATE asset_publication_requests request
     SET lifecycle=CASE publication.lifecycle
                     WHEN 'published' THEN 'published' ELSE 'attached' END,
         result=publication.result,
         published_at=CASE WHEN publication.lifecycle='published'
                             THEN publication.published_at ELSE NULL END,
         updated_at=clock_timestamp()
    FROM asset_publication_identities publication
   WHERE request.id=NEW.request_id
     AND request.owner_user_id=NEW.owner_user_id
     AND request.lifecycle='prepared'
     AND publication.asset_id=NEW.asset_id
     AND publication.owner_user_id=NEW.owner_user_id
     AND publication.lifecycle IN ('attached','published')
     AND publication.result IS NOT NULL;

  INSERT INTO asset_publication_request_results (request_id,owner_user_id,result)
  SELECT request.id,request.owner_user_id,request.result
    FROM asset_publication_requests request
   WHERE request.id=NEW.request_id
     AND request.owner_user_id=NEW.owner_user_id
     AND request.result IS NOT NULL
  ON CONFLICT (request_id, owner_user_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
      FROM portable_import_operations operation
      JOIN portable_import_work work
        ON work.operation_id=operation.id
       AND work.owner_user_id=operation.owner_user_id
      JOIN imports imported
        ON imported.id=NEW.import_id
       AND imported.owner_user_id=NEW.owner_user_id
      JOIN portable_import_asset_reservation_intents intent
        ON intent.operation_id=NEW.operation_id
       AND intent.owner_user_id=NEW.owner_user_id
       AND intent.asset_id=NEW.asset_id
       AND intent.request_id=NEW.request_id
      JOIN asset_publication_identities publication
        ON publication.asset_id=NEW.asset_id
       AND publication.owner_user_id=NEW.owner_user_id
      JOIN asset_publication_requests request
        ON request.id=NEW.request_id
       AND request.owner_user_id=NEW.owner_user_id
       AND request.canonical_asset_id=NEW.asset_id
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
       AND request.lifecycle IN ('attached','published')
  ) THEN
    RAISE EXCEPTION 'portable import asset publication association is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_asset_publication_request_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'asset publication request is retained authority'
      USING ERRCODE='55000';
  END IF;
  IF ROW(
    OLD.id,OLD.owner_user_id,OLD.idempotency_key_hash,OLD.request_fingerprint,
    OLD.requested_library_snapshot,OLD.provenance_snapshot,OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,NEW.owner_user_id,NEW.idempotency_key_hash,NEW.request_fingerprint,
    NEW.requested_library_snapshot,NEW.provenance_snapshot,NEW.created_at
  ) OR NOT (
    NEW.canonical_content_hash IS NOT DISTINCT FROM OLD.canonical_content_hash
    OR (OLD.canonical_content_hash IS NULL AND NEW.canonical_content_hash IS NOT NULL)
    OR (OLD.canonical_content_hash IS NOT NULL AND NEW.canonical_content_hash IS NULL)
  ) OR NOT (
    NEW.canonical_asset_id IS NOT DISTINCT FROM OLD.canonical_asset_id
    OR (OLD.canonical_asset_id IS NULL AND NEW.canonical_asset_id IS NOT NULL)
    OR (OLD.canonical_asset_id IS NOT NULL AND NEW.canonical_asset_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'asset publication request immutable fields cannot change'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_asset_publication_request_canonical_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  arbitration asset_publication_content_arbitrations%ROWTYPE;
BEGIN
  -- A request may exist before a descriptor has yielded a content hash, but
  -- once it names canonical content it must name the verified arbitration's
  -- exact identity. This blocks verification_required legacy rows until e3e5
  -- upgrades their technical facts under its own reviewed transition.
  IF NEW.canonical_content_hash IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO arbitration
    FROM asset_publication_content_arbitrations
   WHERE owner_user_id=NEW.owner_user_id
     AND content_hash=NEW.canonical_content_hash;
  IF NOT FOUND OR arbitration.verification_state <> 'verified'
    OR NEW.canonical_asset_id IS DISTINCT FROM arbitration.canonical_asset_id
  THEN
    RAISE EXCEPTION 'asset publication canonical binding is verification_required or not exact'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_publication_requests_canonical_binding_guard_trigger
BEFORE INSERT OR UPDATE ON asset_publication_requests
FOR EACH ROW EXECUTE FUNCTION enforce_asset_publication_request_canonical_binding();

CREATE TRIGGER asset_publication_requests_mutation_guard_trigger
BEFORE UPDATE OR DELETE ON asset_publication_requests
FOR EACH ROW EXECUTE FUNCTION enforce_asset_publication_request_mutation();

CREATE FUNCTION reject_asset_publication_request_child_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'asset publication request child is immutable'
    USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER asset_publication_request_results_immutable_trigger
BEFORE UPDATE OR DELETE ON asset_publication_request_results
FOR EACH ROW EXECUTE FUNCTION reject_asset_publication_request_child_mutation();
CREATE TRIGGER asset_publication_request_sources_immutable_trigger
BEFORE UPDATE OR DELETE ON asset_publication_request_sources
FOR EACH ROW EXECUTE FUNCTION reject_asset_publication_request_child_mutation();
CREATE TRIGGER asset_publication_request_contexts_immutable_trigger
BEFORE UPDATE OR DELETE ON asset_publication_request_contexts
FOR EACH ROW EXECUTE FUNCTION reject_asset_publication_request_child_mutation();
CREATE TRIGGER asset_publication_request_references_immutable_trigger
BEFORE UPDATE OR DELETE ON asset_publication_request_references
FOR EACH ROW EXECUTE FUNCTION reject_asset_publication_request_child_mutation();
CREATE TRIGGER asset_publication_request_derivatives_immutable_trigger
BEFORE UPDATE OR DELETE ON asset_publication_request_derivatives
FOR EACH ROW EXECUTE FUNCTION reject_asset_publication_request_child_mutation();

CREATE FUNCTION enforce_asset_publication_library_initialization_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'asset publication library initialization is retained authority'
      USING ERRCODE='55000';
  END IF;
  IF ROW(OLD.request_id,OLD.owner_user_id,OLD.canonical_asset_id,OLD.library_snapshot,OLD.created_at)
    IS DISTINCT FROM ROW(NEW.request_id,NEW.owner_user_id,NEW.canonical_asset_id,NEW.library_snapshot,NEW.created_at)
  THEN
    RAISE EXCEPTION 'asset publication library initialization snapshot is immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.state <> 'pending' OR NEW.state <> 'applied' OR NEW.applied_at IS NULL THEN
    RAISE EXCEPTION 'asset publication library initialization may only apply once'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_publication_library_initializations_mutation_guard_trigger
BEFORE UPDATE OR DELETE ON asset_publication_library_initializations
FOR EACH ROW EXECUTE FUNCTION enforce_asset_publication_library_initialization_mutation();

-- Legacy writers remain live until 14e3g.  Their assets insert first creates a
-- legacy 0060 identity, then this replacement trigger immediately publishes a
-- deterministic owner/hash arbitration row.  PostgreSQL's unique index is the
-- arbitration point; no caller retry loop is used to settle same-owner content.
CREATE OR REPLACE FUNCTION create_legacy_asset_publication_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO asset_publication_identities (asset_id, owner_user_id, lifecycle)
  VALUES (NEW.id, NEW.owner_user_id, 'legacy')
  ON CONFLICT (asset_id) DO NOTHING;

  INSERT INTO asset_publication_content_arbitrations (
    owner_user_id,content_hash,canonical_asset_id,verification_state
  ) VALUES (
    NEW.owner_user_id,
    CASE WHEN NEW.content_hash ~ '^[0-9a-f]{64}$' THEN NEW.content_hash
         ELSE encode(sha256(convert_to(
           'legacy-unverified-content:' || NEW.owner_user_id::text || ':' || NEW.id::text,
           'UTF8'
         )), 'hex')
    END,
    NEW.id,
    CASE WHEN NEW.content_hash ~ '^[0-9a-f]{64}$'
                AND NEW.pixel_width IS NOT NULL
                AND NEW.pixel_height IS NOT NULL
                AND NEW.technical_metadata ? 'format'
         THEN 'verified' ELSE 'verification_required' END
  ) ON CONFLICT (owner_user_id, content_hash) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION create_default_asset_library_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  initialization asset_publication_library_initializations%ROWTYPE;
BEGIN
  SELECT * INTO initialization
    FROM asset_publication_library_initializations
   WHERE owner_user_id=NEW.owner_user_id
     AND canonical_asset_id=NEW.id
     AND state='pending'
   FOR UPDATE;

  IF FOUND THEN
    INSERT INTO asset_library_entries (
      asset_id,owner_user_id,created_by_user_id,title,caption,notes,tags,origin,
      reuse_scope,automatic_reuse_enabled,review_status,content_categories,favorite,archived_at
    ) VALUES (
      NEW.id,
      NEW.owner_user_id,
      NEW.owner_user_id,
      COALESCE(initialization.library_snapshot->>'title',''),
      COALESCE(initialization.library_snapshot->>'caption',''),
      COALESCE(initialization.library_snapshot->>'notes',''),
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(initialization.library_snapshot->'tags','[]'::jsonb))),
      COALESCE(initialization.library_snapshot->>'origin','imported'),
      COALESCE(initialization.library_snapshot->>'reuseScope','private'),
      COALESCE((initialization.library_snapshot->>'automaticReuseEnabled')::boolean,false),
      COALESCE(initialization.library_snapshot->>'reviewStatus','unreviewed'),
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(initialization.library_snapshot->'contentCategories','[]'::jsonb))),
      COALESCE((initialization.library_snapshot->>'favorite')::boolean,false),
      NULLIF(initialization.library_snapshot->>'archivedAt','')::timestamptz
    ) ON CONFLICT (asset_id) DO NOTHING;
    UPDATE asset_publication_library_initializations
       SET state='applied', applied_at=clock_timestamp()
     WHERE request_id=initialization.request_id
       AND owner_user_id=initialization.owner_user_id;
    RETURN NEW;
  END IF;

  INSERT INTO asset_library_entries (asset_id, owner_user_id, created_by_user_id, origin, reuse_scope)
  VALUES (NEW.id, NEW.owner_user_id, NEW.owner_user_id, 'imported',
          CASE WHEN NEW.campaign_id IS NULL THEN 'private' ELSE 'campaign' END)
  ON CONFLICT (asset_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Down Migration

-- Any row in these tables is 0064-only authority, including harmless-looking
-- backfills.  Refuse before dropping or reverting guards so rollback cannot
-- erase replay, ownership, metadata, or initialization evidence.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM asset_publication_content_arbitrations)
    OR EXISTS (SELECT 1 FROM asset_publication_requests)
    OR EXISTS (SELECT 1 FROM asset_publication_request_results)
    OR EXISTS (SELECT 1 FROM asset_publication_request_sources)
    OR EXISTS (SELECT 1 FROM asset_publication_request_contexts)
    OR EXISTS (SELECT 1 FROM asset_publication_request_references)
    OR EXISTS (SELECT 1 FROM asset_publication_request_derivatives)
    OR EXISTS (SELECT 1 FROM asset_publication_library_initializations) THEN
    RAISE EXCEPTION 'cannot downgrade normalized asset publication authority while 0064 records exist'
      USING ERRCODE='55006';
  END IF;
END;
$$;

-- Restore the historical default exactly for an empty authority database.
CREATE OR REPLACE FUNCTION create_default_asset_library_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO asset_library_entries (asset_id, owner_user_id, created_by_user_id, origin, reuse_scope)
  VALUES (NEW.id, NEW.owner_user_id, NEW.owner_user_id, 'imported',
          CASE WHEN NEW.campaign_id IS NULL THEN 'private' ELSE 'campaign' END)
  ON CONFLICT (asset_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION create_legacy_asset_publication_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO asset_publication_identities (asset_id, owner_user_id, lifecycle)
  VALUES (NEW.id, NEW.owner_user_id, 'legacy')
  ON CONFLICT (asset_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER asset_publication_library_initializations_mutation_guard_trigger
  ON asset_publication_library_initializations;
DROP FUNCTION enforce_asset_publication_library_initialization_mutation();
DROP TRIGGER asset_publication_request_derivatives_immutable_trigger
  ON asset_publication_request_derivatives;
DROP TRIGGER asset_publication_request_references_immutable_trigger
  ON asset_publication_request_references;
DROP TRIGGER asset_publication_request_contexts_immutable_trigger
  ON asset_publication_request_contexts;
DROP TRIGGER asset_publication_request_sources_immutable_trigger
  ON asset_publication_request_sources;
DROP TRIGGER asset_publication_request_results_immutable_trigger
  ON asset_publication_request_results;
DROP FUNCTION reject_asset_publication_request_child_mutation();
DROP TRIGGER asset_publication_requests_mutation_guard_trigger
  ON asset_publication_requests;
DROP FUNCTION enforce_asset_publication_request_mutation();
DROP TRIGGER asset_publication_requests_canonical_binding_guard_trigger
  ON asset_publication_requests;
DROP FUNCTION enforce_asset_publication_request_canonical_binding();

DROP INDEX portable_import_asset_publications_request_idx;
DROP INDEX portable_import_asset_reservation_intents_request_idx;
ALTER TABLE portable_import_asset_publications
  DROP CONSTRAINT portable_import_asset_publications_import_request_unique,
  DROP CONSTRAINT portable_import_asset_publications_request_fk,
  DROP COLUMN request_id;
ALTER TABLE portable_import_asset_reservation_intents
  DROP CONSTRAINT portable_import_asset_reservation_intents_operation_request_unique,
  DROP CONSTRAINT portable_import_asset_reservation_intents_request_fk,
  DROP COLUMN request_id,
  ADD UNIQUE (owner_user_id, asset_id);

-- Restore the 0063 definitions exactly after removing 0064-only request
-- columns.  An empty downgrade therefore returns the original portable
-- authority rather than leaving a function that references dropped state.
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

DROP TABLE asset_publication_library_initializations;
DROP TABLE asset_publication_request_derivatives;
DROP TABLE asset_publication_request_references;
DROP TABLE asset_publication_request_contexts;
DROP TABLE asset_publication_request_sources;
DROP TABLE asset_publication_request_results;
DROP TABLE asset_publication_requests;
DROP TABLE asset_publication_content_arbitrations;
