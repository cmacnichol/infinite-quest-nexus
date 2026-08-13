-- Up Migration

-- Image/provider retry remains on image_jobs.  This table starts only after
-- the caller transaction attached an exact normalized 0064 request, and keeps
-- the post-commit filesystem finalization state independently recoverable.
CREATE TABLE image_job_asset_publications (
  image_job_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  variant_index integer NOT NULL CHECK (variant_index BETWEEN 0 AND 1),
  finalization_locator text NOT NULL
    CHECK (finalization_locator ~ '^narp1\.[0-9a-f]{64}\.[0-9a-f]{64}$'),
  safe_result jsonb NOT NULL CHECK (jsonb_typeof(safe_result) = 'object'),
  publication_state text NOT NULL DEFAULT 'committed_finalization_pending'
    CHECK (publication_state IN ('committed_finalization_pending', 'published')),
  finalization_attempts integer NOT NULL DEFAULT 0 CHECK (finalization_attempts >= 0),
  last_diagnostic text CHECK (
    last_diagnostic IS NULL OR last_diagnostic = 'asset_publication_finalization_recoverable'
  ),
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  PRIMARY KEY (image_job_id, variant_index),
  UNIQUE (request_id, owner_user_id),
  UNIQUE (image_job_id, owner_user_id, request_id, variant_index),
  FOREIGN KEY (image_job_id, owner_user_id)
    REFERENCES image_jobs(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (request_id, owner_user_id)
    REFERENCES asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT,
  CONSTRAINT image_job_asset_publication_state_check CHECK (
    (publication_state = 'committed_finalization_pending' AND published_at IS NULL)
    OR
    (publication_state = 'published' AND published_at IS NOT NULL AND last_diagnostic IS NULL)
  )
);

CREATE INDEX image_job_asset_publications_pending_idx
  ON image_job_asset_publications(created_at, image_job_id, variant_index)
  WHERE publication_state = 'committed_finalization_pending';

CREATE FUNCTION enforce_image_job_asset_publication_mapping() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request_owner uuid;
  request_lifecycle text;
  request_fingerprint_value text;
  request_idempotency_hash text;
  request_provenance jsonb;
  request_result jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'image-job publication mapping is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      OLD.image_job_id,
      OLD.owner_user_id,
      OLD.request_id,
      OLD.variant_index,
      OLD.finalization_locator,
      OLD.safe_result,
      OLD.created_at
    ) IS DISTINCT FROM ROW(
      NEW.image_job_id,
      NEW.owner_user_id,
      NEW.request_id,
      NEW.variant_index,
      NEW.finalization_locator,
      NEW.safe_result,
      NEW.created_at
    ) THEN
      RAISE EXCEPTION 'image-job publication mapping is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.publication_state = 'published'
      AND ROW(
        OLD.publication_state,
        OLD.finalization_attempts,
        OLD.last_diagnostic,
        OLD.last_attempt_at,
        OLD.published_at
      ) IS DISTINCT FROM ROW(
        NEW.publication_state,
        NEW.finalization_attempts,
        NEW.last_diagnostic,
        NEW.last_attempt_at,
        NEW.published_at
      ) THEN
      RAISE EXCEPTION 'published image-job publication mapping is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.publication_state = 'committed_finalization_pending'
      AND NEW.publication_state NOT IN ('committed_finalization_pending', 'published') THEN
      RAISE EXCEPTION 'image-job publication state transition is invalid'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.finalization_attempts < OLD.finalization_attempts THEN
      RAISE EXCEPTION 'image-job publication attempts cannot decrease'
        USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := clock_timestamp();
  END IF;

  SELECT request.owner_user_id,
         request.lifecycle,
         request.request_fingerprint,
         request.idempotency_key_hash,
         request.provenance_snapshot,
         request.result
    INTO request_owner,
         request_lifecycle,
         request_fingerprint_value,
         request_idempotency_hash,
         request_provenance,
         request_result
    FROM asset_publication_requests request
   WHERE request.id = NEW.request_id
     AND request.owner_user_id = NEW.owner_user_id
   FOR KEY SHARE;

  -- This projection is deliberately a closed safe-result schema.  The 0064
  -- request result is generic JSONB, but a durable image-job mapping must
  -- never become another channel for descriptors, paths, bearers, URLs, or
  -- ownership data.
  IF jsonb_typeof(NEW.safe_result) IS DISTINCT FROM 'object'
    OR NOT (NEW.safe_result ?& ARRAY[
      'assetId', 'mimeType', 'byteLength', 'contentHash', 'pixelWidth', 'pixelHeight', 'derivatives'
    ])
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.safe_result)) <> 7
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(NEW.safe_result) AS key
       WHERE key <> ALL (ARRAY[
         'assetId', 'mimeType', 'byteLength', 'contentHash', 'pixelWidth', 'pixelHeight', 'derivatives'
       ])
    )
    OR jsonb_typeof(NEW.safe_result->'assetId') IS DISTINCT FROM 'string'
    OR NEW.safe_result->>'assetId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(NEW.safe_result->'mimeType') IS DISTINCT FROM 'string'
    OR NEW.safe_result->>'mimeType' NOT IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
    OR jsonb_typeof(NEW.safe_result->'byteLength') IS DISTINCT FROM 'number'
    OR jsonb_typeof(NEW.safe_result->'contentHash') IS DISTINCT FROM 'string'
    OR NEW.safe_result->>'contentHash' !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(NEW.safe_result->'pixelWidth') IS DISTINCT FROM 'number'
    OR jsonb_typeof(NEW.safe_result->'pixelHeight') IS DISTINCT FROM 'number'
    OR jsonb_typeof(NEW.safe_result->'derivatives') IS DISTINCT FROM 'array'
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements(NEW.safe_result->'derivatives') AS derivative(value)
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
    ) THEN
    RAISE EXCEPTION 'image-job publication mapping safe result is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(request_provenance) IS DISTINCT FROM 'object'
    OR jsonb_typeof(request_provenance->'kind') IS DISTINCT FROM 'string'
    OR request_provenance->>'kind' IS DISTINCT FROM 'illustration'
    OR jsonb_typeof(request_provenance->'imageJobId') IS DISTINCT FROM 'string'
    OR request_provenance->>'imageJobId' IS DISTINCT FROM NEW.image_job_id::text
    OR jsonb_typeof(request_provenance->'variantIndex') IS DISTINCT FROM 'number'
    OR request_provenance->>'variantIndex' !~ '^-?[0-9]+$'
    OR (request_provenance->>'variantIndex')::integer IS DISTINCT FROM NEW.variant_index THEN
    RAISE EXCEPTION 'image-job publication mapping provenance is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF request_owner IS NULL
    OR request_lifecycle NOT IN ('attached', 'published')
    OR (NEW.publication_state = 'published' AND request_lifecycle <> 'published')
    OR request_result IS NULL
    OR NEW.finalization_locator <> concat(
      'narp1.', request_fingerprint_value, '.', request_idempotency_hash
    )
    OR NEW.safe_result IS DISTINCT FROM request_result
    OR NOT EXISTS (
      SELECT 1
        FROM image_jobs job
       WHERE job.id = NEW.image_job_id
         AND job.owner_user_id = NEW.owner_user_id
    ) THEN
    RAISE EXCEPTION 'image-job publication mapping does not match attached request authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'image-job publication mapping provenance is invalid'
      USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER enforce_image_job_asset_publication_mapping_trigger
BEFORE INSERT OR UPDATE OR DELETE ON image_job_asset_publications
FOR EACH ROW EXECUTE FUNCTION enforce_image_job_asset_publication_mapping();

COMMENT ON TABLE image_job_asset_publications IS
  'Private immutable image-job/variant to normalized request mapping. Its opaque locator contains no UUID, path, descriptor, bearer, or provider artifact URL.';

-- Down Migration

DROP TRIGGER enforce_image_job_asset_publication_mapping_trigger
  ON image_job_asset_publications;
DROP FUNCTION enforce_image_job_asset_publication_mapping();
DROP TABLE image_job_asset_publications;
