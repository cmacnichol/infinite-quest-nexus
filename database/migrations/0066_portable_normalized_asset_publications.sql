-- Up Migration

-- This row exists before the normalized publisher is allowed to reserve a
-- request or write candidate bytes.  The request UUID is bound afterwards by
-- its immutable owner/fingerprint pair.  A process loss in either interval is
-- therefore recoverable from operation-owned database authority.
CREATE TABLE portable_import_normalized_asset_publications (
  operation_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  asset_ordinal integer NOT NULL CHECK (asset_ordinal >= 0 AND asset_ordinal < 1000),
  import_kind text NOT NULL CHECK (import_kind IN ('campaign_zip', 'legacy_story')),
  authority_fingerprint text NOT NULL CHECK (authority_fingerprint ~ '^[0-9a-f]{64}$'),
  commit_idempotency_key_hash text NOT NULL
    CHECK (commit_idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  request_idempotency_key_hash text NOT NULL
    CHECK (request_idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_id uuid,
  import_id uuid,
  finalization_locator text
    CHECK (
      finalization_locator IS NULL
      OR finalization_locator ~ '^narp1\.[0-9a-f]{64}\.[0-9a-f]{64}$'
    ),
  safe_result jsonb CHECK (safe_result IS NULL OR jsonb_typeof(safe_result) = 'object'),
  publication_state text NOT NULL DEFAULT 'reservation_intent'
    CHECK (publication_state IN (
      'reservation_intent', 'reserved', 'retirement_pending', 'retired',
      'committed_finalization_pending', 'published'
    )),
  retirement_reason text CHECK (
    retirement_reason IS NULL
    OR retirement_reason IN ('duplicate', 'abandoned', 'optional_unavailable')
  ),
  retirement_requested_at timestamptz,
  retired_at timestamptz,
  finalization_attempts integer NOT NULL DEFAULT 0 CHECK (finalization_attempts >= 0),
  last_diagnostic text CHECK (
    last_diagnostic IS NULL OR last_diagnostic = 'asset_publication_finalization_recoverable'
  ),
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  PRIMARY KEY (operation_id, asset_ordinal),
  UNIQUE (operation_id, request_fingerprint, request_idempotency_key_hash),
  UNIQUE (request_id, owner_user_id),
  FOREIGN KEY (operation_id, owner_user_id)
    REFERENCES portable_import_operations(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (request_id, owner_user_id)
    REFERENCES asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (import_id, owner_user_id)
    REFERENCES imports(id, owner_user_id) ON DELETE RESTRICT,
  CONSTRAINT portable_import_normalized_asset_publication_state_check CHECK (
    (publication_state = 'reservation_intent'
      AND request_id IS NULL AND import_id IS NULL
      AND finalization_locator IS NULL AND safe_result IS NULL AND published_at IS NULL
      AND retirement_reason IS NULL AND retirement_requested_at IS NULL AND retired_at IS NULL)
    OR
    (publication_state = 'reserved'
      AND request_id IS NOT NULL AND import_id IS NULL
      AND finalization_locator IS NULL AND safe_result IS NULL AND published_at IS NULL
      AND retirement_reason IS NULL AND retirement_requested_at IS NULL AND retired_at IS NULL)
    OR
    (publication_state = 'retirement_pending'
      AND import_id IS NULL
      AND finalization_locator IS NULL AND safe_result IS NULL
      AND published_at IS NULL AND retirement_reason IS NOT NULL
      AND (retirement_reason <> 'duplicate' OR request_id IS NOT NULL)
      AND retirement_requested_at IS NOT NULL AND retired_at IS NULL)
    OR
    (publication_state = 'retired'
      AND import_id IS NULL
      AND finalization_locator IS NULL AND safe_result IS NULL
      AND published_at IS NULL AND retirement_reason IS NOT NULL
      AND (retirement_reason <> 'duplicate' OR request_id IS NOT NULL)
      AND retirement_requested_at IS NOT NULL AND retired_at IS NOT NULL)
    OR
    (publication_state = 'committed_finalization_pending'
      AND request_id IS NOT NULL AND import_id IS NOT NULL
      AND finalization_locator IS NOT NULL AND safe_result IS NOT NULL AND published_at IS NULL
      AND retirement_reason IS NULL AND retirement_requested_at IS NULL AND retired_at IS NULL)
    OR
    (publication_state = 'published'
      AND request_id IS NOT NULL AND import_id IS NOT NULL
      AND finalization_locator IS NOT NULL AND safe_result IS NOT NULL
      AND published_at IS NOT NULL AND last_diagnostic IS NULL
      AND retirement_reason IS NULL AND retirement_requested_at IS NULL AND retired_at IS NULL)
  )
);

-- One row is retained for every normalized request source.  It mirrors only
-- the safe immutable 0064 source child; archive paths and external URLs never
-- become operation authority.
CREATE TABLE portable_import_normalized_asset_sources (
  operation_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  asset_ordinal integer NOT NULL,
  source_ordinal integer NOT NULL CHECK (source_ordinal >= 0 AND source_ordinal < 1000),
  source_kind text NOT NULL CHECK (source_kind IN ('campaign_zip', 'legacy_story')),
  source_asset_id text NOT NULL CHECK (
    source_asset_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  source_record_id text CHECK (
    source_record_id IS NULL OR source_record_id ~ '^[0-9a-f]{64}$'
  ),
  source_key text CHECK (
    source_key IS NULL
    OR source_key ~ '^source-key-sha256:[0-9a-f]{64}$'
  ),
  requested_library_snapshot jsonb NOT NULL,
  binding_intent_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation_id, asset_ordinal, source_ordinal),
  UNIQUE NULLS NOT DISTINCT (
    operation_id, asset_ordinal, source_kind,
    source_asset_id, source_record_id, source_key
  ),
  FOREIGN KEY (operation_id, asset_ordinal)
    REFERENCES portable_import_normalized_asset_publications(operation_id, asset_ordinal)
    ON DELETE RESTRICT,
  FOREIGN KEY (operation_id, owner_user_id)
    REFERENCES portable_import_operations(id, owner_user_id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(requested_library_snapshot) = 'object'),
  CHECK (jsonb_typeof(binding_intent_keys) = 'array')
);

-- Exact safe child intent is retained before 0064 reservation or filesystem
-- mutation. Request-owned child rows are created only during attachment, so a
-- fingerprint alone is not sufficient crash-recovery authority.
CREATE TABLE portable_import_normalized_asset_contexts (
  operation_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  asset_ordinal integer NOT NULL,
  intent_key text NOT NULL CHECK (length(intent_key) BETWEEN 1 AND 500),
  context_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation_id, asset_ordinal, intent_key),
  FOREIGN KEY (operation_id, asset_ordinal)
    REFERENCES portable_import_normalized_asset_publications(operation_id, asset_ordinal)
    ON DELETE RESTRICT,
  FOREIGN KEY (operation_id, owner_user_id)
    REFERENCES portable_import_operations(id, owner_user_id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(context_snapshot) = 'object')
);

CREATE TABLE portable_import_normalized_asset_references (
  operation_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  asset_ordinal integer NOT NULL,
  intent_key text NOT NULL CHECK (length(intent_key) BETWEEN 1 AND 500),
  reference_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation_id, asset_ordinal, intent_key),
  FOREIGN KEY (operation_id, asset_ordinal)
    REFERENCES portable_import_normalized_asset_publications(operation_id, asset_ordinal)
    ON DELETE RESTRICT,
  FOREIGN KEY (operation_id, owner_user_id)
    REFERENCES portable_import_operations(id, owner_user_id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(reference_snapshot) = 'object')
);

CREATE INDEX portable_import_normalized_asset_publications_pending_idx
  ON portable_import_normalized_asset_publications(
    owner_user_id, publication_state, created_at, operation_id, asset_ordinal
  )
  WHERE publication_state IN (
    'reservation_intent','reserved','retirement_pending','committed_finalization_pending'
  );

CREATE FUNCTION portable_import_normalized_safe_result_valid(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT NOT (
    jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR NOT (value ?& ARRAY[
      'assetId', 'mimeType', 'byteLength', 'contentHash',
      'pixelWidth', 'pixelHeight', 'derivatives'
    ])
    OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 7
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(value) AS key
       WHERE key <> ALL (ARRAY[
         'assetId', 'mimeType', 'byteLength', 'contentHash',
         'pixelWidth', 'pixelHeight', 'derivatives'
       ])
    )
    OR jsonb_typeof(value->'assetId') IS DISTINCT FROM 'string'
    OR value->>'assetId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(value->'mimeType') IS DISTINCT FROM 'string'
    OR value->>'mimeType' NOT IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
    OR jsonb_typeof(value->'byteLength') IS DISTINCT FROM 'number'
    OR jsonb_typeof(value->'contentHash') IS DISTINCT FROM 'string'
    OR value->>'contentHash' !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(value->'pixelWidth') IS DISTINCT FROM 'number'
    OR jsonb_typeof(value->'pixelHeight') IS DISTINCT FROM 'number'
    OR jsonb_typeof(value->'derivatives') IS DISTINCT FROM 'array'
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements(value->'derivatives') AS derivative(value)
       WHERE jsonb_typeof(derivative.value) IS DISTINCT FROM 'object'
          OR NOT (derivative.value ?& ARRAY[
            'derivativeId', 'derivativeKind', 'transformVersion', 'pixelWidth', 'pixelHeight'
          ])
          OR (SELECT count(*) FROM jsonb_object_keys(derivative.value)) <> 5
          OR EXISTS (
            SELECT 1 FROM jsonb_object_keys(derivative.value) AS key
             WHERE key <> ALL (ARRAY[
               'derivativeId', 'derivativeKind', 'transformVersion', 'pixelWidth', 'pixelHeight'
             ])
          )
          OR jsonb_typeof(derivative.value->'derivativeId') IS DISTINCT FROM 'string'
          OR derivative.value->>'derivativeId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR derivative.value->>'derivativeKind' IS DISTINCT FROM 'thumbnail'
          OR jsonb_typeof(derivative.value->'transformVersion') IS DISTINCT FROM 'number'
          OR jsonb_typeof(derivative.value->'pixelWidth') IS DISTINCT FROM 'number'
          OR jsonb_typeof(derivative.value->'pixelHeight') IS DISTINCT FROM 'number'
    )
  );
$$;

CREATE FUNCTION enforce_portable_import_normalized_asset_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'portable normalized import source is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM portable_import_normalized_asset_publications publication
     WHERE publication.operation_id = NEW.operation_id
       AND publication.owner_user_id = NEW.owner_user_id
       AND publication.asset_ordinal = NEW.asset_ordinal
       AND publication.import_kind = NEW.source_kind
       AND publication.publication_state = 'reservation_intent'
  )
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.requested_library_snapshot)) <> 11
    OR NOT (NEW.requested_library_snapshot ?& ARRAY[
      'title', 'caption', 'notes', 'tags', 'origin', 'reviewStatus', 'reuseScope',
      'automaticReuseEnabled', 'contentCategories', 'favorite', 'archivedAt'
    ])
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.binding_intent_keys) value
       WHERE jsonb_typeof(value) <> 'string' OR length(value #>> '{}') NOT BETWEEN 1 AND 500
    ) THEN
    RAISE EXCEPTION 'portable normalized import source authority is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portable_import_normalized_asset_sources_guard_trigger
BEFORE INSERT OR UPDATE OR DELETE ON portable_import_normalized_asset_sources
FOR EACH ROW EXECUTE FUNCTION enforce_portable_import_normalized_asset_source();

CREATE FUNCTION enforce_portable_import_normalized_asset_context() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'portable normalized import context is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM portable_import_normalized_asset_publications publication
     WHERE publication.operation_id = NEW.operation_id
       AND publication.owner_user_id = NEW.owner_user_id
       AND publication.asset_ordinal = NEW.asset_ordinal
       AND publication.publication_state = 'reservation_intent'
  )
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.context_snapshot)) <> 9
    OR NOT (NEW.context_snapshot ?& ARRAY[
      'intentKey','sourceContextId','targetType','variantIndex','worldId',
      'worldVersionId','campaignId','turnId','fictionPromptIdentity'
    ])
    OR NEW.context_snapshot->>'intentKey' IS DISTINCT FROM NEW.intent_key
    OR NEW.context_snapshot->>'targetType' NOT IN (
      'world_cover','turn_illustration','streaming_illustration','other'
    )
    OR jsonb_typeof(NEW.context_snapshot->'variantIndex') IS DISTINCT FROM 'number'
    OR NEW.context_snapshot->>'variantIndex' !~ '^(0|[1-9][0-9]*)$'
    OR length(NEW.context_snapshot->>'variantIndex') > 10
    OR EXISTS (
      SELECT 1
        FROM unnest(ARRAY['sourceContextId','worldId','worldVersionId','campaignId','turnId']) key
       WHERE NEW.context_snapshot->>key IS NOT NULL
         AND NEW.context_snapshot->>key
           !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
    OR (NEW.context_snapshot->>'fictionPromptIdentity' IS NOT NULL
      AND NEW.context_snapshot->>'fictionPromptIdentity' !~ '^[0-9a-f]{64}$')
  THEN
    RAISE EXCEPTION 'portable normalized import context authority is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portable_import_normalized_asset_contexts_guard_trigger
BEFORE INSERT OR UPDATE OR DELETE ON portable_import_normalized_asset_contexts
FOR EACH ROW EXECUTE FUNCTION enforce_portable_import_normalized_asset_context();

CREATE FUNCTION enforce_portable_import_normalized_asset_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'portable normalized import reference is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM portable_import_normalized_asset_publications publication
     WHERE publication.operation_id = NEW.operation_id
       AND publication.owner_user_id = NEW.owner_user_id
       AND publication.asset_ordinal = NEW.asset_ordinal
       AND publication.publication_state = 'reservation_intent'
  )
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.reference_snapshot)) <> 6
    OR NOT (NEW.reference_snapshot ?& ARRAY[
      'intentKey','assetRole','sourceCampaignId','sourceTurnId','campaignId','turnId'
    ])
    OR NEW.reference_snapshot->>'intentKey' IS DISTINCT FROM NEW.intent_key
    OR NEW.reference_snapshot->>'assetRole' NOT IN (
      'turn_illustration','world_asset','import_attachment'
    )
    OR EXISTS (
      SELECT 1
        FROM unnest(ARRAY['sourceCampaignId','sourceTurnId','campaignId','turnId']) key
       WHERE NEW.reference_snapshot->>key IS NOT NULL
         AND NEW.reference_snapshot->>key
           !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
  THEN
    RAISE EXCEPTION 'portable normalized import reference authority is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portable_import_normalized_asset_references_guard_trigger
BEFORE INSERT OR UPDATE OR DELETE ON portable_import_normalized_asset_references
FOR EACH ROW EXECUTE FUNCTION enforce_portable_import_normalized_asset_reference();

-- Terminal retirement may race the short interval between e2 request refresh
-- and its first filesystem journal INSERT. Locking the identity here makes the
-- winner authoritative: prepared/legacy may reserve, cleanup_pending may not.
CREATE FUNCTION enforce_asset_filesystem_identity_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  identity_lifecycle text;
BEGIN
  IF NEW.resource_kind <> 'asset'
    OR NEW.purpose NOT IN ('asset_original','asset_derivative') THEN
    RETURN NEW;
  END IF;
  SELECT lifecycle INTO identity_lifecycle
    FROM asset_publication_identities identity
   WHERE identity.asset_id = NEW.asset_id
     AND identity.owner_user_id = NEW.owner_user_id
   FOR UPDATE;
  IF identity_lifecycle NOT IN ('legacy','prepared') THEN
    RAISE EXCEPTION 'asset filesystem operation requires live publication identity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_filesystem_identity_lifecycle_trigger
BEFORE INSERT ON durable_filesystem_operations
FOR EACH ROW EXECUTE FUNCTION enforce_asset_filesystem_identity_lifecycle();

CREATE FUNCTION enforce_portable_import_normalized_asset_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request_row asset_publication_requests%ROWTYPE;
  operation_row portable_import_operations%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portable normalized import publication is retained authority'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO operation_row
    FROM portable_import_operations operation
   WHERE operation.id = NEW.operation_id
     AND operation.owner_user_id = NEW.owner_user_id
   FOR KEY SHARE;
  IF NOT FOUND
    OR operation_row.import_kind <> NEW.import_kind
    OR operation_row.authority_fingerprint IS DISTINCT FROM NEW.authority_fingerprint THEN
    RAISE EXCEPTION 'portable normalized import operation authority is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.publication_state IN ('retirement_pending','retired') THEN
    IF NEW.retirement_reason = 'duplicate' THEN
      IF operation_row.status <> 'committed'
        OR operation_row.result_projection->>'duplicate' IS DISTINCT FROM 'true'
        OR NOT EXISTS (
          SELECT 1 FROM portable_import_work work
           WHERE work.operation_id = NEW.operation_id
             AND work.owner_user_id = NEW.owner_user_id
             AND work.status IN ('running','recoverable','completed')
        )
        OR NOT EXISTS (
          SELECT 1 FROM imports imported
           WHERE imported.id = operation_row.import_id
             AND imported.owner_user_id = NEW.owner_user_id
             AND imported.source_hash = NEW.authority_fingerprint
             AND imported.status = 'completed'
        ) THEN
        RAISE EXCEPTION 'portable normalized import retirement authority is invalid'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.retirement_reason = 'abandoned' THEN
      IF NOT (
        (operation_row.status = 'failed' AND EXISTS (
          SELECT 1 FROM portable_import_work work
           WHERE work.operation_id = NEW.operation_id
             AND work.owner_user_id = NEW.owner_user_id
             AND work.status = 'aborted'
        ))
        OR
        (operation_row.status = 'expired' AND EXISTS (
          SELECT 1 FROM portable_import_work work
           WHERE work.operation_id = NEW.operation_id
             AND work.owner_user_id = NEW.owner_user_id
             AND work.status = 'expired'
        ))
      ) THEN
        RAISE EXCEPTION 'portable normalized import retirement authority is invalid'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.retirement_reason = 'optional_unavailable' THEN
      IF NEW.import_kind <> 'legacy_story'
        OR NOT (
          (operation_row.status IN ('previewed','consuming') AND EXISTS (
            SELECT 1 FROM portable_import_work work
             WHERE work.operation_id = NEW.operation_id
               AND work.owner_user_id = NEW.owner_user_id
               AND work.status IN ('running','recoverable')
          ))
          OR
          (operation_row.status = 'committed'
            AND EXISTS (
              SELECT 1 FROM portable_import_work work
               WHERE work.operation_id = NEW.operation_id
                 AND work.owner_user_id = NEW.owner_user_id
                 AND work.status IN ('running','recoverable','completed')
            )
            AND EXISTS (
              SELECT 1 FROM imports imported
               WHERE imported.id = operation_row.import_id
                 AND imported.owner_user_id = NEW.owner_user_id
                 AND imported.source_hash = NEW.authority_fingerprint
                 AND imported.status = 'completed'
            ))
        ) THEN
        RAISE EXCEPTION 'portable normalized import retirement authority is invalid'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'portable normalized import retirement authority is invalid'
        USING ERRCODE = '23514';
    END IF;
  ELSIF operation_row.status NOT IN ('previewed','consuming','committed')
    OR NOT EXISTS (
      SELECT 1 FROM portable_import_work work
       WHERE work.operation_id = NEW.operation_id
         AND work.owner_user_id = NEW.owner_user_id
         AND work.status IN ('running','recoverable','completed')
    ) THEN
    RAISE EXCEPTION 'portable normalized import operation authority is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.publication_state <> 'reservation_intent'
      OR operation_row.status <> 'previewed'
      OR operation_row.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'portable normalized import reservation intent is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    OLD.operation_id, OLD.owner_user_id, OLD.asset_ordinal, OLD.import_kind,
    OLD.authority_fingerprint, OLD.commit_idempotency_key_hash,
    OLD.request_fingerprint, OLD.request_idempotency_key_hash, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.operation_id, NEW.owner_user_id, NEW.asset_ordinal, NEW.import_kind,
    NEW.authority_fingerprint, NEW.commit_idempotency_key_hash,
    NEW.request_fingerprint, NEW.request_idempotency_key_hash, NEW.created_at
  ) OR NEW.finalization_attempts < OLD.finalization_attempts THEN
    RAISE EXCEPTION 'portable normalized import publication authority is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.publication_state = 'reservation_intent'
    AND NEW.publication_state IN ('reserved','retirement_pending') THEN
    NULL;
  ELSIF OLD.publication_state = 'reserved'
    AND NEW.publication_state = 'retirement_pending' THEN
    NULL;
  ELSIF OLD.publication_state = 'retirement_pending'
    AND NEW.publication_state IN ('retirement_pending','retired') THEN
    NULL;
  ELSIF OLD.publication_state = 'retired' AND NEW.publication_state = 'retired' THEN
    NULL;
  ELSIF OLD.publication_state = 'reserved'
    AND NEW.publication_state = 'committed_finalization_pending' THEN
    NULL;
  ELSIF OLD.publication_state = 'committed_finalization_pending'
    AND NEW.publication_state IN ('committed_finalization_pending', 'published') THEN
    NULL;
  ELSIF OLD.publication_state = 'published'
    AND NEW.publication_state = 'published' THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'portable normalized import publication transition is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.request_id IS NOT NULL AND NEW.request_id IS DISTINCT FROM OLD.request_id
    OR OLD.import_id IS NOT NULL AND NEW.import_id IS DISTINCT FROM OLD.import_id
    OR OLD.finalization_locator IS NOT NULL
      AND NEW.finalization_locator IS DISTINCT FROM OLD.finalization_locator
    OR OLD.safe_result IS NOT NULL AND NEW.safe_result IS DISTINCT FROM OLD.safe_result
    OR OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'portable normalized import attachment is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.publication_state = 'retired'
    AND ROW(
      OLD.request_id, OLD.import_id, OLD.finalization_locator,
      OLD.safe_result, OLD.published_at
    ) IS DISTINCT FROM ROW(
      NEW.request_id, NEW.import_id, NEW.finalization_locator,
      NEW.safe_result, NEW.published_at
    ) THEN
    RAISE EXCEPTION 'portable normalized import terminal authority is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.retirement_reason IS NOT NULL
      AND NEW.retirement_reason IS DISTINCT FROM OLD.retirement_reason)
    OR (OLD.retirement_requested_at IS NOT NULL
      AND NEW.retirement_requested_at IS DISTINCT FROM OLD.retirement_requested_at)
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    RAISE EXCEPTION 'portable normalized import retirement is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.request_id IS NOT NULL THEN
    SELECT * INTO request_row
      FROM asset_publication_requests request
     WHERE request.id = NEW.request_id
       AND request.owner_user_id = NEW.owner_user_id
     FOR KEY SHARE;
    IF NOT FOUND
      OR request_row.request_fingerprint <> NEW.request_fingerprint
      OR request_row.idempotency_key_hash <> NEW.request_idempotency_key_hash
      OR jsonb_typeof(request_row.provenance_snapshot) <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(request_row.provenance_snapshot)) <> 5
      OR NOT (request_row.provenance_snapshot ?& ARRAY[
        'kind','importKind','importOperationId','importId','sourceInstallationId'
      ])
      OR request_row.provenance_snapshot->>'kind' <> 'import'
      OR request_row.provenance_snapshot->>'importKind' <> NEW.import_kind
      OR request_row.provenance_snapshot->>'importOperationId' <> NEW.operation_id::text
      OR request_row.provenance_snapshot->>'importId' IS NOT NULL
      OR (request_row.provenance_snapshot->>'sourceInstallationId' IS NOT NULL
        AND request_row.provenance_snapshot->>'sourceInstallationId'
          !~ '^source-installation-sha256:[0-9a-f]{64}$')
    THEN
      RAISE EXCEPTION 'portable normalized import request mapping is invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.publication_state IN ('committed_finalization_pending', 'published') THEN
    IF operation_row.idempotency_key_hash IS DISTINCT FROM NEW.commit_idempotency_key_hash
      OR request_row.lifecycle NOT IN ('attached', 'published')
      OR NEW.finalization_locator <> concat(
        'narp1.', NEW.request_fingerprint, '.', NEW.request_idempotency_key_hash
      )
      OR NOT portable_import_normalized_safe_result_valid(NEW.safe_result)
      OR NEW.safe_result IS DISTINCT FROM request_row.result
      OR (
        SELECT COALESCE(jsonb_agg(jsonb_build_array(
                 source_ordinal, source_kind, source_asset_id, source_record_id,
                 source_key, requested_library_snapshot, binding_intent_keys
               ) ORDER BY source_ordinal), '[]'::jsonb)
          FROM portable_import_normalized_asset_sources source
         WHERE source.operation_id = NEW.operation_id
           AND source.owner_user_id = NEW.owner_user_id
           AND source.asset_ordinal = NEW.asset_ordinal
      ) IS DISTINCT FROM (
        SELECT COALESCE(jsonb_agg(jsonb_build_array(
                 ordinal, source_kind, source_asset_id, source_record_id,
                 source_key, requested_library_snapshot, binding_intent_keys
               ) ORDER BY ordinal), '[]'::jsonb)
          FROM asset_publication_request_sources request_source
         WHERE request_source.request_id = NEW.request_id
           AND request_source.owner_user_id = NEW.owner_user_id
      )
      OR (
        SELECT COALESCE(jsonb_agg(jsonb_build_array(
                 intent_key, context_snapshot
               ) ORDER BY intent_key), '[]'::jsonb)
          FROM portable_import_normalized_asset_contexts context_intent
         WHERE context_intent.operation_id = NEW.operation_id
           AND context_intent.owner_user_id = NEW.owner_user_id
           AND context_intent.asset_ordinal = NEW.asset_ordinal
      ) IS DISTINCT FROM (
        SELECT COALESCE(jsonb_agg(jsonb_build_array(
                 intent_key, context_snapshot
               ) ORDER BY intent_key), '[]'::jsonb)
          FROM asset_publication_request_contexts request_context
         WHERE request_context.request_id = NEW.request_id
           AND request_context.owner_user_id = NEW.owner_user_id
      )
      OR (
        SELECT COALESCE(jsonb_agg(jsonb_build_array(
                 intent_key, reference_snapshot
               ) ORDER BY intent_key), '[]'::jsonb)
          FROM portable_import_normalized_asset_references reference_intent
         WHERE reference_intent.operation_id = NEW.operation_id
           AND reference_intent.owner_user_id = NEW.owner_user_id
           AND reference_intent.asset_ordinal = NEW.asset_ordinal
      ) IS DISTINCT FROM (
        SELECT COALESCE(jsonb_agg(jsonb_build_array(
                 intent_key, reference_snapshot
               ) ORDER BY intent_key), '[]'::jsonb)
          FROM asset_publication_request_references request_reference
         WHERE request_reference.request_id = NEW.request_id
           AND request_reference.owner_user_id = NEW.owner_user_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM imports imported
         WHERE imported.id = NEW.import_id
           AND imported.owner_user_id = NEW.owner_user_id
           AND imported.source_hash = NEW.authority_fingerprint
           AND imported.status = 'completed'
           AND imported.source_type = CASE NEW.import_kind
             WHEN 'campaign_zip' THEN 'portable_campaign_zip'
             ELSE 'portable_legacy_story'
           END
      )
      OR (NEW.publication_state = 'published' AND request_row.lifecycle <> 'published') THEN
      RAISE EXCEPTION 'portable normalized import attachment mapping is invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER portable_import_normalized_asset_publications_guard_trigger
BEFORE INSERT OR UPDATE OR DELETE ON portable_import_normalized_asset_publications
FOR EACH ROW EXECUTE FUNCTION enforce_portable_import_normalized_asset_publication();

COMMENT ON TABLE portable_import_normalized_asset_publications IS
  'Private operation-owned prewrite intent and immutable portable import to normalized 0064 request/result mapping. Contains no path, descriptor, bearer, external URL, or caller ownership input.';

-- Down Migration

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM portable_import_normalized_asset_publications) THEN
    RAISE EXCEPTION 'cannot downgrade retained portable normalized publication authority'
      USING ERRCODE = '55006';
  END IF;
END;
$$;

DROP TRIGGER portable_import_normalized_asset_publications_guard_trigger
  ON portable_import_normalized_asset_publications;
DROP FUNCTION enforce_portable_import_normalized_asset_publication();
DROP TRIGGER asset_filesystem_identity_lifecycle_trigger
  ON durable_filesystem_operations;
DROP FUNCTION enforce_asset_filesystem_identity_lifecycle();
DROP TRIGGER portable_import_normalized_asset_references_guard_trigger
  ON portable_import_normalized_asset_references;
DROP FUNCTION enforce_portable_import_normalized_asset_reference();
DROP TRIGGER portable_import_normalized_asset_contexts_guard_trigger
  ON portable_import_normalized_asset_contexts;
DROP FUNCTION enforce_portable_import_normalized_asset_context();
DROP TRIGGER portable_import_normalized_asset_sources_guard_trigger
  ON portable_import_normalized_asset_sources;
DROP FUNCTION enforce_portable_import_normalized_asset_source();
DROP FUNCTION portable_import_normalized_safe_result_valid(jsonb);
DROP INDEX portable_import_normalized_asset_publications_pending_idx;
DROP TABLE portable_import_normalized_asset_references;
DROP TABLE portable_import_normalized_asset_contexts;
DROP TABLE portable_import_normalized_asset_sources;
DROP TABLE portable_import_normalized_asset_publications;
