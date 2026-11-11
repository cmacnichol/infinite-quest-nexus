-- Up Migration
-- Fresh PostgreSQL schema after migration 0133. Functions may reference tables defined later.
SET LOCAL check_function_bodies = false;

-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

--
-- Name: private_finalized_asset_delivery_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.private_finalized_asset_delivery_grants (
    grant_token_hash text CONSTRAINT private_finalized_asset_delivery_gran_grant_token_hash_not_null NOT NULL,
    owner_user_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    delivery_intent text CONSTRAINT private_finalized_asset_delivery_grant_delivery_intent_not_null NOT NULL,
    selected_row_kind text CONSTRAINT private_finalized_asset_delivery_gra_selected_row_kind_not_null NOT NULL,
    selected_row_id uuid CONSTRAINT private_finalized_asset_delivery_grant_selected_row_id_not_null NOT NULL,
    operation_id uuid NOT NULL,
    operation_purpose text CONSTRAINT private_finalized_asset_delivery_gra_operation_purpose_not_null NOT NULL,
    candidate_token_hash text CONSTRAINT private_finalized_asset_delivery__candidate_token_hash_not_null NOT NULL,
    descriptor_role text GENERATED ALWAYS AS ('delivery'::text) STORED,
    descriptor_ordinal integer GENERATED ALWAYS AS (0) STORED,
    relative_path text NOT NULL,
    device_id text NOT NULL,
    file_id text NOT NULL,
    change_token text NOT NULL,
    content_hash text NOT NULL,
    byte_length bigint NOT NULL,
    mime_type text NOT NULL,
    lifecycle text DEFAULT 'issued'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    redeemed_at timestamp with time zone,
    expired_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT private_finalized_asset_delivery_gra_candidate_token_hash_check CHECK ((candidate_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT private_finalized_asset_delivery_grants_byte_length_check CHECK ((byte_length >= 0)),
    CONSTRAINT private_finalized_asset_delivery_grants_change_token_check CHECK ((btrim(change_token) <> ''::text)),
    CONSTRAINT private_finalized_asset_delivery_grants_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT private_finalized_asset_delivery_grants_delivery_intent_check CHECK ((delivery_intent = ANY (ARRAY['original'::text, 'thumbnail'::text]))),
    CONSTRAINT private_finalized_asset_delivery_grants_device_id_check CHECK ((btrim(device_id) <> ''::text)),
    CONSTRAINT private_finalized_asset_delivery_grants_file_id_check CHECK ((btrim(file_id) <> ''::text)),
    CONSTRAINT private_finalized_asset_delivery_grants_grant_token_hash_check CHECK ((grant_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT private_finalized_asset_delivery_grants_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['issued'::text, 'redeemed'::text, 'expired'::text, 'revoked'::text]))),
    CONSTRAINT private_finalized_asset_delivery_grants_mime_type_check CHECK ((btrim(mime_type) <> ''::text)),
    CONSTRAINT private_finalized_asset_delivery_grants_operation_purpose_check CHECK ((operation_purpose = ANY (ARRAY['asset_original'::text, 'asset_derivative'::text]))),
    CONSTRAINT private_finalized_asset_delivery_grants_relative_path_check CHECK (((relative_path <> ''::text) AND (relative_path !~ '(^/|^[A-Za-z]:|^\\\\|\\\\|(^|/)\.\.?(/|$))'::text))),
    CONSTRAINT private_finalized_asset_delivery_grants_selected_row_kind_check CHECK ((selected_row_kind = ANY (ARRAY['asset'::text, 'asset_derivative'::text]))),
    CONSTRAINT private_finalized_delivery_completion_check CHECK ((((lifecycle = 'issued'::text) AND (redeemed_at IS NULL) AND (expired_at IS NULL) AND (revoked_at IS NULL)) OR ((lifecycle = 'redeemed'::text) AND (redeemed_at IS NOT NULL) AND (expired_at IS NULL) AND (revoked_at IS NULL)) OR ((lifecycle = 'expired'::text) AND (redeemed_at IS NULL) AND (expired_at IS NOT NULL) AND (revoked_at IS NULL)) OR ((lifecycle = 'revoked'::text) AND (redeemed_at IS NULL) AND (expired_at IS NULL) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT private_finalized_delivery_selection_check CHECK ((((selected_row_kind = 'asset'::text) AND (operation_purpose = 'asset_original'::text)) OR ((selected_row_kind = 'asset_derivative'::text) AND (delivery_intent = 'thumbnail'::text) AND (operation_purpose = 'asset_derivative'::text))))
);

--
-- Name: assert_private_finalized_asset_delivery_binding(public.private_finalized_asset_delivery_grants); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_private_finalized_asset_delivery_binding(grant_row public.private_finalized_asset_delivery_grants) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  operation durable_filesystem_operations%ROWTYPE;
  descriptor durable_filesystem_descriptors%ROWTYPE;
  selected_operation_id uuid;
  selected_relative_path text;
  selected_content_hash text;
  selected_byte_length bigint;
  selected_mime_type text;
BEGIN
  SELECT * INTO operation
    FROM durable_filesystem_operations
   WHERE id = grant_row.operation_id;
  SELECT * INTO descriptor
    FROM durable_filesystem_descriptors
   WHERE operation_id = grant_row.operation_id
     AND owner_user_id = grant_row.owner_user_id
     AND descriptor_role = 'delivery'
     AND ordinal = 0;

  IF grant_row.selected_row_kind = 'asset' THEN
    SELECT filesystem_operation_id, storage_path, content_hash, byte_length, mime_type
      INTO selected_operation_id, selected_relative_path, selected_content_hash,
           selected_byte_length, selected_mime_type
      FROM assets
     WHERE id = grant_row.selected_row_id
       AND id = grant_row.asset_id
       AND owner_user_id = grant_row.owner_user_id;
  ELSE
    SELECT filesystem_operation_id, storage_path, content_hash, byte_length, mime_type
      INTO selected_operation_id, selected_relative_path, selected_content_hash,
           selected_byte_length, selected_mime_type
      FROM asset_derivatives
     WHERE id = grant_row.selected_row_id
       AND source_asset_id = grant_row.asset_id
       AND owner_user_id = grant_row.owner_user_id
       AND derivative_kind = 'thumbnail';
  END IF;

  IF operation.id IS NULL
    OR operation.lifecycle <> 'finalized'
    OR operation.resource_kind <> 'asset'
    OR operation.owner_user_id IS DISTINCT FROM grant_row.owner_user_id
    OR operation.asset_id IS DISTINCT FROM grant_row.asset_id
    OR operation.purpose IS DISTINCT FROM grant_row.operation_purpose
    OR operation.candidate_token_hash IS DISTINCT FROM grant_row.candidate_token_hash
    OR selected_operation_id IS DISTINCT FROM grant_row.operation_id
    OR selected_relative_path IS DISTINCT FROM grant_row.relative_path
    OR selected_content_hash IS DISTINCT FROM grant_row.content_hash
    OR selected_byte_length IS DISTINCT FROM grant_row.byte_length
    OR selected_mime_type IS DISTINCT FROM grant_row.mime_type
    OR descriptor.operation_id IS NULL
    OR descriptor.relative_path IS DISTINCT FROM grant_row.relative_path
    OR descriptor.device_id IS DISTINCT FROM grant_row.device_id
    OR descriptor.file_id IS DISTINCT FROM grant_row.file_id
    OR descriptor.change_token IS DISTINCT FROM grant_row.change_token
    OR descriptor.content_hash IS DISTINCT FROM grant_row.content_hash
    OR descriptor.byte_length IS DISTINCT FROM grant_row.byte_length
  THEN
    RAISE EXCEPTION 'finalized asset delivery binding is invalid'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

--
-- Name: private_legacy_asset_read_capabilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.private_legacy_asset_read_capabilities (
    capability_token_hash text CONSTRAINT private_legacy_asset_read_capabi_capability_token_hash_not_null NOT NULL,
    owner_user_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    delivery_intent text NOT NULL,
    selected_row_kind text CONSTRAINT private_legacy_asset_read_capabiliti_selected_row_kind_not_null NOT NULL,
    selected_row_id uuid NOT NULL,
    relative_path text NOT NULL,
    content_hash text NOT NULL,
    byte_length bigint NOT NULL,
    mime_type text NOT NULL,
    lifecycle text DEFAULT 'issued'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    redeemed_at timestamp with time zone,
    expired_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT private_legacy_asset_read_capabilit_capability_token_hash_check CHECK ((capability_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT private_legacy_asset_read_capabilities_byte_length_check CHECK ((byte_length >= 0)),
    CONSTRAINT private_legacy_asset_read_capabilities_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT private_legacy_asset_read_capabilities_delivery_intent_check CHECK ((delivery_intent = ANY (ARRAY['original'::text, 'thumbnail'::text]))),
    CONSTRAINT private_legacy_asset_read_capabilities_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['issued'::text, 'redeemed'::text, 'expired'::text, 'revoked'::text]))),
    CONSTRAINT private_legacy_asset_read_capabilities_mime_type_check CHECK ((btrim(mime_type) <> ''::text)),
    CONSTRAINT private_legacy_asset_read_capabilities_relative_path_check CHECK (((relative_path <> ''::text) AND (relative_path !~ '(^/|^[A-Za-z]:|^\\\\|\\\\|(^|/)\.\.?(/|$))'::text))),
    CONSTRAINT private_legacy_asset_read_capabilities_selected_row_kind_check CHECK ((selected_row_kind = ANY (ARRAY['asset'::text, 'asset_derivative'::text]))),
    CONSTRAINT private_legacy_read_completion_check CHECK ((((lifecycle = 'issued'::text) AND (redeemed_at IS NULL) AND (expired_at IS NULL) AND (revoked_at IS NULL)) OR ((lifecycle = 'redeemed'::text) AND (redeemed_at IS NOT NULL) AND (expired_at IS NULL) AND (revoked_at IS NULL)) OR ((lifecycle = 'expired'::text) AND (redeemed_at IS NULL) AND (expired_at IS NOT NULL) AND (revoked_at IS NULL)) OR ((lifecycle = 'revoked'::text) AND (redeemed_at IS NULL) AND (expired_at IS NULL) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT private_legacy_read_selection_check CHECK (((selected_row_kind = 'asset'::text) OR ((selected_row_kind = 'asset_derivative'::text) AND (delivery_intent = 'thumbnail'::text))))
);

--
-- Name: assert_private_legacy_asset_read_binding(public.private_legacy_asset_read_capabilities); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_private_legacy_asset_read_binding(capability_row public.private_legacy_asset_read_capabilities) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  selected_operation_id uuid;
  selected_relative_path text;
  selected_content_hash text;
  selected_byte_length bigint;
  selected_mime_type text;
BEGIN
  IF capability_row.selected_row_kind = 'asset' THEN
    SELECT filesystem_operation_id, storage_path, content_hash, byte_length, mime_type
      INTO selected_operation_id, selected_relative_path, selected_content_hash,
           selected_byte_length, selected_mime_type
      FROM assets
     WHERE id = capability_row.selected_row_id
       AND id = capability_row.asset_id
       AND owner_user_id = capability_row.owner_user_id;
  ELSE
    SELECT filesystem_operation_id, storage_path, content_hash, byte_length, mime_type
      INTO selected_operation_id, selected_relative_path, selected_content_hash,
           selected_byte_length, selected_mime_type
      FROM asset_derivatives
     WHERE id = capability_row.selected_row_id
       AND source_asset_id = capability_row.asset_id
       AND owner_user_id = capability_row.owner_user_id
       AND derivative_kind = 'thumbnail';
  END IF;

  IF selected_relative_path IS NULL
    OR selected_operation_id IS NOT NULL
    OR selected_relative_path IS DISTINCT FROM capability_row.relative_path
    OR selected_content_hash IS DISTINCT FROM capability_row.content_hash
    OR selected_byte_length IS DISTINCT FROM capability_row.byte_length
    OR selected_mime_type IS DISTINCT FROM capability_row.mime_type
  THEN
    RAISE EXCEPTION 'legacy asset read binding is invalid'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

--
-- Name: authoring_snapshot_requires_text_plan_protocol(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authoring_snapshot_requires_text_plan_protocol(snapshot jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT snapshot IS NOT NULL AND NOT COALESCE(valid_historical_authoring_snapshot(snapshot),false)
$$;

--
-- Name: bump_cast_workspace_revision_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_cast_workspace_revision_row() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE campaign_cast_state SET workspace_revision=workspace_revision+1
    WHERE campaign_id=NEW.campaign_id AND owner_user_id=NEW.owner_user_id;
  RETURN NULL;
END;
$$;

--
-- Name: bump_cast_workspace_revision_statement(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_cast_workspace_revision_statement() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE campaign_cast_state s SET workspace_revision=s.workspace_revision+1
    FROM (SELECT DISTINCT campaign_id,owner_user_id FROM changed_rows) c
    WHERE s.campaign_id=c.campaign_id AND s.owner_user_id=c.owner_user_id;
  RETURN NULL;
END;
$$;

--
-- Name: canonical_jsonb_sha256(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.canonical_jsonb_sha256(value jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT encode(digest(convert_to(canonical_jsonb_text(value),'UTF8'),'sha256'),'hex')
$$;

--
-- Name: canonical_jsonb_text(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.canonical_jsonb_text(value jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE kind text;
BEGIN
  IF value IS NULL THEN RETURN NULL; END IF;
  kind := jsonb_typeof(value);
  IF kind='object' THEN
    RETURN '{' || COALESCE((
      SELECT string_agg(to_json(entry.key)::text || ':' || canonical_jsonb_text(entry.value), ',' ORDER BY javascript_utf16_sort_key(entry.key) COLLATE "C")
        FROM jsonb_each(value) entry
    ), '') || '}';
  END IF;
  IF kind='array' THEN
    RETURN '[' || COALESCE((
      SELECT string_agg(canonical_jsonb_text(item.value), ',' ORDER BY item.ordinality)
        FROM jsonb_array_elements(value) WITH ORDINALITY item(value, ordinality)
    ), '') || ']';
  END IF;
  IF kind='string' THEN RETURN to_json(value #>> '{}')::text; END IF;
  IF kind='null' THEN RETURN 'null'; END IF;
  IF kind='number' THEN RETURN javascript_json_number_text(value); END IF;
  RETURN value #>> '{}';
END;
$$;

--
-- Name: clear_deleted_campaign_asset_provenance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.clear_deleted_campaign_asset_provenance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE assets
     SET campaign_id = NULL, turn_id = NULL
   WHERE owner_user_id = OLD.owner_user_id AND campaign_id = OLD.id;
  RETURN OLD;
END;
$$;

--
-- Name: create_default_asset_library_entry(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_default_asset_library_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: create_legacy_asset_publication_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_legacy_asset_publication_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
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
$_$;

--
-- Name: durable_filesystem_expected_prewrite_path(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.durable_filesystem_expected_prewrite_path(operation_id uuid, operation_purpose text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  SELECT CASE operation_purpose
    WHEN 'portable_staging' THEN 'staging/' || operation_id::text || '.pending'
    WHEN 'portable_export' THEN 'exports/' || operation_id::text || '.pending'
    WHEN 'asset_original' THEN 'assets/' || operation_id::text || '.pending'
    WHEN 'asset_derivative' THEN 'assets/' || operation_id::text || '.pending'
    ELSE NULL
  END
$$;

--
-- Name: enforce_asset_filesystem_binding_immutability(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_asset_filesystem_binding_immutability() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: enforce_asset_filesystem_identity_lifecycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_asset_filesystem_identity_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
  IF identity_lifecycle IS NULL
    OR (
      identity_lifecycle NOT IN ('legacy','prepared')
      AND NOT (
        identity_lifecycle = 'published'
        AND NEW.purpose = 'asset_derivative'
      )
    ) THEN
    RAISE EXCEPTION 'asset filesystem operation requires live publication identity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: enforce_asset_publication_library_initialization_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_asset_publication_library_initialization_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: enforce_asset_publication_request_canonical_binding(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_asset_publication_request_canonical_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: enforce_asset_publication_request_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_asset_publication_request_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: enforce_durable_asset_operation_retention(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_durable_asset_operation_retention() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: enforce_durable_filesystem_candidate_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_durable_filesystem_candidate_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: enforce_durable_filesystem_operation_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_durable_filesystem_operation_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle <> 'reserved'
      OR NEW.candidate_token_hash IS NOT NULL
      OR NEW.locator_token_hash IS NOT NULL
      OR NEW.attached_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'durable filesystem operations must be reserved before attachment'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.lifecycle <> 'cleaned'
      OR OLD.candidate_token_hash IS NOT NULL
      OR OLD.locator_token_hash IS NOT NULL
      OR OLD.attached_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'nonterminal or identity-bearing durable filesystem operations cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.operation_token_hash IS DISTINCT FROM NEW.operation_token_hash
    OR OLD.purpose IS DISTINCT FROM NEW.purpose
    OR OLD.resource_kind IS DISTINCT FROM NEW.resource_kind
    OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
    OR OLD.operation_scope_hash IS DISTINCT FROM NEW.operation_scope_hash
    OR (OLD.candidate_token_hash IS NOT NULL
      AND OLD.candidate_token_hash IS DISTINCT FROM NEW.candidate_token_hash)
    OR (OLD.locator_token_hash IS NOT NULL
      AND OLD.locator_token_hash IS DISTINCT FROM NEW.locator_token_hash)
    OR (OLD.attached_at IS NOT NULL
      AND OLD.attached_at IS DISTINCT FROM NEW.attached_at)
  THEN
    RAISE EXCEPTION 'durable filesystem operation authority is write-once'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.lifecycle IS DISTINCT FROM NEW.lifecycle
    AND NOT (
      (OLD.lifecycle = 'reserved' AND NEW.lifecycle IN ('attached', 'cleanup_pending'))
      OR (OLD.lifecycle = 'attached' AND NEW.lifecycle IN ('finalized', 'cleanup_pending'))
      OR (OLD.lifecycle = 'finalized' AND NEW.lifecycle = 'cleanup_pending')
      OR (OLD.lifecycle = 'cleanup_pending' AND NEW.lifecycle = 'cleaned')
    )
  THEN
    RAISE EXCEPTION 'durable filesystem operation lifecycle transition is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF (
    (OLD.candidate_token_hash IS NULL AND NEW.candidate_token_hash IS NOT NULL)
    OR (OLD.locator_token_hash IS NULL AND NEW.locator_token_hash IS NOT NULL)
    OR (OLD.attached_at IS NULL AND NEW.attached_at IS NOT NULL)
  )
    AND NOT (
      OLD.lifecycle = 'reserved'
      AND NEW.lifecycle = 'attached'
      AND OLD.candidate_token_hash IS NULL
      AND OLD.locator_token_hash IS NULL
      AND OLD.attached_at IS NULL
      AND NEW.candidate_token_hash IS NOT NULL
      AND NEW.locator_token_hash IS NOT NULL
      AND NEW.attached_at IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'filesystem capabilities may only be minted while attaching a reservation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: enforce_durable_filesystem_prewrite_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_durable_filesystem_prewrite_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  operation_lifecycle text;
  operation_expiry timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'durable filesystem prewrite authority is immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT lifecycle, expires_at
    INTO operation_lifecycle, operation_expiry
    FROM durable_filesystem_operations
   WHERE id = NEW.operation_id
     AND owner_user_id = NEW.owner_user_id
     AND purpose = NEW.purpose
   FOR UPDATE;

  IF TG_OP = 'INSERT' THEN
    IF NEW.authority_state <> 'target_only'
      OR NEW.device_id IS NOT NULL OR NEW.file_id IS NOT NULL
      OR operation_lifecycle IS NULL
      OR operation_lifecycle <> 'reserved'
      OR operation_expiry <= clock_timestamp()
    THEN
      RAISE EXCEPTION 'prewrite target requires a live reserved filesystem operation'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.relative_path IS DISTINCT FROM OLD.relative_path
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.target_recorded_at IS DISTINCT FROM OLD.target_recorded_at
  THEN
    RAISE EXCEPTION 'durable filesystem prewrite target is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.authority_state = 'target_only'
    AND NEW.authority_state = 'identity_bound'
    AND OLD.device_id IS NULL AND OLD.file_id IS NULL
    AND NEW.device_id IS NOT NULL AND btrim(NEW.device_id) <> ''
    AND NEW.file_id IS NOT NULL AND btrim(NEW.file_id) <> ''
    AND NEW.identity_bound_at IS NOT NULL
    AND NEW.quarantined_at IS NULL AND NEW.quarantine_reason IS NULL
    AND operation_lifecycle = 'reserved'
    AND operation_expiry > clock_timestamp()
  THEN
    RETURN NEW;
  END IF;

  IF OLD.authority_state = 'target_only'
    AND NEW.authority_state = 'quarantined'
    AND NEW.device_id IS NULL AND NEW.file_id IS NULL
    AND NEW.identity_bound_at IS NULL
    AND NEW.quarantined_at IS NOT NULL
    AND NEW.quarantine_reason IS NOT NULL AND btrim(NEW.quarantine_reason) <> ''
    AND operation_lifecycle = 'cleanup_pending'
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'durable filesystem prewrite authority transition is prohibited'
    USING ERRCODE = '55000';
END;
$$;

--
-- Name: enforce_image_job_asset_publication_mapping(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_image_job_asset_publication_mapping() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
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
$_$;

--
-- Name: enforce_portable_export_artifact_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_portable_export_artifact_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: enforce_portable_filesystem_cleanup_match(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_portable_filesystem_cleanup_match() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: enforce_portable_import_asset_publication(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_portable_import_asset_publication() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: enforce_portable_import_asset_reservation_intent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_portable_import_asset_reservation_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: enforce_portable_import_normalized_asset_context(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_portable_import_normalized_asset_context() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
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
$_$;

--
-- Name: enforce_portable_import_normalized_asset_publication(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_portable_import_normalized_asset_publication() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
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
$_$;

--
-- Name: enforce_portable_import_normalized_asset_reference(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_portable_import_normalized_asset_reference() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
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
$_$;

--
-- Name: enforce_portable_import_normalized_asset_source(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_portable_import_normalized_asset_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: enforce_portable_import_private_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_portable_import_private_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.normalized_payload IS DISTINCT FROM NEW.normalized_payload
    OR OLD.authority_fingerprint IS DISTINCT FROM NEW.authority_fingerprint
    OR OLD.provider_configuration_fingerprint IS DISTINCT FROM NEW.provider_configuration_fingerprint
    OR OLD.selected_character_id IS DISTINCT FROM NEW.selected_character_id
  THEN
    RAISE EXCEPTION 'portable import normalized authority is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: enforce_portable_import_work_transition(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_portable_import_work_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portable import work authority cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'running' OR NEW.phase <> 'previewed' OR NEW.percentage <> 20
      OR NEW.work_version <> 1 OR NEW.lease_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'portable import work initial state is invalid'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id
    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR NEW.work_version < OLD.work_version
  THEN
    RAISE EXCEPTION 'portable import work authority is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('aborted', 'completed', 'expired')
    AND ROW(OLD.status,OLD.phase,OLD.percentage,OLD.diagnostic_code,OLD.work_version,
            OLD.lease_id,OLD.lease_owner,OLD.lease_expires_at,OLD.terminal_at)
      IS DISTINCT FROM
        ROW(NEW.status,NEW.phase,NEW.percentage,NEW.diagnostic_code,NEW.work_version,
            NEW.lease_id,NEW.lease_owner,NEW.lease_expires_at,NEW.terminal_at)
  THEN
    RAISE EXCEPTION 'portable import terminal work is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: enforce_portable_staged_input_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_portable_staged_input_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
    OR (
      OLD.expires_at IS DISTINCT FROM NEW.expires_at
      AND NOT (
        NEW.expires_at > OLD.expires_at
        AND EXISTS (
          SELECT 1
            FROM system_archive_uploads upload
           WHERE upload.owner_user_id = NEW.owner_user_id
             AND upload.filesystem_operation_id = NEW.filesystem_operation_id
             AND upload.staged_input_id = NEW.id
             AND upload.status = 'completed'
             AND upload.expires_at >= NEW.expires_at
        )
      )
    )
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

--
-- Name: enforce_private_filesystem_delivery_grant(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_private_filesystem_delivery_grant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: enforce_private_finalized_asset_delivery_grant(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_private_finalized_asset_delivery_grant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finalized asset delivery grant cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.grant_token_hash IS DISTINCT FROM NEW.grant_token_hash
      OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
      OR OLD.delivery_intent IS DISTINCT FROM NEW.delivery_intent
      OR OLD.selected_row_kind IS DISTINCT FROM NEW.selected_row_kind
      OR OLD.selected_row_id IS DISTINCT FROM NEW.selected_row_id
      OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
      OR OLD.operation_purpose IS DISTINCT FROM NEW.operation_purpose
      OR OLD.candidate_token_hash IS DISTINCT FROM NEW.candidate_token_hash
      OR OLD.relative_path IS DISTINCT FROM NEW.relative_path
      OR OLD.device_id IS DISTINCT FROM NEW.device_id
      OR OLD.file_id IS DISTINCT FROM NEW.file_id
      OR OLD.change_token IS DISTINCT FROM NEW.change_token
      OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
      OR OLD.byte_length IS DISTINCT FROM NEW.byte_length
      OR OLD.mime_type IS DISTINCT FROM NEW.mime_type
      OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'finalized asset delivery authority is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.lifecycle <> 'issued'
      OR NEW.lifecycle NOT IN ('redeemed', 'expired', 'revoked')
    THEN
      RAISE EXCEPTION 'finalized asset delivery grant cannot be replayed'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.lifecycle = 'redeemed' THEN
      IF clock_timestamp() >= NEW.expires_at THEN
        RAISE EXCEPTION 'finalized asset delivery grant is stale'
          USING ERRCODE = '55000';
      END IF;
      PERFORM assert_private_finalized_asset_delivery_binding(NEW);
    ELSIF NEW.lifecycle = 'expired' AND clock_timestamp() < NEW.expires_at THEN
      RAISE EXCEPTION 'finalized asset delivery grant is not expired'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.lifecycle <> 'issued'
    OR NEW.expires_at <= clock_timestamp()
    OR NEW.expires_at > clock_timestamp() + private_asset_delivery_capability_max_lifetime()
  THEN
    RAISE EXCEPTION 'finalized asset delivery grant lifetime is invalid'
      USING ERRCODE = '55000';
  END IF;
  PERFORM assert_private_finalized_asset_delivery_binding(NEW);
  RETURN NEW;
END;
$$;

--
-- Name: enforce_private_legacy_asset_read_capability(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_private_legacy_asset_read_capability() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legacy asset read capability cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.capability_token_hash IS DISTINCT FROM NEW.capability_token_hash
      OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
      OR OLD.delivery_intent IS DISTINCT FROM NEW.delivery_intent
      OR OLD.selected_row_kind IS DISTINCT FROM NEW.selected_row_kind
      OR OLD.selected_row_id IS DISTINCT FROM NEW.selected_row_id
      OR OLD.relative_path IS DISTINCT FROM NEW.relative_path
      OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
      OR OLD.byte_length IS DISTINCT FROM NEW.byte_length
      OR OLD.mime_type IS DISTINCT FROM NEW.mime_type
      OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'legacy asset read authority is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.lifecycle <> 'issued'
      OR NEW.lifecycle NOT IN ('redeemed', 'expired', 'revoked')
    THEN
      RAISE EXCEPTION 'legacy asset read capability cannot be replayed'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.lifecycle = 'redeemed' THEN
      IF clock_timestamp() >= NEW.expires_at THEN
        RAISE EXCEPTION 'legacy asset read capability is stale'
          USING ERRCODE = '55000';
      END IF;
      PERFORM assert_private_legacy_asset_read_binding(NEW);
    ELSIF NEW.lifecycle = 'expired' AND clock_timestamp() < NEW.expires_at THEN
      RAISE EXCEPTION 'legacy asset read capability is not expired'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.lifecycle <> 'issued'
    OR NEW.expires_at <= clock_timestamp()
    OR NEW.expires_at > clock_timestamp() + private_asset_delivery_capability_max_lifetime()
  THEN
    RAISE EXCEPTION 'legacy asset read capability lifetime is invalid'
      USING ERRCODE = '55000';
  END IF;
  PERFORM assert_private_legacy_asset_read_binding(NEW);
  RETURN NEW;
END;
$$;

--
-- Name: enforce_system_archive_job_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_system_archive_job_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.id IS DISTINCT FROM NEW.id
      OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      OR OLD.kind IS DISTINCT FROM NEW.kind
      OR OLD.idempotency_key_hash IS DISTINCT FROM NEW.idempotency_key_hash
      OR OLD.staged_input_id IS DISTINCT FROM NEW.staged_input_id
      OR (OLD.export_artifact_id IS NOT NULL
        AND OLD.export_artifact_id IS DISTINCT FROM NEW.export_artifact_id)
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'system archive job authority is write-once'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.staged_input_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD.staged_input_id IS DISTINCT FROM NEW.staged_input_id)
  THEN
    PERFORM 1
      FROM portable_staged_inputs
     WHERE id = NEW.staged_input_id
       AND owner_user_id = NEW.owner_user_id
       AND status = 'staged'
     FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'system archive import staged-input scope is invalid'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF NEW.export_artifact_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD.export_artifact_id IS DISTINCT FROM NEW.export_artifact_id)
  THEN
    PERFORM 1
      FROM portable_export_artifacts
     WHERE id = NEW.export_artifact_id
       AND owner_user_id = NEW.owner_user_id
       AND export_kind = 'system_zip'
       AND status = 'ready'
     FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'system archive export artifact scope is invalid'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: enforce_system_archive_upload_chunk_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_system_archive_upload_chunk_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  upload system_archive_uploads%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'system archive upload chunks are immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO upload
    FROM system_archive_uploads
   WHERE id = NEW.upload_id
     AND owner_user_id = NEW.owner_user_id
     AND filesystem_operation_id = NEW.filesystem_operation_id
   FOR UPDATE;
  IF NOT FOUND
    OR upload.status NOT IN ('created', 'uploading')
    OR upload.expires_at <= clock_timestamp()
    OR NEW.byte_offset + NEW.byte_length > upload.byte_length
  THEN
    RAISE EXCEPTION 'system archive upload chunk scope is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM system_archive_upload_chunks existing
     WHERE existing.upload_id = NEW.upload_id
       AND int8range(existing.byte_offset, existing.byte_offset + existing.byte_length, '[)')
           && int8range(NEW.byte_offset, NEW.byte_offset + NEW.byte_length, '[)')
  ) THEN
    RAISE EXCEPTION 'system archive upload chunk range conflicts with existing data'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: enforce_system_archive_upload_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_system_archive_upload_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.id IS DISTINCT FROM NEW.id
      OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      OR OLD.handle_token_hash IS DISTINCT FROM NEW.handle_token_hash
      OR OLD.filesystem_operation_id IS DISTINCT FROM NEW.filesystem_operation_id
      OR OLD.byte_length IS DISTINCT FROM NEW.byte_length
      OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
      OR (OLD.staged_input_id IS NOT NULL
        AND OLD.staged_input_id IS DISTINCT FROM NEW.staged_input_id)
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'system archive upload authority is write-once'
        USING ERRCODE = '55000';
    END IF;

    IF OLD.status IS DISTINCT FROM NEW.status
      AND NOT (
        (OLD.status = 'created' AND NEW.status IN ('uploading', 'completed', 'expired', 'failed'))
        OR (OLD.status = 'uploading' AND NEW.status IN ('completed', 'expired', 'failed'))
      )
    THEN
      RAISE EXCEPTION 'system archive upload lifecycle transition is invalid'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  PERFORM 1
    FROM durable_filesystem_operations
   WHERE id = NEW.filesystem_operation_id
     AND owner_user_id = NEW.owner_user_id
     AND purpose = 'portable_staging'
     AND resource_kind = 'portable'
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'system archive upload filesystem scope is invalid'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.staged_input_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD.staged_input_id IS DISTINCT FROM NEW.staged_input_id)
  THEN
    PERFORM 1
      FROM portable_staged_inputs
     WHERE id = NEW.staged_input_id
       AND owner_user_id = NEW.owner_user_id
       AND filesystem_operation_id = NEW.filesystem_operation_id
       AND status = 'staged'
       AND content_hash = NEW.content_hash
       AND byte_length = NEW.byte_length
     FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'system archive upload staged-input scope is invalid'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: fence_authoring_job_text_plan_protocol(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fence_authoring_job_text_plan_protocol() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.text_plan_protocol = 2 AND NEW.text_plan_protocol IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'authoring text plan protocol cannot be downgraded';
  END IF;
  IF OLD.text_plan_protocol = 2 AND OLD.execution_snapshot IS NOT NULL
     AND NEW.execution_snapshot IS DISTINCT FROM OLD.execution_snapshot
     AND NEW.execution_snapshot IS NOT NULL THEN
    RAISE EXCEPTION 'authoring text execution snapshot is immutable';
  END IF;
  IF NEW.text_plan_protocol = 2 OR authoring_snapshot_requires_text_plan_protocol(NEW.execution_snapshot) THEN
    NEW.text_plan_protocol := 2;
  END IF;
  IF current_setting('app.blocked_text_plan_authoring_job', true) = OLD.id::text
     AND NEW.status = 'running' THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: fence_authoring_stage_text_plan_protocol(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fence_authoring_stage_text_plan_protocol() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  required_protocol smallint;
BEGIN
  SELECT text_plan_protocol INTO required_protocol FROM authoring_jobs WHERE id = OLD.job_id;
  IF required_protocol = 2
     AND NOT text_plan_protocol_is_current()
     AND NEW.status = 'running'
     AND NEW.attempt_count = OLD.attempt_count + 1
     AND NEW.lease_token IS NOT NULL
     AND NEW.lease_owner IS NOT NULL
     AND NEW.lease_expires_at IS NOT NULL THEN
    PERFORM set_config('app.blocked_text_plan_authoring_job', OLD.job_id::text, true);
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: fence_generation_text_plan_protocol(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fence_generation_text_plan_protocol() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  immutable_key text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.text_plan_protocol = 2 AND NEW.text_plan_protocol IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'generation text plan protocol cannot be downgraded';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    FOREACH immutable_key IN ARRAY ARRAY['queuedResponsePolicy','frozenResponseContracts','textExecutionRouteBasis','textExecutionPlan'] LOOP
      IF OLD.orchestration_private ? immutable_key
         AND NEW.orchestration_private->immutable_key IS DISTINCT FROM OLD.orchestration_private->immutable_key THEN
        RAISE EXCEPTION 'generation text plan evidence % is immutable', immutable_key;
      END IF;
    END LOOP;
    IF OLD.streaming_segments_state ? 'illustrationTextExecutionSnapshot'
       AND NEW.streaming_segments_state->'illustrationTextExecutionSnapshot'
         IS DISTINCT FROM OLD.streaming_segments_state->'illustrationTextExecutionSnapshot' THEN
      RAISE EXCEPTION 'generation illustration text execution snapshot is immutable';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.text_plan_protocol = 2
     OR story_requires_text_plan_protocol(NEW.orchestration_private, NEW.streaming_segments_state) THEN
    NEW.text_plan_protocol := 2;
  END IF;
  IF NEW.text_plan_protocol = 2
     AND NOT text_plan_protocol_is_current()
     AND NEW.status = 'assessing'
     AND NEW.attempts = OLD.attempts + 1
     AND NEW.lease_owner IS NOT NULL
     AND NEW.lease_expires_at IS NOT NULL
     AND (OLD.status IN ('queued','replacement_queued')
       OR OLD.status IN ('assessing','generating','validating','committing')) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: fence_illustration_prompt_text_plan_protocol(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fence_illustration_prompt_text_plan_protocol() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  parent_snapshot jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.text_plan_protocol = 2 AND NEW.text_plan_protocol IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'illustration text plan protocol cannot be downgraded';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.text_execution_snapshot IS NOT NULL
     AND NEW.text_execution_snapshot IS DISTINCT FROM OLD.text_execution_snapshot THEN
    RAISE EXCEPTION 'illustration text execution snapshot is immutable';
  END IF;
  IF NEW.generation_job_id IS NOT NULL THEN
    SELECT streaming_segments_state->'illustrationTextExecutionSnapshot'
      INTO parent_snapshot
      FROM generation_jobs
     WHERE id = NEW.generation_job_id
       AND streaming_segments_state ? 'illustrationTextExecutionSnapshot';
    IF FOUND THEN
      IF NOT valid_streaming_illustration_text_snapshot(parent_snapshot) THEN
        RAISE EXCEPTION 'generation illustration text execution snapshot is invalid';
      END IF;
      IF NEW.text_execution_snapshot IS DISTINCT FROM parent_snapshot THEN
        RAISE EXCEPTION 'illustration child must copy the generation text execution snapshot';
      END IF;
    END IF;
  END IF;
  IF NEW.text_plan_protocol = 2 OR illustration_snapshot_requires_text_plan_protocol(NEW.text_execution_snapshot) THEN
    NEW.text_plan_protocol := 2;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.text_plan_protocol = 2
     AND NOT text_plan_protocol_is_current()
     AND NEW.status = 'refining'
     AND NEW.attempts = OLD.attempts + 1
     AND NEW.lease_owner IS NOT NULL
     AND NEW.lease_expires_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: guard_portable_export_artifact_deletion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_portable_export_artifact_deletion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.export_kind = 'campaign_zip'
    AND OLD.status = 'cleaned'
    AND EXISTS (
      SELECT 1 FROM durable_filesystem_operations
       WHERE id = OLD.filesystem_operation_id
         AND owner_user_id = OLD.owner_user_id
         AND purpose = 'portable_export'
         AND lifecycle = 'cleaned'
    )
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'portable export artifact authority cannot be deleted before campaign export cleanup'
    USING ERRCODE = '55000';
END;
$$;

--
-- Name: illustration_snapshot_requires_text_plan_protocol(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.illustration_snapshot_requires_text_plan_protocol(snapshot jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT snapshot IS NOT NULL AND NOT COALESCE(valid_historical_illustration_snapshot(snapshot),false)
$$;

--
-- Name: javascript_json_number_text(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.javascript_json_number_text(value jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET extra_float_digits TO '3'
    AS $$
DECLARE
  rendered text; mantissa text; digits text; integer_part text; fractional_part text;
  sign text := ''; exponent integer := 0; first_significant integer; decimal_exponent integer; decimal_position integer;
BEGIN
  rendered := pg_catalog.float8out((value #>> '{}')::double precision);
  IF rendered IN ('NaN','Infinity','-Infinity') THEN RETURN 'null'; END IF;
  IF left(rendered,1)='-' THEN sign := '-'; rendered := substr(rendered,2); END IF;
  IF rendered ~ '[eE]' THEN
    mantissa := split_part(lower(rendered),'e',1);
    exponent := split_part(lower(rendered),'e',2)::integer;
  ELSE
    mantissa := rendered;
  END IF;
  integer_part := split_part(mantissa,'.',1);
  fractional_part := CASE WHEN position('.' IN mantissa)>0 THEN split_part(mantissa,'.',2) ELSE '' END;
  rendered := integer_part || fractional_part;
  first_significant := length(rendered) - length(ltrim(rendered,'0')) + 1;
  IF first_significant > length(rendered) THEN RETURN '0'; END IF;
  digits := rtrim(substr(rendered,first_significant),'0');
  decimal_exponent := length(integer_part) - first_significant + exponent;
  IF decimal_exponent < -6 OR decimal_exponent >= 21 THEN
    RETURN sign || left(digits,1)
      || CASE WHEN length(digits)>1 THEN '.' || substr(digits,2) ELSE '' END
      || 'e' || CASE WHEN decimal_exponent>=0 THEN '+' ELSE '' END || decimal_exponent::text;
  END IF;
  decimal_position := decimal_exponent + 1;
  IF decimal_position <= 0 THEN
    RETURN sign || '0.' || repeat('0',-decimal_position) || digits;
  END IF;
  IF decimal_position >= length(digits) THEN
    RETURN sign || digits || repeat('0',decimal_position-length(digits));
  END IF;
  RETURN sign || left(digits,decimal_position) || '.' || substr(digits,decimal_position+1);
END;
$$;

--
-- Name: javascript_utf16_sort_key(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.javascript_utf16_sort_key(value text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $$
DECLARE result text := ''; code_point integer; index integer;
BEGIN
  FOR index IN 1..char_length(value) LOOP
    code_point := ascii(substr(value,index,1));
    IF code_point <= 65535 THEN
      result := result || lpad(to_hex(code_point),4,'0');
    ELSE
      code_point := code_point - 65536;
      result := result
        || lpad(to_hex(55296 + code_point / 1024),4,'0')
        || lpad(to_hex(56320 + code_point % 1024),4,'0');
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

--
-- Name: jsonb_object_has_keys(jsonb, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jsonb_object_has_keys(value jsonb, required text[]) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM unnest(required) key WHERE NOT value ? key);
END;
$$;

--
-- Name: jsonb_object_has_only_keys(jsonb, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jsonb_object_has_only_keys(value jsonb, allowed text[]) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM jsonb_object_keys(value) key WHERE NOT key = ANY(allowed));
END;
$$;

--
-- Name: maintain_world_next_version_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.maintain_world_next_version_number() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE worlds
     SET next_version_number = GREATEST(next_version_number, NEW.version_number + 1)
   WHERE id = NEW.world_id
     AND owner_user_id = NEW.owner_user_id;
  RETURN NEW;
END;
$$;

--
-- Name: notify_generation_job_changed_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_generation_job_changed_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  notification_version text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status IS NOT DISTINCT FROM NEW.status
     AND OLD.partial_output IS NOT DISTINCT FROM NEW.partial_output
     AND OLD.attempts IS NOT DISTINCT FROM NEW.attempts
     AND OLD.result_turn_id IS NOT DISTINCT FROM NEW.result_turn_id THEN
    RETURN NEW;
  END IF;

  notification_version := md5(concat_ws(
    E'\x1f',
    NEW.status,
    NEW.attempts::text,
    COALESCE(NEW.result_turn_id::text, ''),
    COALESCE(NEW.partial_output, '')
  ));

  PERFORM pg_notify(
    'infinitequest_generation_changed_v1',
    json_build_object(
      'jobId', NEW.id::text,
      'version', notification_version
    )::text
  );
  RETURN NEW;
END;
$$;

--
-- Name: portable_import_normalized_payload_is_safe(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.portable_import_normalized_payload_is_safe(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    AS $_$
  WITH RECURSIVE nodes(node_path, value) AS (
    SELECT ARRAY[]::text[], value
    UNION ALL
    SELECT parent.node_path || child.child_path, child.value
      FROM nodes parent
      CROSS JOIN LATERAL (
        SELECT ARRAY[object_key]::text[] AS child_path, object_value AS value
          FROM jsonb_each(CASE WHEN jsonb_typeof(parent.value) = 'object' THEN parent.value ELSE '{}'::jsonb END)
               AS object_child(object_key, object_value)
        UNION ALL
        SELECT ARRAY[(ordinality - 1)::text]::text[] AS child_path, array_value AS value
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(parent.value) = 'array' THEN parent.value ELSE '[]'::jsonb END)
               WITH ORDINALITY AS array_child(array_value, ordinality)
      ) child
  ), keys AS (
    SELECT nodes.node_path, object_key, object_value
      FROM nodes
      CROSS JOIN LATERAL jsonb_each(
        CASE WHEN jsonb_typeof(nodes.value) = 'object' THEN nodes.value ELSE '{}'::jsonb END
      ) AS object_child(object_key, object_value)
  )
  SELECT NOT EXISTS (
    SELECT 1 FROM keys
     WHERE object_key ~* '(^|_)(path|bearer|credential|secret|token|provider_response|raw_response)($|_)'
       AND NOT (
         object_key = 'path'
         AND cardinality(node_path) >= 3
         AND node_path[cardinality(node_path) - 2] = 'sourceMaterial'
         AND node_path[cardinality(node_path) - 1] = 'fieldEvidence'
         AND node_path[cardinality(node_path)] ~ '^[0-9]+$'
         AND jsonb_typeof(object_value) = 'string'
         AND object_value #>> '{}' ~ '^(world\.(tone|rules)|playableCharacters\.source-character:.+\.profile\.appearance\.(clothing|hair|eyes|apparentAge))$'
       )
  );
$_$;

--
-- Name: portable_import_normalized_safe_result_valid(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.portable_import_normalized_safe_result_valid(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
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
$_$;

--
-- Name: private_asset_delivery_capability_max_lifetime(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.private_asset_delivery_capability_max_lifetime() RETURNS interval
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT interval '60 seconds';
$$;

--
-- Name: private_filesystem_delivery_grant_max_lifetime(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.private_filesystem_delivery_grant_max_lifetime() RETURNS interval
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT interval '60 seconds';
$$;

--
-- Name: protect_archive_policy_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_archive_policy_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.policy_snapshot IS DISTINCT FROM NEW.policy_snapshot THEN
    RAISE EXCEPTION 'archive_policy_snapshot_immutable';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: protect_instance_settings_evidence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_instance_settings_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'immutable_instance_settings_evidence'; END;
$$;

--
-- Name: protect_portable_scope_parent_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_portable_scope_parent_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_TABLE_NAME = 'imports' THEN
    IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      AND EXISTS (
        SELECT 1 FROM portable_import_operations WHERE import_id = OLD.id
      )
    THEN
      RAISE EXCEPTION 'referenced import owner scope is immutable'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'world_versions' THEN
    IF (OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      OR OLD.world_id IS DISTINCT FROM NEW.world_id)
      AND (
        EXISTS (
          SELECT 1 FROM portable_import_operations
           WHERE destination_world_version_id = OLD.id
        )
        OR EXISTS (
          SELECT 1 FROM portable_export_artifacts WHERE world_version_id = OLD.id
        )
      )
    THEN
      RAISE EXCEPTION 'referenced world version portable scope is immutable'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'campaigns' THEN
    IF (OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
      OR OLD.world_version_id IS DISTINCT FROM NEW.world_version_id)
      AND EXISTS (
        SELECT 1 FROM portable_export_artifacts WHERE campaign_id = OLD.id
      )
    THEN
      RAISE EXCEPTION 'referenced campaign portable scope is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: reject_asset_publication_request_child_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_asset_publication_request_child_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'asset publication request child is immutable'
    USING ERRCODE='55000';
END;
$$;

--
-- Name: reject_durable_filesystem_descriptor_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_durable_filesystem_descriptor_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'durable filesystem descriptors are immutable';
END;
$$;

--
-- Name: seed_campaign_story_memory_default(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.seed_campaign_story_memory_default() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO campaign_story_memory_enrollments(campaign_id,owner_user_id,capability,review_mode)
  VALUES(NEW.id,NEW.owner_user_id,'r3','off')
  ON CONFLICT (campaign_id) DO NOTHING;
  RETURN NEW;
END;
$$;

--
-- Name: story_requires_text_plan_protocol(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.story_requires_text_plan_protocol(orchestration jsonb, streaming jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  invocation jsonb;
BEGIN
  IF orchestration ? 'textExecutionRouteBasis' OR orchestration ? 'textExecutionPlan' THEN
    RETURN true;
  END IF;
  IF orchestration ? 'queuedResponsePolicy' THEN
    IF NOT valid_v1_queued_response_policy(orchestration->'queuedResponsePolicy') THEN RETURN true; END IF;
  END IF;
  IF orchestration ? 'frozenResponseContracts' THEN
    IF NOT valid_v1_frozen_response_contracts(orchestration->'frozenResponseContracts') THEN RETURN true; END IF;
  END IF;
  IF orchestration ? 'responseContractInvocations' THEN
    IF jsonb_typeof(orchestration->'responseContractInvocations') IS DISTINCT FROM 'array' THEN
      RETURN true;
    END IF;
    FOR invocation IN SELECT value FROM jsonb_array_elements(orchestration->'responseContractInvocations') LOOP
      IF NOT valid_v1_response_contract_invocation(invocation) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN streaming ? 'illustrationTextExecutionSnapshot';
END;
$$;

--
-- Name: text_plan_protocol_is_current(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.text_plan_protocol_is_current() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT COALESCE(current_setting('app.text_plan_protocol', true) = '2', false)
$$;

--
-- Name: valid_bounded_string_array(jsonb, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_bounded_string_array(value jsonb, maximum_items integer, maximum_length integer) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE item jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array' OR jsonb_array_length(value)>maximum_items THEN RETURN false; END IF;
  FOR item IN SELECT entry FROM jsonb_array_elements(value) entry LOOP
    IF NOT valid_bounded_text(item,1,maximum_length) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

--
-- Name: valid_bounded_text(jsonb, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_bounded_text(value jsonb, minimum integer, maximum integer) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'string'
    AND char_length(btrim(value #>> '{}')) >= minimum
    AND char_length(value #>> '{}') <= maximum, false)
$$;

--
-- Name: valid_derived_text_execution_plan(jsonb, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_derived_text_execution_plan(route_basis jsonb, plan jsonb, operation_prompt text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE composed_prompt text; expected_plan jsonb;
BEGIN
  IF NOT valid_text_execution_route_shape(route_basis,false)
     OR NOT valid_text_execution_route_shape(plan,true) THEN RETURN false; END IF;
  composed_prompt := CASE WHEN btrim(route_basis->>'presetSystemPrompt')=''
    THEN btrim(operation_prompt)
    ELSE btrim(route_basis->>'presetSystemPrompt') || E'\n\n' || btrim(operation_prompt) END;
  expected_plan := route_basis || jsonb_build_object(
    'prompt',composed_prompt,
    'promptHash',encode(digest(convert_to(composed_prompt,'UTF8'),'sha256'),'hex')
  );
  RETURN plan-'planHash'=expected_plan;
END;
$$;

--
-- Name: valid_frozen_contract_authority_v2(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_frozen_contract_authority_v2(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  IF value->>'kind'='preset_trusted' THEN
    RETURN jsonb_object_has_only_keys(value,ARRAY['kind','routeBasisHash'])
      AND jsonb_object_has_keys(value,ARRAY['kind','routeBasisHash']) AND valid_hash_text(value->'routeBasisHash');
  END IF;
  IF value->>'kind'<>'model_verified' THEN RETURN false; END IF;
  RETURN jsonb_object_has_only_keys(value,ARRAY['kind','providerProfileId','providerType','endpointIdentity','model','providerConfigurationHash','routeConfigHash','verificationRegistryHash','routeBasisHash'])
    AND jsonb_object_has_keys(value,ARRAY['kind','providerProfileId','providerType','endpointIdentity','model','providerConfigurationHash','routeConfigHash','verificationRegistryHash'])
    AND valid_uuid_text(value->'providerProfileId') AND value->>'providerType' IN ('openrouter','openai_compatible')
    AND valid_bounded_text(value->'endpointIdentity',1,512) AND valid_bounded_text(value->'model',1,512)
    AND valid_hash_text(value->'providerConfigurationHash') AND valid_hash_text(value->'routeConfigHash')
    AND valid_hash_text(value->'verificationRegistryHash') AND (NOT value ? 'routeBasisHash' OR valid_hash_text(value->'routeBasisHash'));
END;
$$;

--
-- Name: valid_frozen_response_contracts_v2(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_frozen_response_contracts_v2(document jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE contract jsonb; key text; policy jsonb; verification jsonb;
BEGIN
  IF NOT jsonb_object_has_only_keys(document,ARRAY['version','queuedPolicy','selectedAt','capabilityEvidenceHash','contracts','selectionHash'])
     OR NOT jsonb_object_has_keys(document,ARRAY['version','queuedPolicy','selectedAt','capabilityEvidenceHash','contracts','selectionHash'])
     OR document->>'version'<>'2' OR NOT valid_iso_datetime_text(document->'selectedAt')
     OR NOT valid_hash_text(document->'capabilityEvidenceHash') OR NOT valid_hash_text(document->'selectionHash')
     OR document->>'selectionHash'<>canonical_jsonb_sha256(document-'selectionHash')
     OR jsonb_typeof(document->'contracts') IS DISTINCT FROM 'object' OR document->'contracts'='{}'::jsonb THEN RETURN false; END IF;
  policy := document->'queuedPolicy';
  IF NOT jsonb_object_has_only_keys(policy,ARRAY['version','policy','providerProfileId','admission','authority','operationClosureVersion','invocationKeys'])
     OR NOT jsonb_object_has_keys(policy,ARRAY['version','policy','providerProfileId','admission','authority','operationClosureVersion','invocationKeys'])
     OR policy->>'version'<>'2' OR policy->>'policy'<>'required' OR NOT valid_uuid_text(policy->'providerProfileId')
     OR policy->>'operationClosureVersion'<>'2' OR NOT valid_response_contract_admission_v2(policy->'admission')
     OR NOT valid_queued_contract_authority_v2(policy->'authority')
     OR policy->'admission'->>'basis' IS DISTINCT FROM policy->'authority'->>'kind'
     OR jsonb_typeof(policy->'invocationKeys')<>'array'
     OR jsonb_array_length(policy->'invocationKeys') NOT BETWEEN 1 AND 17 THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(policy->'invocationKeys') invocation(invocation_key)
     WHERE invocation.invocation_key NOT IN ('story:stream','story:nonstream','choices:nonstream','continuity_review:nonstream','rpg_assessment:nonstream','event_trigger_before:nonstream','event_trigger_after:nonstream','scene_coverage:nonstream','event_coverage:nonstream','world_outline:nonstream','world_seed_character:nonstream','standalone_character:nonstream','character_organizer:nonstream','source_extraction:nonstream','source_synthesis:nonstream','source_character:nonstream','illustration_prompt_refinement:nonstream')
  ) OR (SELECT count(*)<>count(DISTINCT invocation.invocation_key) FROM jsonb_array_elements_text(policy->'invocationKeys') invocation(invocation_key)) THEN RETURN false; END IF;
  IF policy->'authority'->>'kind'='model_verified' THEN
    verification := policy->'admission'->'verification';
    IF policy->>'providerProfileId' IS DISTINCT FROM policy->'authority'->>'providerProfileId'
       OR verification->>'providerType' IS DISTINCT FROM policy->'authority'->>'providerType'
       OR verification->>'endpointIdentity' IS DISTINCT FROM policy->'authority'->>'endpointIdentity'
       OR verification->>'model' IS DISTINCT FROM policy->'authority'->>'model'
       OR verification->>'routeConfigHash' IS DISTINCT FROM policy->'authority'->>'routeConfigHash'
       OR NOT (policy->'invocationKeys') ? (verification->>'operation' || ':' || CASE WHEN verification->>'streaming'='true' THEN 'stream' ELSE 'nonstream' END)
       THEN RETURN false; END IF;
  END IF;
  FOR key, contract IN SELECT * FROM jsonb_each(document->'contracts') LOOP
    IF NOT (policy->'invocationKeys') ? key
       OR NOT jsonb_object_has_only_keys(contract,ARRAY['version','mode','admission','operation','streaming','forbidFormatFallback','schemaVersion','schemaHash','schemaName','schema','authority'])
       OR NOT jsonb_object_has_keys(contract,ARRAY['version','mode','admission','operation','streaming','forbidFormatFallback','schemaVersion','schemaHash','schemaName','schema','authority'])
       OR contract->>'version'<>'2' OR contract->>'mode'<>'json_schema' OR contract->>'forbidFormatFallback'<>'true'
       OR NOT valid_response_contract_admission_v2(contract->'admission') OR NOT valid_frozen_contract_authority_v2(contract->'authority')
       OR contract->'admission'->>'basis' IS DISTINCT FROM contract->'authority'->>'kind'
       OR contract->'admission'->>'basis' IS DISTINCT FROM policy->'admission'->>'basis'
       OR contract->'authority'->>'kind' IS DISTINCT FROM policy->'authority'->>'kind'
       OR NOT valid_bounded_text(contract->'operation',1,100) OR jsonb_typeof(contract->'streaming')<>'boolean'
       OR NOT valid_bounded_text(contract->'schemaVersion',1,200) OR NOT valid_hash_text(contract->'schemaHash')
       OR contract->>'schemaHash'<>canonical_jsonb_sha256(contract->'schema')
       OR NOT valid_bounded_text(contract->'schemaName',1,200) OR jsonb_typeof(contract->'schema')<>'object'
       OR contract->>'operation' IS DISTINCT FROM split_part(key,':',1)
       OR contract->'streaming' IS DISTINCT FROM to_jsonb(split_part(key,':',2)='stream') THEN RETURN false; END IF;
    IF policy->'authority'->>'kind'='model_verified' THEN
      IF contract->'authority' IS DISTINCT FROM ((policy->'authority') - 'authorityRevision'::text) THEN RETURN false; END IF;
      IF policy->'admission'->'verification'->>'operation'=contract->>'operation'
         AND policy->'admission'->'verification'->>'streaming'=contract->>'streaming'
         AND policy->'admission'->'verification'->>'schemaHash' IS DISTINCT FROM contract->>'schemaHash'
         THEN RETURN false; END IF;
    ELSIF contract->'authority' IS DISTINCT FROM jsonb_build_object(
      'kind','preset_trusted','routeBasisHash',policy->'authority'->'routeBasisHash'
    ) THEN RETURN false; END IF;
  END LOOP;
  RETURN NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(policy->'invocationKeys') queued WHERE NOT (document->'contracts') ? queued);
END;
$$;

--
-- Name: valid_hash_text(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_hash_text(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT COALESCE(jsonb_typeof(value) = 'string' AND value #>> '{}' ~ '^[a-f0-9]{64}$', false)
$_$;

--
-- Name: valid_historical_authoring_snapshot(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_historical_authoring_snapshot(snapshot jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE plan jsonb; operation text; base_keys text[] := ARRAY['providerProfileId','model','configurationHash','contextWindowTokens','maxOutputTokens','requestTimeoutMs','prompts','protocols'];
BEGIN
  IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object'
     OR NOT valid_bounded_text(snapshot->'providerProfileId',1,200) OR NOT valid_bounded_text(snapshot->'model',1,500)
     OR NOT valid_hash_text(snapshot->'configurationHash') OR NOT valid_positive_integer(snapshot->'contextWindowTokens')
     OR NOT valid_positive_integer(snapshot->'maxOutputTokens') OR NOT valid_positive_integer(snapshot->'requestTimeoutMs')
     OR NOT valid_string_record(snapshot->'prompts',0,200000) OR NOT valid_string_record(snapshot->'protocols',1,1000) THEN RETURN false; END IF;
  IF NOT snapshot ? 'version' THEN
    RETURN jsonb_object_has_only_keys(snapshot,base_keys) AND jsonb_object_has_keys(snapshot,base_keys);
  END IF;
  IF snapshot->>'version'<>'2' OR NOT jsonb_object_has_only_keys(snapshot,base_keys || ARRAY['version','textExecutionPlans'])
     OR NOT jsonb_object_has_keys(snapshot,base_keys || ARRAY['version','textExecutionPlans'])
     OR jsonb_typeof(snapshot->'textExecutionPlans') IS DISTINCT FROM 'object' OR snapshot->'textExecutionPlans'='{}'::jsonb THEN RETURN false; END IF;
  FOR operation, plan IN SELECT * FROM jsonb_each(snapshot->'textExecutionPlans') LOOP
    IF operation NOT IN ('worldOutline','worldOutlineRepair','seedCharacter','seedCharacterRepair','standaloneCharacter','standaloneCharacterRepair','sourceExtraction','sourceExtractionRepair','sourceWorld','sourceWorldRepair','sourceSynthesis','sourceSynthesisRepair','sourceCharacter','sourceCharacterRepair')
       OR NOT valid_text_execution_route_shape(plan,true) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

--
-- Name: valid_historical_illustration_snapshot(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_historical_illustration_snapshot(snapshot jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' OR snapshot->>'version'<>'2'
     OR snapshot->>'state' NOT IN ('prepared','unavailable') THEN RETURN false; END IF;
  IF snapshot->>'state'='unavailable' THEN
    RETURN jsonb_object_has_only_keys(snapshot,ARRAY['version','state','errorCode'])
      AND jsonb_object_has_keys(snapshot,ARRAY['version','state','errorCode'])
      AND snapshot->>'errorCode'='illustration_text_route_unavailable';
  END IF;
  RETURN jsonb_object_has_only_keys(snapshot,ARRAY['version','state','ownerUserId','operationPrompt','routeBasis','plan'])
    AND jsonb_object_has_keys(snapshot,ARRAY['version','state','ownerUserId','operationPrompt','routeBasis','plan'])
    AND valid_bounded_text(snapshot->'ownerUserId',1,200) AND valid_bounded_text(snapshot->'operationPrompt',1,200000)
    AND valid_derived_text_execution_plan(snapshot->'routeBasis',snapshot->'plan',snapshot->>'operationPrompt');
END;
$$;

--
-- Name: valid_iso_datetime_text(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_iso_datetime_text(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT COALESCE(jsonb_typeof(value) = 'string'
    AND value #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$', false)
$_$;

--
-- Name: valid_json_number(jsonb, numeric, numeric, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_json_number(value jsonb, minimum numeric, maximum numeric, integral boolean DEFAULT false) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE number_value numeric;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  number_value := (value #>> '{}')::numeric;
  RETURN number_value BETWEEN minimum AND maximum AND (NOT integral OR number_value=trunc(number_value));
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

--
-- Name: valid_positive_integer(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_positive_integer(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT COALESCE(jsonb_typeof(value) = 'number'
    AND value #>> '{}' ~ '^[0-9]+$' AND (value #>> '{}')::numeric > 0, false)
$_$;

--
-- Name: valid_provider_routing_policy(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_provider_routing_policy(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE key text; price jsonb;
BEGIN
  IF NOT jsonb_object_has_only_keys(value,ARRAY['order','only','ignore','allow_fallbacks','require_parameters','data_collection','sort','quantizations','enforce_distillable_text','preferred_min_throughput','preferred_max_latency','max_price','zdr'])
     OR (value ? 'order' AND value ? 'sort') THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['order','only','ignore','quantizations'] LOOP
    IF value ? key AND NOT valid_bounded_string_array(value->key,64,500) THEN RETURN false; END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['allow_fallbacks','require_parameters','enforce_distillable_text','zdr'] LOOP
    IF value ? key AND jsonb_typeof(value->key) IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
  END LOOP;
  IF value ? 'data_collection' AND value->>'data_collection' NOT IN ('allow','deny') THEN RETURN false; END IF;
  IF value ? 'sort' AND value->>'sort' NOT IN ('price','throughput','latency') THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['preferred_min_throughput','preferred_max_latency'] LOOP
    IF value ? key AND NOT valid_json_number(value->key,0,1e100,false) THEN RETURN false; END IF;
  END LOOP;
  IF value ? 'max_price' THEN
    price := value->'max_price';
    IF NOT jsonb_object_has_only_keys(price,ARRAY['prompt','completion','image','request']) OR price='{}'::jsonb THEN RETURN false; END IF;
    FOREACH key IN ARRAY ARRAY['prompt','completion','image','request'] LOOP
      IF price ? key AND NOT valid_json_number(price->key,0,1e100,false) THEN RETURN false; END IF;
    END LOOP;
  END IF;
  RETURN true;
END;
$$;

--
-- Name: valid_queued_contract_authority_v2(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_queued_contract_authority_v2(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE selection jsonb;
BEGIN
  IF value->>'kind'='preset_trusted' THEN
    selection := value->'selection';
    RETURN jsonb_object_has_only_keys(value,ARRAY['kind','routeBasisHash','selection','endpointReference','credentialReference','authorityRevision','profileRevision'])
      AND jsonb_object_has_keys(value,ARRAY['kind','routeBasisHash','selection','endpointReference','credentialReference','authorityRevision','profileRevision'])
      AND valid_hash_text(value->'routeBasisHash')
      AND jsonb_object_has_only_keys(selection,ARRAY['kind','slug']) AND jsonb_object_has_keys(selection,ARRAY['kind','slug'])
      AND selection->>'kind'='openrouter_preset' AND valid_bounded_text(selection->'slug',1,200)
      AND valid_bounded_text(value->'endpointReference',1,500)
      AND (value->'credentialReference'='null'::jsonb OR valid_bounded_text(value->'credentialReference',1,500))
      AND valid_bounded_text(value->'authorityRevision',1,500) AND valid_bounded_text(value->'profileRevision',1,500);
  END IF;
  IF value->>'kind'<>'model_verified' THEN RETURN false; END IF;
  RETURN jsonb_object_has_only_keys(value,ARRAY['kind','providerProfileId','providerType','endpointIdentity','model','providerConfigurationHash','routeConfigHash','verificationRegistryHash','authorityRevision','routeBasisHash'])
    AND jsonb_object_has_keys(value,ARRAY['kind','providerProfileId','providerType','endpointIdentity','model','providerConfigurationHash','routeConfigHash','verificationRegistryHash','authorityRevision'])
    AND valid_frozen_contract_authority_v2(value-'authorityRevision') AND valid_bounded_text(value->'authorityRevision',1,500);
END;
$$;

--
-- Name: valid_response_contract_admission_v2(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_response_contract_admission_v2(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE verification jsonb;
BEGIN
  IF value->>'mode'<>'json_schema' OR value->>'basis' NOT IN ('model_verified','preset_trusted') THEN RETURN false; END IF;
  IF value->>'basis'='preset_trusted' THEN
    RETURN jsonb_object_has_only_keys(value,ARRAY['mode','basis']) AND jsonb_object_has_keys(value,ARRAY['mode','basis']);
  END IF;
  IF NOT jsonb_object_has_only_keys(value,ARRAY['mode','basis','verification'])
     OR NOT jsonb_object_has_keys(value,ARRAY['mode','basis','verification']) THEN RETURN false; END IF;
  verification := value->'verification';
  RETURN jsonb_object_has_only_keys(verification,ARRAY['version','providerType','endpointIdentity','model','routeConfigHash','adapterProtocol','operation','schemaHash','streaming','verifiedAt','expiresAt','providerRoutingSlugs','nativeOpenTrackerObjects'])
    AND jsonb_object_has_keys(verification,ARRAY['version','providerType','endpointIdentity','model','routeConfigHash','adapterProtocol','operation','schemaHash','streaming','verifiedAt','expiresAt','providerRoutingSlugs','nativeOpenTrackerObjects'])
    AND verification->>'version'='2' AND verification->>'providerType' IN ('openrouter','openai_compatible')
    AND valid_bounded_text(verification->'endpointIdentity',1,512) AND valid_bounded_text(verification->'model',1,512)
    AND valid_hash_text(verification->'routeConfigHash') AND verification->>'adapterProtocol'='text-schema-adapter-v2'
    AND verification->>'operation' IN ('story','choices','continuity_review','rpg_assessment','event_trigger_before','event_trigger_after','scene_coverage','event_coverage','world_outline','world_seed_character','standalone_character','character_organizer','source_extraction','source_synthesis','source_character','illustration_prompt_refinement')
    AND valid_hash_text(verification->'schemaHash') AND jsonb_typeof(verification->'streaming')='boolean'
    AND valid_bounded_text(verification->'verifiedAt',1,100) AND valid_bounded_text(verification->'expiresAt',1,100)
    AND valid_bounded_string_array(verification->'providerRoutingSlugs',64,500)
    AND jsonb_typeof(verification->'nativeOpenTrackerObjects')='boolean';
END;
$$;

--
-- Name: valid_streaming_illustration_text_snapshot(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_streaming_illustration_text_snapshot(snapshot jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE request_config jsonb;
BEGIN
  IF valid_historical_illustration_snapshot(snapshot) THEN RETURN true; END IF;
  IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' OR snapshot->>'version'<>'3'
     OR snapshot->>'state' NOT IN ('prepared','unavailable') THEN RETURN false; END IF;
  IF snapshot->>'state'='unavailable' THEN
    RETURN jsonb_object_has_only_keys(snapshot,ARRAY['version','state','errorCode'])
      AND jsonb_object_has_keys(snapshot,ARRAY['version','state','errorCode'])
      AND snapshot->>'errorCode'='illustration_text_route_unavailable';
  END IF;
  IF NOT jsonb_object_has_only_keys(snapshot,ARRAY['version','state','ownerUserId','operationPrompt','providerType','requestConfiguration','routeBasis','plan','frozenResponseContracts','trustedOperationPrompt'])
     OR NOT jsonb_object_has_keys(snapshot,ARRAY['version','state','ownerUserId','operationPrompt','providerType','requestConfiguration','routeBasis','plan','frozenResponseContracts','trustedOperationPrompt'])
     OR NOT valid_bounded_text(snapshot->'ownerUserId',1,200) OR NOT valid_bounded_text(snapshot->'operationPrompt',1,200000)
     OR snapshot->>'providerType' NOT IN ('openrouter','openai_compatible')
     OR NOT valid_bounded_text(snapshot->'trustedOperationPrompt',1,200000)
     OR snapshot->>'trustedOperationPrompt' IS DISTINCT FROM snapshot->>'operationPrompt'
     OR NOT valid_derived_text_execution_plan(snapshot->'routeBasis',snapshot->'plan',snapshot->>'operationPrompt')
     OR NOT valid_frozen_response_contracts_v2(snapshot->'frozenResponseContracts') THEN RETURN false; END IF;
  request_config := snapshot->'requestConfiguration';
  RETURN jsonb_object_has_only_keys(request_config,ARRAY['httpReferer'])
    AND (NOT request_config ? 'httpReferer' OR valid_bounded_text(request_config->'httpReferer',1,2000));
END;
$$;

--
-- Name: valid_string_record(jsonb, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_string_record(value jsonb, value_minimum integer, value_maximum integer) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM jsonb_each(value) entry
     WHERE char_length(entry.key) NOT BETWEEN 1 AND 200 OR NOT valid_bounded_text(entry.value,value_minimum,value_maximum));
END;
$$;

--
-- Name: valid_text_execution_route_shape(jsonb, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_text_execution_route_shape(document jsonb, plan boolean) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE candidate jsonb; selection jsonb; preset jsonb; required text[]; allowed text[];
BEGIN
  required := ARRAY['version','selection','preset','candidates','presetSystemPrompt','parameters','endpointReference','credentialReference','profileRevision','protocolVersion'];
  allowed := required || ARRAY['authorityRevision','requestTimeoutMs'];
  IF plan THEN
    required := required || ARRAY['prompt','promptHash','planHash'];
    allowed := allowed || ARRAY['prompt','promptHash','routeBasisHash','planHash'];
  ELSE
    required := required || ARRAY['requestTimeoutMs','routeBasisHash'];
    allowed := allowed || ARRAY['routeBasisHash'];
  END IF;
  IF NOT jsonb_object_has_only_keys(document,allowed) OR NOT jsonb_object_has_keys(document,required)
     OR document->>'version'<>'2' THEN RETURN false; END IF;
  selection := document->'selection';
  IF jsonb_typeof(selection) IS DISTINCT FROM 'object' OR selection->>'kind' NOT IN ('model','openrouter_preset') THEN RETURN false; END IF;
  IF selection->>'kind'='model' THEN
    IF NOT jsonb_object_has_only_keys(selection,ARRAY['kind','modelId']) OR NOT jsonb_object_has_keys(selection,ARRAY['kind','modelId'])
       OR jsonb_typeof(selection->'modelId')<>'string' OR char_length(selection->>'modelId')>500 THEN RETURN false; END IF;
  ELSE
    IF NOT jsonb_object_has_only_keys(selection,ARRAY['kind','slug']) OR NOT jsonb_object_has_keys(selection,ARRAY['kind','slug'])
       OR NOT valid_bounded_text(selection->'slug',1,200) OR selection->>'slug' !~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$' THEN RETURN false; END IF;
  END IF;
  preset := document->'preset';
  IF preset <> 'null'::jsonb AND (NOT jsonb_object_has_only_keys(preset,ARRAY['slug','versionId','configHash'])
     OR NOT jsonb_object_has_keys(preset,ARRAY['slug','versionId','configHash'])
     OR NOT valid_bounded_text(preset->'slug',1,200) OR NOT valid_bounded_text(preset->'versionId',1,500)
     OR NOT valid_hash_text(preset->'configHash')) THEN RETURN false; END IF;
  IF jsonb_typeof(document->'candidates') IS DISTINCT FROM 'array' OR jsonb_array_length(document->'candidates') NOT BETWEEN 1 AND 32 THEN RETURN false; END IF;
  FOR candidate IN SELECT item FROM jsonb_array_elements(document->'candidates') item LOOP
    IF NOT jsonb_object_has_only_keys(candidate,ARRAY['modelId','providerPolicy','contextWindowTokens','maxOutputTokens'])
       OR NOT jsonb_object_has_keys(candidate,ARRAY['modelId','providerPolicy','contextWindowTokens','maxOutputTokens'])
       OR NOT valid_bounded_text(candidate->'modelId',1,500) OR NOT valid_provider_routing_policy(candidate->'providerPolicy')
       OR NOT valid_positive_integer(candidate->'contextWindowTokens') OR NOT valid_positive_integer(candidate->'maxOutputTokens') THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(document->'presetSystemPrompt')<>'string' OR char_length(document->>'presetSystemPrompt')>200000
     OR NOT valid_text_generation_parameters(document->'parameters') OR NOT valid_bounded_text(document->'endpointReference',1,500)
     OR (document->'credentialReference'<>'null'::jsonb AND NOT valid_bounded_text(document->'credentialReference',1,500))
     OR NOT valid_bounded_text(document->'profileRevision',1,500) OR NOT valid_bounded_text(document->'protocolVersion',1,500)
     OR (document ? 'authorityRevision' AND NOT valid_bounded_text(document->'authorityRevision',1,500))
     OR (document ? 'requestTimeoutMs' AND NOT valid_positive_integer(document->'requestTimeoutMs')) THEN RETURN false; END IF;
  IF plan THEN
    RETURN valid_bounded_text(document->'prompt',1,400000) AND valid_hash_text(document->'promptHash')
      AND document->>'promptHash'=encode(digest(convert_to(document->>'prompt','UTF8'),'sha256'),'hex')
      AND valid_hash_text(document->'planHash')
      AND document->>'planHash'=canonical_jsonb_sha256(document-'planHash')
      AND (NOT document ? 'routeBasisHash' OR valid_hash_text(document->'routeBasisHash'));
  END IF;
  RETURN valid_hash_text(document->'routeBasisHash')
    AND document->>'routeBasisHash'=canonical_jsonb_sha256(document-'routeBasisHash');
END;
$_$;

--
-- Name: valid_text_generation_parameters(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_text_generation_parameters(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE key text;
BEGIN
  IF NOT jsonb_object_has_only_keys(value,ARRAY['temperature','top_p','top_k','frequency_penalty','presence_penalty','repetition_penalty','min_p','top_a','seed','max_tokens','max_completion_tokens']) THEN RETURN false; END IF;
  IF value ? 'temperature' AND NOT valid_json_number(value->'temperature',0,2,false) THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['top_p','min_p','top_a'] LOOP
    IF value ? key AND NOT valid_json_number(value->key,0,1,false) THEN RETURN false; END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['frequency_penalty','presence_penalty'] LOOP
    IF value ? key AND NOT valid_json_number(value->key,-2,2,false) THEN RETURN false; END IF;
  END LOOP;
  IF value ? 'repetition_penalty' AND NOT valid_json_number(value->'repetition_penalty',0.0000000001,1e100,false) THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['top_k','seed'] LOOP
    IF value ? key AND NOT valid_json_number(value->key,0,1e100,true) THEN RETURN false; END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['max_tokens','max_completion_tokens'] LOOP
    IF value ? key AND NOT valid_json_number(value->key,1,1e100,true) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

--
-- Name: valid_uuid_text(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_uuid_text(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT COALESCE(jsonb_typeof(value) = 'string'
    AND value #>> '{}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
$_$;

--
-- Name: valid_v1_attempt_response_audit(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_v1_attempt_response_audit(value jsonb, invocation_key text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT jsonb_object_has_only_keys(value, ARRAY['version','selectionHash','invocationKey','mode','schemaVersion','schemaHash','requestedModel','providerRoutingSlugs','returnedModel','returnedProviderRoute','diagnosticCode'])
    AND jsonb_object_has_keys(value, ARRAY['version','selectionHash','invocationKey','mode','schemaVersion','schemaHash','requestedModel','providerRoutingSlugs','returnedModel','returnedProviderRoute','diagnosticCode'])
    AND value->>'version'='1' AND value->>'invocationKey'=invocation_key AND valid_v1_invocation_key(value->>'invocationKey')
    AND value->>'mode' IN ('json_object','json_schema') AND valid_hash_text(value->'selectionHash')
    AND valid_bounded_text(value->'requestedModel',1,512) AND valid_bounded_string_array(value->'providerRoutingSlugs',64,128)
    AND (value->'returnedModel'='null'::jsonb OR valid_bounded_text(value->'returnedModel',1,256))
    AND (value->'returnedProviderRoute'='null'::jsonb OR valid_bounded_text(value->'returnedProviderRoute',1,256))
    AND ((value->>'mode'='json_schema' AND valid_bounded_text(value->'schemaVersion',1,200) AND valid_hash_text(value->'schemaHash'))
      OR (value->>'mode'='json_object' AND value->'schemaVersion'='null'::jsonb AND value->'schemaHash'='null'::jsonb))
    AND (value->'diagnosticCode'='null'::jsonb OR value->>'diagnosticCode' IN ('provider_schema_unsupported','provider_schema_invalid','provider_route_unavailable','provider_refusal'))
$$;

--
-- Name: valid_v1_frozen_response_contracts(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_v1_frozen_response_contracts(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE key text; contract jsonb; queued_keys text[];
BEGIN
  IF NOT jsonb_object_has_only_keys(value, ARRAY['version','queuedPolicy','selectedAt','capabilityEvidenceHash','contracts','selectionHash'])
     OR NOT jsonb_object_has_keys(value, ARRAY['version','queuedPolicy','selectedAt','capabilityEvidenceHash','contracts','selectionHash'])
     OR value->>'version' <> '1' OR NOT valid_v1_queued_response_policy(value->'queuedPolicy')
     OR NOT valid_iso_datetime_text(value->'selectedAt') OR NOT valid_hash_text(value->'capabilityEvidenceHash')
     OR jsonb_typeof(value->'contracts') IS DISTINCT FROM 'object' OR NOT valid_hash_text(value->'selectionHash') THEN RETURN false; END IF;
  SELECT array_agg(item) INTO queued_keys FROM jsonb_array_elements_text(value->'queuedPolicy'->'invocationKeys') item;
  FOR key, contract IN SELECT * FROM jsonb_each(value->'contracts') LOOP
    IF NOT key = ANY(queued_keys) OR NOT valid_v1_prepared_response_contract(contract, key) THEN RETURN false; END IF;
  END LOOP;
  RETURN NOT EXISTS (SELECT 1 FROM unnest(queued_keys) queued WHERE NOT (value->'contracts') ? queued)
    AND value->>'selectionHash'=canonical_jsonb_sha256(value-'selectionHash');
END;
$$;

--
-- Name: valid_v1_invocation_key(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_v1_invocation_key(value text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT value IN ('story:stream','story:nonstream','choices:nonstream','continuity_review:nonstream')
$$;

--
-- Name: valid_v1_prepared_response_contract(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_v1_prepared_response_contract(value jsonb, invocation_key text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE expected_operation text := split_part(invocation_key, ':', 1); expected_streaming boolean := split_part(invocation_key, ':', 2) = 'stream';
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR value->>'version' <> '1'
     OR value->>'operation' NOT IN ('story','choices','continuity_review')
     OR (value->>'operation') IS DISTINCT FROM expected_operation
     OR jsonb_typeof(value->'streaming') IS DISTINCT FROM 'boolean'
     OR value->'streaming' IS DISTINCT FROM to_jsonb(expected_streaming)
     OR value->>'forbidFormatFallback' <> 'true' OR value->>'mode' NOT IN ('json_object','json_schema') THEN RETURN false; END IF;
  IF value->>'mode' = 'json_object' THEN
    RETURN jsonb_object_has_only_keys(value, ARRAY['version','operation','streaming','forbidFormatFallback','mode'])
      AND jsonb_object_has_keys(value, ARRAY['version','operation','streaming','forbidFormatFallback','mode']);
  END IF;
  RETURN jsonb_object_has_only_keys(value, ARRAY['version','operation','streaming','forbidFormatFallback','mode','schemaVersion','schemaHash','schemaName','schema','providerRoutingSlugs','routeConfigHash','adapterProtocol'])
    AND jsonb_object_has_keys(value, ARRAY['version','operation','streaming','forbidFormatFallback','mode','schemaVersion','schemaHash','schemaName','schema','providerRoutingSlugs','routeConfigHash','adapterProtocol'])
    AND valid_bounded_text(value->'schemaVersion',1,200) AND valid_hash_text(value->'schemaHash')
    AND value->>'schemaHash'=canonical_jsonb_sha256(value->'schema')
    AND valid_bounded_text(value->'schemaName',1,200) AND jsonb_typeof(value->'schema') = 'object'
    AND valid_bounded_string_array(value->'providerRoutingSlugs',64,128)
    AND valid_hash_text(value->'routeConfigHash') AND value->>'adapterProtocol' = 'text-schema-adapter-v1';
END;
$$;

--
-- Name: valid_v1_queued_response_policy(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_v1_queued_response_policy(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE key_value jsonb;
BEGIN
  IF NOT jsonb_object_has_only_keys(value, ARRAY['version','policy','providerProfileId','model','endpointIdentity','providerConfigurationHash','verificationRegistryHash','operationClosureVersion','invocationKeys'])
     OR NOT jsonb_object_has_keys(value, ARRAY['version','policy','providerProfileId','model','endpointIdentity','providerConfigurationHash','verificationRegistryHash','operationClosureVersion','invocationKeys'])
     OR value->>'version' <> '1' OR value->>'policy' NOT IN ('auto','required')
     OR NOT valid_uuid_text(value->'providerProfileId') OR NOT valid_bounded_text(value->'model',1,512)
     OR NOT valid_bounded_text(value->'endpointIdentity',1,512)
     OR NOT valid_hash_text(value->'providerConfigurationHash') OR NOT valid_hash_text(value->'verificationRegistryHash')
     OR value->>'operationClosureVersion' <> '1' OR jsonb_typeof(value->'invocationKeys') IS DISTINCT FROM 'array'
     OR jsonb_array_length(value->'invocationKeys') NOT BETWEEN 1 AND 4 THEN RETURN false; END IF;
  FOR key_value IN SELECT item FROM jsonb_array_elements(value->'invocationKeys') item LOOP
    IF jsonb_typeof(key_value) <> 'string' OR NOT valid_v1_invocation_key(key_value #>> '{}') THEN RETURN false; END IF;
  END LOOP;
  RETURN (SELECT count(*) = count(DISTINCT item) FROM jsonb_array_elements_text(value->'invocationKeys') item);
END;
$$;

--
-- Name: valid_v1_response_contract_invocation(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_v1_response_contract_invocation(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE status text;
BEGIN
  IF NOT jsonb_object_has_only_keys(value, ARRAY['version','id','logicalAttemptId','invocationKey','operation','requestPayloadHash','request','status','reservedAt','dispatchedAt','completedAt','response'])
     OR NOT jsonb_object_has_keys(value, ARRAY['version','id','logicalAttemptId','invocationKey','operation','requestPayloadHash','request','status','reservedAt','dispatchedAt','completedAt','response'])
     OR value->>'version'<>'1' OR NOT valid_hash_text(value->'id') OR NOT valid_uuid_text(value->'logicalAttemptId')
     OR NOT valid_v1_invocation_key(value->>'invocationKey')
     OR value->>'operation' NOT IN ('story_generation','story_recovery','story_choice_repair','event_extension','scene_coverage_rewrite','story_continuity_review','story_continuity_repair')
     OR NOT valid_hash_text(value->'requestPayloadHash')
     OR NOT valid_v1_attempt_response_audit(value->'request',value->>'invocationKey')
     OR NOT valid_iso_datetime_text(value->'reservedAt') THEN RETURN false; END IF;
  status := value->>'status';
  IF status='reserved' THEN RETURN value->'dispatchedAt'='null'::jsonb AND value->'completedAt'='null'::jsonb AND value->'response'='null'::jsonb; END IF;
  IF status='dispatched' THEN RETURN valid_iso_datetime_text(value->'dispatchedAt') AND value->'completedAt'='null'::jsonb AND value->'response'='null'::jsonb; END IF;
  IF status='completed' THEN RETURN valid_iso_datetime_text(value->'dispatchedAt') AND valid_iso_datetime_text(value->'completedAt')
    AND jsonb_typeof(value->'response')='object'
    AND jsonb_object_has_only_keys(value->'response',ARRAY['returnedModel','returnedProviderRoute','diagnosticCode','resultHash'])
    AND jsonb_object_has_keys(value->'response',ARRAY['returnedModel','returnedProviderRoute','diagnosticCode','resultHash'])
    AND (value->'response'->'returnedModel'='null'::jsonb OR valid_bounded_text(value->'response'->'returnedModel',1,256))
    AND (value->'response'->'returnedProviderRoute'='null'::jsonb OR valid_bounded_text(value->'response'->'returnedProviderRoute',1,256))
    AND (value->'response'->'diagnosticCode'='null'::jsonb OR value->'response'->>'diagnosticCode' IN ('provider_schema_unsupported','provider_schema_invalid','provider_route_unavailable','provider_refusal'))
    AND (value->'response'->'resultHash'='null'::jsonb OR valid_hash_text(value->'response'->'resultHash')); END IF;
  RETURN false;
END;
$$;

--
-- Name: validate_portable_export_artifact_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_portable_export_artifact_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.export_kind = 'campaign_zip' THEN
    PERFORM 1
      FROM campaigns campaigns
      JOIN world_versions versions
        ON versions.id = campaigns.world_version_id
       AND versions.owner_user_id = campaigns.owner_user_id
     WHERE campaigns.id = NEW.campaign_id
       AND campaigns.owner_user_id = NEW.owner_user_id
       AND campaigns.world_version_id = NEW.world_version_id
       AND versions.id = NEW.world_version_id
       AND versions.world_id = NEW.world_id
       AND versions.owner_user_id = NEW.owner_user_id
       FOR NO KEY UPDATE OF campaigns, versions;
  ELSIF NEW.export_kind = 'world_json' THEN
    PERFORM 1
      FROM world_versions
     WHERE id = NEW.world_version_id
       AND world_id = NEW.world_id
       AND owner_user_id = NEW.owner_user_id
       FOR NO KEY UPDATE;
  ELSE
    RETURN NEW;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'portable export campaign/world/version scope is invalid'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: validate_portable_import_operation_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_portable_import_operation_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.destination_kind = 'existing_world_version' THEN
    PERFORM 1
      FROM world_versions
     WHERE id = NEW.destination_world_version_id
       AND world_id = NEW.destination_world_id
       AND owner_user_id = NEW.owner_user_id
       FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'portable import destination world/version scope is invalid'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF NEW.import_id IS NOT NULL THEN
    PERFORM 1
      FROM imports
     WHERE id = NEW.import_id
       AND owner_user_id = NEW.owner_user_id
       FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'portable import result owner scope is invalid'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: activity_event_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_event_outbox (
    event_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    source text NOT NULL,
    source_id uuid NOT NULL,
    activity_revision bigint NOT NULL,
    ordinal integer DEFAULT 0 NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    snapshot jsonb NOT NULL,
    published_at timestamp with time zone,
    quarantine_code text,
    CONSTRAINT activity_event_outbox_activity_revision_check CHECK ((activity_revision >= 0)),
    CONSTRAINT activity_event_outbox_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT activity_event_outbox_quarantine_code_check CHECK ((quarantine_code = 'invalid_snapshot'::text)),
    CONSTRAINT activity_event_outbox_snapshot_check CHECK ((jsonb_typeof(snapshot) = 'object'::text)),
    CONSTRAINT activity_event_outbox_source_check CHECK ((source = ANY (ARRAY['generation'::text, 'image'::text, 'illustration_segment'::text])))
);

--
-- Name: activity_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_events (
    id bigint NOT NULL,
    owner_user_id uuid,
    campaign_id uuid,
    event_type text NOT NULL,
    correlation_id text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: activity_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.activity_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: activity_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.activity_events_id_seq OWNED BY public.activity_events.id;

--
-- Name: api_admission_buckets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_admission_buckets (
    owner_user_id uuid NOT NULL,
    operation text NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    window_expires_at timestamp with time zone NOT NULL,
    accepted_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    accounted_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT api_admission_buckets_accepted_count_check CHECK ((accepted_count >= 0)),
    CONSTRAINT api_admission_buckets_accounted_count_check CHECK ((accounted_count >= 0)),
    CONSTRAINT api_admission_buckets_check CHECK ((window_expires_at > window_started_at)),
    CONSTRAINT api_admission_buckets_operation_check CHECK (((char_length(operation) >= 1) AND (char_length(operation) <= 100)))
);

--
-- Name: api_admission_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_admission_events (
    id bigint NOT NULL,
    owner_user_id uuid NOT NULL,
    operation text NOT NULL,
    accepted_at timestamp with time zone NOT NULL,
    CONSTRAINT api_admission_events_operation_check CHECK (((char_length(operation) >= 1) AND (char_length(operation) <= 100)))
);

--
-- Name: api_admission_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.api_admission_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.api_admission_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: api_admission_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_admission_leases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    operation text NOT NULL,
    request_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    request_running boolean DEFAULT false NOT NULL,
    CONSTRAINT api_admission_leases_operation_check CHECK (((char_length(operation) >= 1) AND (char_length(operation) <= 100))),
    CONSTRAINT api_admission_leases_request_id_check CHECK (((char_length(request_id) >= 1) AND (char_length(request_id) <= 200)))
);

--
-- Name: api_admission_recoveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_admission_recoveries (
    id bigint NOT NULL,
    lease_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    operation text NOT NULL,
    request_id text NOT NULL,
    maintenance_reference text NOT NULL,
    actor_user_id uuid NOT NULL,
    recovered_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT api_admission_recoveries_maintenance_reference_check CHECK (((length(maintenance_reference) >= 3) AND (length(maintenance_reference) <= 200))),
    CONSTRAINT api_admission_recoveries_operation_check CHECK ((operation = ANY (ARRAY['provider'::text, 'import'::text]))),
    CONSTRAINT api_admission_recoveries_request_id_check CHECK (((length(request_id) >= 1) AND (length(request_id) <= 200)))
);

--
-- Name: api_admission_recoveries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.api_admission_recoveries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.api_admission_recoveries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: api_admission_windows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_admission_windows (
    owner_user_id uuid NOT NULL,
    operation text NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    window_expires_at timestamp with time zone NOT NULL,
    max_requests integer NOT NULL,
    CONSTRAINT api_admission_windows_check CHECK ((window_expires_at > window_started_at)),
    CONSTRAINT api_admission_windows_max_requests_check CHECK ((max_requests > 0)),
    CONSTRAINT api_admission_windows_operation_check CHECK (((char_length(operation) >= 1) AND (char_length(operation) <= 100)))
);

--
-- Name: archive_previews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.archive_previews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    archive_type text NOT NULL,
    token_hash text NOT NULL,
    content_fingerprint text NOT NULL,
    destination_hash text NOT NULL,
    application_version text NOT NULL,
    staged_archive_path text NOT NULL,
    source_name text DEFAULT ''::text NOT NULL,
    preview jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    storage_security_state text DEFAULT 'legacy_path_v1'::text NOT NULL,
    secure_staged_input_id uuid,
    legacy_drain_policy text DEFAULT 'live_path_cleanup_compatibility'::text NOT NULL,
    CONSTRAINT archive_previews_archive_type_check CHECK ((archive_type = ANY (ARRAY['campaign'::text, 'system'::text]))),
    CONSTRAINT archive_previews_content_fingerprint_check CHECK ((content_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT archive_previews_destination_hash_check CHECK ((destination_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT archive_previews_staged_archive_path_check CHECK (((staged_archive_path <> ''::text) AND (staged_archive_path !~ '(^/|^[A-Za-z]:|^\\\\|\\\\|(^|/)\.\.?(/|$))'::text))),
    CONSTRAINT archive_previews_status_check CHECK ((status = ANY (ARRAY['previewed'::text, 'superseded'::text, 'consumed'::text, 'expired'::text, 'failed'::text])))
);

--
-- Name: COLUMN archive_previews.storage_security_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.archive_previews.storage_security_state IS 'legacy_path_v1 rows are path-only compatibility records; identity_bound_v2 requires an explicit secure staged-input migration.';

--
-- Name: COLUMN archive_previews.legacy_drain_policy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.archive_previews.legacy_drain_policy IS 'Pre-migration path-only rows are retained because unlinking without persisted identity could delete a replacement.';

--
-- Name: asset_derivatives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_derivatives (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    source_asset_id uuid NOT NULL,
    derivative_kind text NOT NULL,
    transform_version integer DEFAULT 1 NOT NULL,
    pixel_width integer NOT NULL,
    pixel_height integer NOT NULL,
    storage_driver text NOT NULL,
    storage_path text NOT NULL,
    mime_type text NOT NULL,
    byte_length bigint NOT NULL,
    content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    filesystem_operation_id uuid,
    filesystem_operation_purpose text GENERATED ALWAYS AS ('asset_derivative'::text) STORED NOT NULL,
    CONSTRAINT asset_derivatives_byte_length_check CHECK ((byte_length >= 0)),
    CONSTRAINT asset_derivatives_derivative_kind_check CHECK ((derivative_kind = ANY (ARRAY['thumbnail'::text, 'responsive'::text]))),
    CONSTRAINT asset_derivatives_pixel_height_check CHECK ((pixel_height > 0)),
    CONSTRAINT asset_derivatives_pixel_width_check CHECK ((pixel_width > 0)),
    CONSTRAINT asset_derivatives_transform_version_check CHECK ((transform_version > 0))
);

--
-- Name: asset_generation_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_generation_contexts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    created_by_user_id uuid NOT NULL,
    image_job_id uuid,
    world_id uuid,
    world_version_id uuid,
    campaign_id uuid,
    turn_id uuid,
    target_type text DEFAULT 'other'::text NOT NULL,
    variant_index integer DEFAULT 0 NOT NULL,
    fiction_prompt text DEFAULT ''::text NOT NULL,
    negative_prompt text,
    entities jsonb DEFAULT '[]'::jsonb NOT NULL,
    characters jsonb DEFAULT '[]'::jsonb NOT NULL,
    locations jsonb DEFAULT '[]'::jsonb NOT NULL,
    factions jsonb DEFAULT '[]'::jsonb NOT NULL,
    scene_attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    provider_profile_id uuid,
    provider_type text,
    model text DEFAULT ''::text NOT NULL,
    generation_parameters jsonb DEFAULT '{}'::jsonb NOT NULL,
    parent_asset_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    metadata_schema_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_generation_contexts_fiction_prompt_check CHECK ((length(fiction_prompt) <= 20000)),
    CONSTRAINT asset_generation_contexts_metadata_schema_version_check CHECK ((metadata_schema_version > 0)),
    CONSTRAINT asset_generation_contexts_model_check CHECK ((length(model) <= 500)),
    CONSTRAINT asset_generation_contexts_negative_prompt_check CHECK (((negative_prompt IS NULL) OR (length(negative_prompt) <= 10000))),
    CONSTRAINT asset_generation_contexts_target_type_check CHECK ((target_type = ANY (ARRAY['world_cover'::text, 'turn_illustration'::text, 'streaming_illustration'::text, 'other'::text]))),
    CONSTRAINT asset_generation_contexts_variant_index_check CHECK ((variant_index >= 0))
);

--
-- Name: COLUMN asset_generation_contexts.fiction_prompt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.asset_generation_contexts.fiction_prompt IS 'Validated fiction-only prompt. Never contains mechanics, scratchpads, rejected output, or private reasoning.';

--
-- Name: asset_library_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_library_entries (
    asset_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    created_by_user_id uuid NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    caption text DEFAULT ''::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    origin text DEFAULT 'imported'::text NOT NULL,
    reuse_scope text DEFAULT 'private'::text NOT NULL,
    automatic_reuse_enabled boolean DEFAULT false NOT NULL,
    review_status text DEFAULT 'unreviewed'::text NOT NULL,
    content_categories text[] DEFAULT '{}'::text[] NOT NULL,
    favorite boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    metadata_revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_library_entries_caption_check CHECK ((length(caption) <= 2000)),
    CONSTRAINT asset_library_entries_metadata_revision_check CHECK ((metadata_revision > 0)),
    CONSTRAINT asset_library_entries_notes_check CHECK ((length(notes) <= 10000)),
    CONSTRAINT asset_library_entries_origin_check CHECK ((origin = ANY (ARRAY['generated'::text, 'imported'::text, 'uploaded'::text]))),
    CONSTRAINT asset_library_entries_reuse_scope_check CHECK ((reuse_scope = ANY (ARRAY['private'::text, 'campaign'::text, 'world'::text, 'owner_library'::text, 'shared'::text]))),
    CONSTRAINT asset_library_entries_review_status_check CHECK ((review_status = ANY (ARRAY['unreviewed'::text, 'eligible'::text, 'restricted'::text, 'blocked'::text]))),
    CONSTRAINT asset_library_entries_title_check CHECK ((length(title) <= 300))
);

--
-- Name: asset_metadata_backfill_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_metadata_backfill_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    diagnostic_code text,
    attempts integer DEFAULT 0 NOT NULL,
    work_version integer DEFAULT 1 NOT NULL,
    lease_id uuid,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT asset_metadata_backfill_completed_check CHECK ((((status = 'completed'::text) AND (completed_at IS NOT NULL)) OR ((status <> 'completed'::text) AND (completed_at IS NULL)))),
    CONSTRAINT asset_metadata_backfill_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT asset_metadata_backfill_jobs_diagnostic_code_check CHECK (((diagnostic_code IS NULL) OR (diagnostic_code = ANY (ARRAY['asset_content_invalid'::text, 'asset_hash_mismatch'::text, 'asset_metadata_unavailable'::text, 'asset_storage_unavailable'::text, 'asset_unsupported_media'::text, 'asset_too_large'::text, 'filesystem_containment_denied'::text, 'filesystem_link_denied'::text, 'filesystem_path_invalid'::text, 'filesystem_race_detected'::text])))),
    CONSTRAINT asset_metadata_backfill_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'recoverable'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT asset_metadata_backfill_jobs_work_version_check CHECK ((work_version > 0)),
    CONSTRAINT asset_metadata_backfill_lease_check CHECK ((((status = 'running'::text) AND (lease_id IS NOT NULL) AND (lease_owner IS NOT NULL) AND (btrim(lease_owner) <> ''::text) AND (lease_expires_at IS NOT NULL)) OR ((status <> 'running'::text) AND (lease_id IS NULL) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL))))
);

--
-- Name: asset_metadata_backfill_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_metadata_backfill_publications (
    owner_user_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    work_version integer NOT NULL,
    expected_content_hash text CONSTRAINT asset_metadata_backfill_publicat_expected_content_hash_not_null NOT NULL,
    thumbnail_content_hash text CONSTRAINT asset_metadata_backfill_publica_thumbnail_content_hash_not_null NOT NULL,
    filesystem_operation_id uuid CONSTRAINT asset_metadata_backfill_public_filesystem_operation_id_not_null NOT NULL,
    lifecycle text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT asset_metadata_backfill_publicatio_thumbnail_content_hash_check CHECK ((thumbnail_content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT asset_metadata_backfill_publication_expected_content_hash_check CHECK ((expected_content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT asset_metadata_backfill_publication_published_check CHECK ((((lifecycle = 'published'::text) AND (published_at IS NOT NULL)) OR ((lifecycle = 'attached'::text) AND (published_at IS NULL)))),
    CONSTRAINT asset_metadata_backfill_publications_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['attached'::text, 'published'::text]))),
    CONSTRAINT asset_metadata_backfill_publications_work_version_check CHECK ((work_version > 0))
);

--
-- Name: asset_mutation_idempotency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_mutation_idempotency (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    mutation_kind text NOT NULL,
    idempotency_key_hash text NOT NULL,
    request_fingerprint text NOT NULL,
    target_asset_id uuid,
    campaign_id uuid,
    turn_id uuid,
    world_id uuid,
    selected_asset_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT asset_mutation_completion_check CHECK ((((status = 'pending'::text) AND (completed_at IS NULL)) OR ((status = ANY (ARRAY['completed'::text, 'failed'::text])) AND (completed_at IS NOT NULL)))),
    CONSTRAINT asset_mutation_idempotency_idempotency_key_hash_check CHECK ((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT asset_mutation_idempotency_mutation_kind_check CHECK ((mutation_kind = ANY (ARRAY['asset_metadata_update'::text, 'turn_asset_selection'::text, 'world_asset_selection'::text]))),
    CONSTRAINT asset_mutation_idempotency_request_fingerprint_check CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT asset_mutation_idempotency_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT asset_mutation_scope_check CHECK ((((mutation_kind = 'asset_metadata_update'::text) AND (target_asset_id IS NOT NULL) AND (campaign_id IS NULL) AND (turn_id IS NULL) AND (world_id IS NULL) AND (selected_asset_id IS NULL)) OR ((mutation_kind = 'turn_asset_selection'::text) AND (target_asset_id IS NULL) AND (campaign_id IS NOT NULL) AND (turn_id IS NOT NULL) AND (world_id IS NULL)) OR ((mutation_kind = 'world_asset_selection'::text) AND (target_asset_id IS NULL) AND (campaign_id IS NULL) AND (turn_id IS NULL) AND (world_id IS NOT NULL))))
);

--
-- Name: asset_publication_content_arbitrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_publication_content_arbitrations (
    owner_user_id uuid NOT NULL,
    content_hash text NOT NULL,
    canonical_asset_id uuid CONSTRAINT asset_publication_content_arbitrati_canonical_asset_id_not_null NOT NULL,
    verification_state text CONSTRAINT asset_publication_content_arbitrati_verification_state_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT asset_publication_content_arbitrations_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT asset_publication_content_arbitrations_verification_state_check CHECK ((verification_state = ANY (ARRAY['verified'::text, 'verification_required'::text])))
);

--
-- Name: asset_publication_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_publication_identities (
    asset_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    idempotency_key_hash text,
    request_fingerprint text,
    lifecycle text DEFAULT 'prepared'::text NOT NULL,
    result jsonb,
    pending_finalization jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT asset_publication_identities_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['legacy'::text, 'prepared'::text, 'attached'::text, 'published'::text, 'cleanup_pending'::text]))),
    CONSTRAINT asset_publication_identity_hashes_check CHECK ((((lifecycle = 'legacy'::text) AND (idempotency_key_hash IS NULL) AND (request_fingerprint IS NULL) AND (result IS NULL) AND (pending_finalization IS NULL) AND (published_at IS NULL)) OR ((lifecycle = ANY (ARRAY['prepared'::text, 'cleanup_pending'::text])) AND (idempotency_key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_fingerprint ~ '^[0-9a-f]{64}$'::text) AND (result IS NULL) AND (pending_finalization IS NULL) AND (published_at IS NULL)) OR ((lifecycle = 'attached'::text) AND (idempotency_key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_fingerprint ~ '^[0-9a-f]{64}$'::text) AND (result IS NOT NULL) AND (pending_finalization IS NOT NULL) AND (published_at IS NULL)) OR ((lifecycle = 'published'::text) AND (idempotency_key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_fingerprint ~ '^[0-9a-f]{64}$'::text) AND (result IS NOT NULL) AND (pending_finalization IS NULL) AND (published_at IS NOT NULL))))
);

--
-- Name: asset_publication_library_initializations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_publication_library_initializations (
    request_id uuid NOT NULL,
    owner_user_id uuid CONSTRAINT asset_publication_library_initialization_owner_user_id_not_null NOT NULL,
    canonical_asset_id uuid CONSTRAINT asset_publication_library_initializ_canonical_asset_id_not_null NOT NULL,
    library_snapshot jsonb CONSTRAINT asset_publication_library_initializat_library_snapshot_not_null NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    applied_at timestamp with time zone,
    CONSTRAINT asset_publication_library_initializations_check CHECK ((((state = 'pending'::text) AND (applied_at IS NULL)) OR ((state = 'applied'::text) AND (applied_at IS NOT NULL)))),
    CONSTRAINT asset_publication_library_initializations_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'applied'::text])))
);

--
-- Name: asset_publication_request_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_publication_request_contexts (
    request_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    intent_key text NOT NULL,
    context_snapshot jsonb NOT NULL,
    context_id uuid,
    CONSTRAINT asset_publication_request_contexts_intent_key_check CHECK (((length(intent_key) >= 1) AND (length(intent_key) <= 500)))
);

--
-- Name: asset_publication_request_derivatives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_publication_request_derivatives (
    request_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    ordinal integer NOT NULL,
    slot_snapshot jsonb NOT NULL,
    content_hash text NOT NULL,
    technical_metadata jsonb CONSTRAINT asset_publication_request_derivativ_technical_metadata_not_null NOT NULL,
    derivative_id uuid,
    CONSTRAINT asset_publication_request_derivatives_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT asset_publication_request_derivatives_ordinal_check CHECK (((ordinal >= 0) AND (ordinal < 100)))
);

--
-- Name: asset_publication_request_references; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_publication_request_references (
    request_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    intent_key text NOT NULL,
    reference_snapshot jsonb CONSTRAINT asset_publication_request_reference_reference_snapshot_not_null NOT NULL,
    reference_id uuid,
    CONSTRAINT asset_publication_request_references_intent_key_check CHECK (((length(intent_key) >= 1) AND (length(intent_key) <= 500)))
);

--
-- Name: asset_publication_request_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_publication_request_results (
    request_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

--
-- Name: asset_publication_request_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_publication_request_sources (
    request_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    ordinal integer NOT NULL,
    source_kind text NOT NULL,
    source_asset_id text NOT NULL,
    source_record_id text,
    source_key text,
    requested_library_snapshot jsonb CONSTRAINT asset_publication_request_s_requested_library_snapshot_not_null NOT NULL,
    binding_intent_keys jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT asset_publication_request_sources_binding_intent_keys_check CHECK ((jsonb_typeof(binding_intent_keys) = 'array'::text)),
    CONSTRAINT asset_publication_request_sources_ordinal_check CHECK (((ordinal >= 0) AND (ordinal < 1000))),
    CONSTRAINT asset_publication_request_sources_source_asset_id_check CHECK (((length(source_asset_id) >= 1) AND (length(source_asset_id) <= 500))),
    CONSTRAINT asset_publication_request_sources_source_key_check CHECK (((source_key IS NULL) OR ((length(source_key) >= 1) AND (length(source_key) <= 1000)))),
    CONSTRAINT asset_publication_request_sources_source_kind_check CHECK ((source_kind = ANY (ARRAY['campaign_zip'::text, 'legacy_story'::text]))),
    CONSTRAINT asset_publication_request_sources_source_record_id_check CHECK (((source_record_id IS NULL) OR ((length(source_record_id) >= 1) AND (length(source_record_id) <= 500))))
);

--
-- Name: asset_publication_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_publication_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    idempotency_key_hash text NOT NULL,
    request_fingerprint text NOT NULL,
    canonical_content_hash text,
    canonical_asset_id uuid,
    lifecycle text DEFAULT 'prepared'::text NOT NULL,
    requested_library_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    provenance_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT asset_publication_request_result_lifecycle_check CHECK ((((lifecycle = ANY (ARRAY['prepared'::text, 'cleanup_pending'::text, 'failed'::text])) AND (result IS NULL) AND (published_at IS NULL)) OR ((lifecycle = 'attached'::text) AND (result IS NOT NULL) AND (published_at IS NULL)) OR ((lifecycle = 'published'::text) AND (result IS NOT NULL) AND (published_at IS NOT NULL)))),
    CONSTRAINT asset_publication_requests_canonical_content_hash_check CHECK (((canonical_content_hash IS NULL) OR (canonical_content_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT asset_publication_requests_idempotency_key_hash_check CHECK ((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT asset_publication_requests_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['prepared'::text, 'attached'::text, 'published'::text, 'cleanup_pending'::text, 'failed'::text]))),
    CONSTRAINT asset_publication_requests_request_fingerprint_check CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text))
);

--
-- Name: asset_references; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_references (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    turn_id uuid,
    asset_role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_references_asset_role_check CHECK ((asset_role = ANY (ARRAY['turn_illustration'::text, 'world_asset'::text, 'import_attachment'::text])))
);

--
-- Name: assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid,
    turn_id uuid,
    content_hash text NOT NULL,
    storage_driver text NOT NULL,
    storage_path text NOT NULL,
    mime_type text NOT NULL,
    byte_length bigint NOT NULL,
    source_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pixel_width integer,
    pixel_height integer,
    technical_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    filesystem_operation_id uuid,
    filesystem_operation_purpose text GENERATED ALWAYS AS ('asset_original'::text) STORED NOT NULL,
    CONSTRAINT assets_byte_length_check CHECK ((byte_length >= 0)),
    CONSTRAINT assets_pixel_height_check CHECK ((pixel_height > 0)),
    CONSTRAINT assets_pixel_width_check CHECK ((pixel_width > 0))
);

--
-- Name: authoring_job_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authoring_job_stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    stage_key text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    parent_generations jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    lease_token uuid,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    output jsonb,
    failure jsonb,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    source_review_generation integer,
    CONSTRAINT authoring_job_stages_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT authoring_job_stages_failure_check CHECK (((failure IS NULL) OR (jsonb_typeof(failure) = 'object'::text))),
    CONSTRAINT authoring_job_stages_generation_check CHECK ((generation >= 1)),
    CONSTRAINT authoring_job_stages_lease_check CHECK ((((status = 'running'::text) AND (lease_token IS NOT NULL) AND (lease_owner IS NOT NULL) AND (btrim(lease_owner) <> ''::text) AND (lease_expires_at IS NOT NULL)) OR ((status <> 'running'::text) AND (lease_token IS NULL) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT authoring_job_stages_output_check CHECK (((output IS NULL) OR (jsonb_typeof(output) = 'object'::text))),
    CONSTRAINT authoring_job_stages_parent_generations_check CHECK ((jsonb_typeof(parent_generations) = 'object'::text)),
    CONSTRAINT authoring_job_stages_retry_count_check CHECK ((retry_count >= 0)),
    CONSTRAINT authoring_job_stages_source_review_generation_check CHECK (((source_review_generation IS NULL) OR (source_review_generation >= 0))),
    CONSTRAINT authoring_job_stages_stage_key_check CHECK ((btrim(stage_key) <> ''::text)),
    CONSTRAINT authoring_job_stages_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'validated'::text, 'recoverable'::text, 'failed'::text, 'cancelled'::text])))
);

--
-- Name: authoring_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authoring_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    kind text NOT NULL,
    target jsonb NOT NULL,
    input jsonb NOT NULL,
    request_hash text NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    execution_generation integer DEFAULT 0 NOT NULL,
    execution_snapshot jsonb,
    reviewed_content jsonb,
    review_generation integer DEFAULT 0 NOT NULL,
    apply_key text,
    apply_hash text,
    apply_receipt jsonb,
    last_activity_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '7 days'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    reviewed_stage_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_plan jsonb,
    source_review jsonb,
    text_plan_protocol smallint,
    CONSTRAINT authoring_jobs_apply_hash_check CHECK (((apply_hash IS NULL) OR (apply_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT authoring_jobs_apply_receipt_check CHECK (((apply_receipt IS NULL) OR (jsonb_typeof(apply_receipt) = 'object'::text))),
    CONSTRAINT authoring_jobs_execution_generation_check CHECK ((execution_generation >= 0)),
    CONSTRAINT authoring_jobs_execution_snapshot_check CHECK (((execution_snapshot IS NULL) OR (jsonb_typeof(execution_snapshot) = 'object'::text))),
    CONSTRAINT authoring_jobs_idempotency_key_check CHECK ((btrim(idempotency_key) <> ''::text)),
    CONSTRAINT authoring_jobs_input_check CHECK ((jsonb_typeof(input) = 'object'::text)),
    CONSTRAINT authoring_jobs_kind_check CHECK ((kind = ANY (ARRAY['world_concept'::text, 'character'::text, 'story_source'::text]))),
    CONSTRAINT authoring_jobs_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT authoring_jobs_review_generation_check CHECK ((review_generation >= 0)),
    CONSTRAINT authoring_jobs_reviewed_content_check CHECK (((reviewed_content IS NULL) OR (jsonb_typeof(reviewed_content) = 'object'::text))),
    CONSTRAINT authoring_jobs_reviewed_stage_ids_check CHECK ((jsonb_typeof(reviewed_stage_ids) = 'array'::text)),
    CONSTRAINT authoring_jobs_revision_check CHECK ((revision >= 0)),
    CONSTRAINT authoring_jobs_source_plan_check CHECK (((source_plan IS NULL) OR (jsonb_typeof(source_plan) = 'object'::text))),
    CONSTRAINT authoring_jobs_source_review_check CHECK (((source_review IS NULL) OR (jsonb_typeof(source_review) = 'object'::text))),
    CONSTRAINT authoring_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'awaiting_review'::text, 'recoverable'::text, 'failed'::text, 'cancel_requested'::text, 'cancelled'::text, 'applied'::text, 'expired'::text]))),
    CONSTRAINT authoring_jobs_target_check CHECK ((jsonb_typeof(target) = 'object'::text)),
    CONSTRAINT authoring_jobs_text_plan_protocol_check CHECK (((text_plan_protocol IS NULL) OR (text_plan_protocol = 2)))
);

--
-- Name: campaign_activity_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_activity_history (
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    captured_since timestamp with time zone NOT NULL,
    retention_floor_sequence bigint DEFAULT 0 NOT NULL,
    last_published_sequence bigint DEFAULT 0 NOT NULL,
    CONSTRAINT campaign_activity_history_check CHECK ((last_published_sequence >= retention_floor_sequence)),
    CONSTRAINT campaign_activity_history_retention_floor_sequence_check CHECK ((retention_floor_sequence >= 0))
);

--
-- Name: campaign_canonical_facts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_canonical_facts (
    id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    world_version_id uuid NOT NULL,
    source_turn_id uuid,
    source_turn_number integer NOT NULL,
    source_fact_index integer NOT NULL,
    content text NOT NULL,
    normalized_content text NOT NULL,
    entities text[] DEFAULT ARRAY[]::text[] NOT NULL,
    valid_from_turn integer NOT NULL,
    valid_until_turn integer,
    superseded_by_fact_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    entity_ids text[] DEFAULT ARRAY[]::text[] NOT NULL,
    source_state_edit_id uuid,
    CONSTRAINT campaign_canonical_facts_check CHECK (((valid_until_turn IS NULL) OR (valid_until_turn > valid_from_turn))),
    CONSTRAINT campaign_canonical_facts_content_check CHECK ((content <> ''::text)),
    CONSTRAINT campaign_canonical_facts_exactly_one_source CHECK ((num_nonnulls(source_turn_id, source_state_edit_id) = 1)),
    CONSTRAINT campaign_canonical_facts_normalized_content_check CHECK ((normalized_content <> ''::text)),
    CONSTRAINT campaign_canonical_facts_source_fact_index_check CHECK ((source_fact_index >= 0)),
    CONSTRAINT campaign_canonical_facts_source_turn_number_check CHECK (((source_turn_number > 0) OR ((source_turn_number = 0) AND (source_state_edit_id IS NOT NULL)))),
    CONSTRAINT campaign_canonical_facts_valid_from_turn_check CHECK (((valid_from_turn > 0) OR ((valid_from_turn = 0) AND (source_state_edit_id IS NOT NULL))))
);

--
-- Name: TABLE campaign_canonical_facts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.campaign_canonical_facts IS 'Rebuildable, turn-valid canonical fact projection. Accepted turn snapshots remain authoritative.';

--
-- Name: COLUMN campaign_canonical_facts.source_turn_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.campaign_canonical_facts.source_turn_number IS 'Accepted-turn facts begin after turn zero. Manual state-correction facts may begin at editable turn zero.';

--
-- Name: COLUMN campaign_canonical_facts.valid_from_turn; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.campaign_canonical_facts.valid_from_turn IS 'Inclusive active-turn boundary. Turn zero is valid only for a manual state-correction fact.';

--
-- Name: COLUMN campaign_canonical_facts.valid_until_turn; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.campaign_canonical_facts.valid_until_turn IS 'Exclusive turn boundary at which this fact was superseded; NULL means currently active.';

--
-- Name: COLUMN campaign_canonical_facts.entity_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.campaign_canonical_facts.entity_ids IS 'Derived stable entity references resolved only from the campaign pinned world version and character snapshot.';

--
-- Name: COLUMN campaign_canonical_facts.source_state_edit_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.campaign_canonical_facts.source_state_edit_id IS 'Append-only manual state edit that projected this canonical fact; exactly one source is required.';

--
-- Name: campaign_cast_characters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_cast_characters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    origin jsonb NOT NULL,
    world_version_id uuid GENERATED ALWAYS AS (((origin ->> 'worldVersionId'::text))::uuid) STORED,
    world_entity_id text GENERATED ALWAYS AS ((origin ->> 'entityId'::text)) STORED,
    first_observed_turn integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT campaign_cast_characters_check CHECK ((((origin ->> 'kind'::text) = 'world'::text) = ((world_version_id IS NOT NULL) AND (world_entity_id IS NOT NULL)))),
    CONSTRAINT campaign_cast_characters_first_observed_turn_check CHECK ((first_observed_turn >= 0)),
    CONSTRAINT campaign_cast_characters_origin_check CHECK (((origin ->> 'kind'::text) = ANY (ARRAY['manual'::text, 'discovered'::text, 'world'::text, 'historical_world'::text, 'protagonist'::text])))
);

--
-- Name: campaign_cast_discovery_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_cast_discovery_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    job_id uuid,
    chunk_ordinal integer NOT NULL,
    local_key text NOT NULL,
    source jsonb NOT NULL,
    proposal jsonb NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    resolution_receipt jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    detail_decisions jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT campaign_cast_discovery_candidates_chunk_ordinal_check CHECK ((chunk_ordinal >= 0)),
    CONSTRAINT campaign_cast_discovery_candidates_local_key_check CHECK (((length(local_key) >= 1) AND (length(local_key) <= 100))),
    CONSTRAINT campaign_cast_discovery_candidates_reason_check CHECK (((length(reason) >= 1) AND (length(reason) <= 100))),
    CONSTRAINT campaign_cast_discovery_candidates_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'resolved'::text, 'cancelled'::text]))),
    CONSTRAINT cast_detail_decisions_array CHECK ((jsonb_typeof(detail_decisions) = 'array'::text))
);

--
-- Name: campaign_cast_discovery_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_cast_discovery_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    turn_number integer NOT NULL,
    narration_revision integer NOT NULL,
    timeline_revision integer NOT NULL,
    source_hash text NOT NULL,
    protocol text NOT NULL,
    source jsonb NOT NULL,
    chunks jsonb NOT NULL,
    execution_snapshot jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    chunk_ordinal integer DEFAULT 0 NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    checkpoint jsonb,
    lease_token uuid,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    available_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    diagnostic_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    identity_snapshot jsonb,
    retry_generation integer DEFAULT 0 NOT NULL,
    scan_id uuid,
    CONSTRAINT campaign_cast_discovery_jobs_attempt_check CHECK (((attempt >= 0) AND (attempt <= 2))),
    CONSTRAINT campaign_cast_discovery_jobs_check CHECK (((status = 'running'::text) = ((lease_token IS NOT NULL) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT campaign_cast_discovery_jobs_chunk_ordinal_check CHECK ((chunk_ordinal >= 0)),
    CONSTRAINT campaign_cast_discovery_jobs_chunks_check CHECK (((jsonb_typeof(chunks) = 'array'::text) AND (jsonb_array_length(chunks) <= 32))),
    CONSTRAINT campaign_cast_discovery_jobs_narration_revision_check CHECK ((narration_revision >= 0)),
    CONSTRAINT campaign_cast_discovery_jobs_protocol_check CHECK ((protocol = 'cast-discovery-v1'::text)),
    CONSTRAINT campaign_cast_discovery_jobs_retry_generation_check CHECK ((retry_generation >= 0)),
    CONSTRAINT campaign_cast_discovery_jobs_source_hash_check CHECK ((source_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT campaign_cast_discovery_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'retry_wait'::text, 'complete'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT campaign_cast_discovery_jobs_timeline_revision_check CHECK ((timeline_revision >= 0)),
    CONSTRAINT campaign_cast_discovery_jobs_turn_number_check CHECK ((turn_number > 0))
);

--
-- Name: campaign_cast_discovery_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_cast_discovery_receipts (
    job_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    chunk_ordinal integer NOT NULL,
    output_hash text NOT NULL,
    character_ids uuid[] NOT NULL,
    observation_ids uuid[] NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    validation_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT campaign_cast_discovery_receipts_chunk_ordinal_check CHECK ((chunk_ordinal >= 0)),
    CONSTRAINT campaign_cast_discovery_receipts_output_hash_check CHECK ((output_hash ~ '^[a-f0-9]{64}$'::text))
);

--
-- Name: campaign_cast_discovery_retries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_cast_discovery_retries (
    job_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    retry_generation integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT campaign_cast_discovery_retries_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT campaign_cast_discovery_retries_retry_generation_check CHECK ((retry_generation > 0))
);

--
-- Name: campaign_cast_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_cast_events (
    id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    sequence bigint NOT NULL,
    effective_turn_number integer NOT NULL,
    timeline_revision integer NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    payload jsonb NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    attachment jsonb,
    CONSTRAINT campaign_cast_events_effective_turn_number_check CHECK ((effective_turn_number >= 0)),
    CONSTRAINT campaign_cast_events_idempotency_key_check CHECK (((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 200))),
    CONSTRAINT campaign_cast_events_payload_check CHECK ((jsonb_typeof(payload) = 'array'::text)),
    CONSTRAINT campaign_cast_events_receipt_check CHECK ((jsonb_typeof(receipt) = 'object'::text)),
    CONSTRAINT campaign_cast_events_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT campaign_cast_events_timeline_revision_check CHECK ((timeline_revision >= 0))
);

--
-- Name: TABLE campaign_cast_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.campaign_cast_events IS 'Append-only cast event batches. Internal foundation only; public editing is not enabled.';

--
-- Name: campaign_cast_events_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.campaign_cast_events ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.campaign_cast_events_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: campaign_cast_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_cast_observations (
    id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    character_id uuid NOT NULL,
    event_id uuid NOT NULL,
    sequence bigint NOT NULL,
    field text NOT NULL,
    value text NOT NULL,
    mode text NOT NULL,
    speaker_character_id uuid,
    evidence jsonb NOT NULL,
    source_turn_id uuid GENERATED ALWAYS AS (((evidence ->> 'turnId'::text))::uuid) STORED,
    narration_revision integer GENERATED ALWAYS AS (((evidence ->> 'narrationRevision'::text))::integer) STORED,
    source_hash text GENERATED ALWAYS AS ((evidence ->> 'sourceHash'::text)) STORED,
    world_version_id uuid GENERATED ALWAYS AS (((evidence ->> 'worldVersionId'::text))::uuid) STORED,
    supersedes_observation_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT campaign_cast_observations_check CHECK (((supersedes_observation_id IS NULL) OR ((mode = 'fact'::text) AND (supersedes_observation_id <> id)))),
    CONSTRAINT campaign_cast_observations_check1 CHECK (((((evidence ->> 'kind'::text) = 'turn'::text) AND (source_turn_id IS NOT NULL) AND (narration_revision >= 0) AND (source_hash ~ '^[a-f0-9]{64}$'::text)) OR (((evidence ->> 'kind'::text) = 'world'::text) AND (world_version_id IS NOT NULL)) OR (((evidence ->> 'kind'::text) = 'historical_world'::text) AND ((evidence ->> 'sourceWorldVersionId'::text) IS NOT NULL) AND (world_version_id IS NULL)))),
    CONSTRAINT campaign_cast_observations_evidence_check CHECK (((evidence ->> 'kind'::text) = ANY (ARRAY['turn'::text, 'world'::text, 'historical_world'::text]))),
    CONSTRAINT campaign_cast_observations_field_check CHECK ((field = ANY (ARRAY['identity.pronouns'::text, 'story.role'::text, 'story.background'::text, 'story.personality'::text, 'story.motivations'::text, 'story.goals'::text, 'story.voiceAndMannerisms'::text, 'appearance.description'::text, 'state.location'::text, 'state.condition'::text, 'state.clothing'::text]))),
    CONSTRAINT campaign_cast_observations_mode_check CHECK ((mode = ANY (ARRAY['fact'::text, 'claim'::text]))),
    CONSTRAINT campaign_cast_observations_value_check CHECK (((length(value) >= 1) AND (length(value) <= 2000)))
);

--
-- Name: campaign_cast_observations_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.campaign_cast_observations ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.campaign_cast_observations_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: campaign_cast_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_cast_profiles (
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    character_id uuid NOT NULL,
    revision integer NOT NULL,
    profile jsonb NOT NULL,
    CONSTRAINT campaign_cast_profiles_profile_check CHECK ((jsonb_typeof(profile) = 'object'::text)),
    CONSTRAINT campaign_cast_profiles_revision_check CHECK ((revision >= 0))
);

--
-- Name: TABLE campaign_cast_profiles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.campaign_cast_profiles IS 'Rebuildable supporting-character cache; protagonist profile remains on campaigns.';

--
-- Name: campaign_cast_promotion_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_cast_promotion_receipts (
    owner_user_id uuid NOT NULL,
    world_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: campaign_cast_scan_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_cast_scan_sources (
    scan_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    turn_number integer NOT NULL,
    source jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT campaign_cast_scan_sources_source_check CHECK ((jsonb_typeof(source) = 'object'::text)),
    CONSTRAINT campaign_cast_scan_sources_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'complete'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT campaign_cast_scan_sources_turn_number_check CHECK ((turn_number > 0))
);

--
-- Name: campaign_cast_scans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_cast_scans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    from_turn integer NOT NULL,
    through_turn integer NOT NULL,
    boundary jsonb NOT NULL,
    execution_snapshot jsonb NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT campaign_cast_scans_boundary_check CHECK ((jsonb_typeof(boundary) = 'object'::text)),
    CONSTRAINT campaign_cast_scans_check CHECK ((through_turn >= from_turn)),
    CONSTRAINT campaign_cast_scans_execution_snapshot_check CHECK ((jsonb_typeof(execution_snapshot) = 'object'::text)),
    CONSTRAINT campaign_cast_scans_from_turn_check CHECK ((from_turn > 0)),
    CONSTRAINT campaign_cast_scans_idempotency_key_check CHECK (((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 200))),
    CONSTRAINT campaign_cast_scans_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT campaign_cast_scans_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'paused'::text, 'complete'::text, 'failed'::text, 'cancelled'::text])))
);

--
-- Name: campaign_cast_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_cast_state (
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    timeline_revision integer DEFAULT 0 NOT NULL,
    last_boundary_change_key text,
    coverage_start_turn integer,
    workspace_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT campaign_cast_state_coverage_start_turn_check CHECK ((coverage_start_turn > 0)),
    CONSTRAINT campaign_cast_state_revision_check CHECK ((revision >= 0)),
    CONSTRAINT campaign_cast_state_timeline_revision_check CHECK ((timeline_revision >= 0))
);

--
-- Name: campaign_character_profile_edits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_character_profile_edits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    revision integer NOT NULL,
    previous_profile jsonb,
    next_profile jsonb NOT NULL,
    edit_source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaign_character_profile_edits_edit_source_check CHECK ((edit_source = ANY (ARRAY['world_version_seed'::text, 'manual'::text, 'ai_organized'::text, 'imported'::text, 'branch'::text, 'transfer'::text]))),
    CONSTRAINT campaign_character_profile_edits_next_profile_check CHECK ((jsonb_typeof(next_profile) = 'object'::text)),
    CONSTRAINT campaign_character_profile_edits_revision_check CHECK ((revision > 0))
);

--
-- Name: campaign_illustration_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_illustration_configs (
    campaign_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    provider_profile_id uuid,
    model text DEFAULT ''::text NOT NULL,
    size text DEFAULT '1024x1024'::text NOT NULL,
    aspect_ratio text DEFAULT '1:1'::text NOT NULL,
    quality text DEFAULT 'auto'::text NOT NULL,
    output_format text DEFAULT 'png'::text NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_policy text DEFAULT 'off'::text NOT NULL,
    matching_scope text DEFAULT 'world'::text NOT NULL,
    confidence_profile text DEFAULT 'balanced'::text NOT NULL,
    repetition_window integer DEFAULT 5 NOT NULL,
    segment_word_count integer DEFAULT 500 NOT NULL,
    images_per_segment integer DEFAULT 1 NOT NULL,
    segment_prompt_mode text DEFAULT 'direct'::text NOT NULL,
    refinement_prompt text DEFAULT ''::text CONSTRAINT campaign_illustration_configs_refinement_instructions_not_null NOT NULL,
    art_style text DEFAULT ''::text NOT NULL,
    negative_prompt text DEFAULT 'text, captions, lettering, watermark, signature, logo, user interface, speech bubbles, border'::text NOT NULL,
    CONSTRAINT campaign_illustration_configs_art_style_check CHECK ((char_length(art_style) <= 500)),
    CONSTRAINT campaign_illustration_configs_confidence_profile_check CHECK ((confidence_profile = ANY (ARRAY['strict'::text, 'balanced'::text, 'broad'::text]))),
    CONSTRAINT campaign_illustration_configs_images_per_segment_check CHECK (((images_per_segment >= 1) AND (images_per_segment <= 2))),
    CONSTRAINT campaign_illustration_configs_matching_scope_check CHECK ((matching_scope = ANY (ARRAY['campaign'::text, 'world'::text, 'owner_library'::text, 'shared'::text]))),
    CONSTRAINT campaign_illustration_configs_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 10))),
    CONSTRAINT campaign_illustration_configs_negative_prompt_check CHECK ((char_length(negative_prompt) <= 500)),
    CONSTRAINT campaign_illustration_configs_output_format_check CHECK ((output_format = ANY (ARRAY['png'::text, 'jpeg'::text, 'webp'::text]))),
    CONSTRAINT campaign_illustration_configs_quality_check CHECK ((quality = ANY (ARRAY['auto'::text, 'low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT campaign_illustration_configs_refinement_instructions_check CHECK ((char_length(refinement_prompt) <= 4000)),
    CONSTRAINT campaign_illustration_configs_repetition_window_check CHECK (((repetition_window >= 0) AND (repetition_window <= 100))),
    CONSTRAINT campaign_illustration_configs_segment_prompt_mode_check CHECK ((segment_prompt_mode = ANY (ARRAY['direct'::text, 'ai_refined'::text]))),
    CONSTRAINT campaign_illustration_configs_segment_word_count_check CHECK (((segment_word_count >= 100) AND (segment_word_count <= 5000))),
    CONSTRAINT campaign_illustration_configs_source_policy_check CHECK ((source_policy = ANY (ARRAY['off'::text, 'library_only'::text, 'library_then_generate'::text, 'generate_only'::text]))),
    CONSTRAINT campaign_illustration_source_enabled_check CHECK ((enabled = (source_policy <> 'off'::text)))
);

--
-- Name: campaign_memory_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_memory_configs (
    campaign_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    embedding_enabled boolean DEFAULT false NOT NULL,
    embedding_provider_profile_id uuid,
    embedding_model text DEFAULT 'text-embedding-nomic-embed-text-v1.5'::text NOT NULL,
    embedding_batch_size integer DEFAULT 16 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding_document_prefix text,
    embedding_query_prefix text,
    retrieval_implementation text DEFAULT 'legacy_hybrid'::text NOT NULL,
    retrieval_shadow_enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT campaign_memory_configs_check CHECK (((NOT embedding_enabled) OR ((embedding_provider_profile_id IS NOT NULL) AND (embedding_model <> ''::text)))),
    CONSTRAINT campaign_memory_configs_embedding_batch_size_check CHECK (((embedding_batch_size >= 1) AND (embedding_batch_size <= 128))),
    CONSTRAINT campaign_memory_configs_retrieval_implementation_check CHECK ((retrieval_implementation = ANY (ARRAY['legacy_hybrid'::text, 'chunked_hybrid'::text])))
);

--
-- Name: COLUMN campaign_memory_configs.embedding_document_prefix; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.campaign_memory_configs.embedding_document_prefix IS 'Optional explicit task prefix. NULL selects the model-aware default.';

--
-- Name: COLUMN campaign_memory_configs.embedding_query_prefix; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.campaign_memory_configs.embedding_query_prefix IS 'Optional explicit task prefix. NULL selects the model-aware default.';

--
-- Name: campaign_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_state (
    campaign_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    scratchpad_private text DEFAULT ''::text NOT NULL,
    trackers jsonb DEFAULT '[]'::jsonb NOT NULL,
    default_triggers jsonb DEFAULT '[]'::jsonb NOT NULL,
    event_triggers jsonb DEFAULT '[]'::jsonb NOT NULL,
    pending_event_triggers jsonb DEFAULT '[]'::jsonb NOT NULL,
    rpg_stats jsonb DEFAULT '[]'::jsonb NOT NULL,
    import_provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    scratchpad_safe_for_prompt boolean DEFAULT false NOT NULL,
    initial_state_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    CONSTRAINT campaign_state_revision_check CHECK ((revision >= 0))
);

--
-- Name: COLUMN campaign_state.scratchpad_safe_for_prompt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.campaign_state.scratchpad_safe_for_prompt IS 'True only after the scratchpad passed the typed fiction-only story-output validator.';

--
-- Name: campaign_state_edits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_state_edits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    effective_turn_number integer NOT NULL,
    revision integer NOT NULL,
    state_snapshot_private jsonb NOT NULL,
    changed_fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaign_state_edits_effective_turn_number_check CHECK ((effective_turn_number >= 0)),
    CONSTRAINT campaign_state_edits_revision_check CHECK ((revision > 0))
);

--
-- Name: campaign_story_memory_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_story_memory_enrollments (
    campaign_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    capability text NOT NULL,
    review_mode text NOT NULL,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaign_story_memory_enrollments_capability_check CHECK ((capability = ANY (ARRAY['r1'::text, 'r2'::text, 'r3'::text]))),
    CONSTRAINT campaign_story_memory_enrollments_check CHECK ((((capability = ANY (ARRAY['r1'::text, 'r2'::text])) AND (review_mode = 'off'::text)) OR ((capability = 'r3'::text) AND (review_mode = ANY (ARRAY['off'::text, 'observe'::text, 'enforce'::text]))))),
    CONSTRAINT campaign_story_memory_enrollments_review_mode_check CHECK ((review_mode = ANY (ARRAY['off'::text, 'observe'::text, 'enforce'::text])))
);

--
-- Name: campaign_world_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_world_migrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    from_world_version_id uuid NOT NULL,
    to_world_version_id uuid NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaign_world_migrations_check CHECK ((from_world_version_id <> to_world_version_id))
);

--
-- Name: campaign_world_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_world_transfers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    source_campaign_id uuid,
    target_campaign_id uuid,
    from_world_version_id uuid NOT NULL,
    to_world_version_id uuid NOT NULL,
    character_strategy text NOT NULL,
    state_strategy text NOT NULL,
    target_defaults_policy text NOT NULL,
    source_fingerprint text NOT NULL,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaign_world_transfers_character_strategy_check CHECK ((character_strategy = 'preserve_source'::text)),
    CONSTRAINT campaign_world_transfers_check CHECK ((from_world_version_id <> to_world_version_id)),
    CONSTRAINT campaign_world_transfers_source_fingerprint_check CHECK ((source_fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT campaign_world_transfers_state_strategy_check CHECK ((state_strategy = 'preserve'::text)),
    CONSTRAINT campaign_world_transfers_target_defaults_policy_check CHECK ((target_defaults_policy = 'retain_source'::text))
);

--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    world_version_id uuid NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    active_turn_number integer DEFAULT 0 NOT NULL,
    legacy_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    text_provider_profile_id uuid,
    image_provider_profile_id uuid,
    story_length_profile text DEFAULT 'standard'::text NOT NULL,
    selected_character_id text,
    character_snapshot jsonb,
    turn_control_style text DEFAULT 'flexible_action'::text NOT NULL,
    character_profile jsonb,
    character_profile_revision integer DEFAULT 0 NOT NULL,
    story_context_budget_tokens integer DEFAULT 32000 NOT NULL,
    first_appearance_eligible boolean DEFAULT false NOT NULL,
    selected_character_world_id uuid,
    CONSTRAINT campaigns_active_turn_number_check CHECK ((active_turn_number >= 0)),
    CONSTRAINT campaigns_character_profile_object_check CHECK (((character_profile IS NULL) OR (jsonb_typeof(character_profile) = 'object'::text))),
    CONSTRAINT campaigns_character_profile_revision_check CHECK ((character_profile_revision >= 0)),
    CONSTRAINT campaigns_character_snapshot_object_check CHECK (((character_snapshot IS NULL) OR (jsonb_typeof(character_snapshot) = 'object'::text))),
    CONSTRAINT campaigns_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text]))),
    CONSTRAINT campaigns_story_context_budget_tokens_check CHECK ((story_context_budget_tokens = ANY (ARRAY[32000, 64000, 128000, 256000, 1000000, 2000000, 4000000]))),
    CONSTRAINT campaigns_story_length_profile_check CHECK ((story_length_profile = ANY (ARRAY['brief'::text, 'standard'::text, 'long'::text, 'extended'::text]))),
    CONSTRAINT campaigns_turn_control_style_check CHECK ((turn_control_style = ANY (ARRAY['action_only'::text, 'flexible_auto'::text, 'flexible_action'::text, 'flexible_scene'::text])))
);

--
-- Name: COLUMN campaigns.story_length_profile; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.campaigns.story_length_profile IS 'Authoritative default narration-length profile for each generated campaign turn.';

--
-- Name: COLUMN campaigns.selected_character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.campaigns.selected_character_id IS 'Opaque character identifier selected from the campaign pinned world version.';

--
-- Name: COLUMN campaigns.character_snapshot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.campaigns.character_snapshot IS 'Immutable campaign-owned snapshot of the selected playable character.';

--
-- Name: COLUMN campaigns.character_profile; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.campaigns.character_profile IS 'Mutable campaign-owned full copy of the selected character name and structured profile.';

--
-- Name: COLUMN campaigns.character_profile_revision; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.campaigns.character_profile_revision IS 'Optimistic concurrency revision for explicit campaign character profile edits.';

--
-- Name: COLUMN campaigns.story_context_budget_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.campaigns.story_context_budget_tokens IS 'Desired upper Story context target for newly enqueued generation jobs; runtime provider limits still apply.';

--
-- Name: generation_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generation_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    provider_profile_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    expected_turn_number integer NOT NULL,
    action text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    requested_model text DEFAULT ''::text NOT NULL,
    context_options jsonb DEFAULT '{}'::jsonb NOT NULL,
    prompt_protocol_version text DEFAULT 'story-v1'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    provider_response_id text,
    provider_finish_reason text,
    partial_output text,
    result_turn_id uuid,
    error_code text,
    error_message text,
    recovery_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    orchestration_private jsonb DEFAULT '{}'::jsonb NOT NULL,
    operation_kind text DEFAULT 'append'::text NOT NULL,
    replacement_turn_id uuid,
    base_turn_number integer,
    base_state_private jsonb DEFAULT '{}'::jsonb NOT NULL,
    base_scratchpad_safe_for_prompt boolean DEFAULT false NOT NULL,
    requested_input_mode text DEFAULT 'action'::text NOT NULL,
    resolved_input_mode text DEFAULT 'action'::text NOT NULL,
    input_mode_source text DEFAULT 'explicit'::text NOT NULL,
    turn_input_classification_id uuid,
    prompt_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    streaming_segments_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    state_edit_id uuid,
    state_edit_revision integer,
    state_edit_snapshot_private jsonb DEFAULT '{}'::jsonb NOT NULL,
    generation_base_identity jsonb DEFAULT '{}'::jsonb NOT NULL,
    generation_policy jsonb,
    text_plan_protocol smallint,
    activity_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT generation_jobs_activity_revision_check CHECK ((activity_revision >= 0)),
    CONSTRAINT generation_jobs_base_turn_number_check CHECK (((base_turn_number IS NULL) OR (base_turn_number >= 0))),
    CONSTRAINT generation_jobs_expected_turn_number_check CHECK ((expected_turn_number > 0)),
    CONSTRAINT generation_jobs_generation_policy_valid CHECK (((generation_policy IS NULL) OR COALESCE(((jsonb_typeof(generation_policy) = 'object'::text) AND (jsonb_typeof((generation_policy -> 'version'::text)) = 'number'::text) AND ((generation_policy ->> 'version'::text) = '1'::text) AND ((((generation_policy ->> 'playMode'::text) = 'legacy'::text) AND ((generation_policy ->> 'turnControlStyle'::text) = ANY (ARRAY['action_only'::text, 'flexible_action'::text])) AND ((generation_policy ? 'protocolVersion'::text) = false) AND ((generation_policy ? 'prompts'::text) = false)) OR (((generation_policy ->> 'playMode'::text) = 'story_only'::text) AND ((generation_policy ->> 'turnControlStyle'::text) = 'flexible_scene'::text) AND ((generation_policy ->> 'protocolVersion'::text) = 'story-only-v1'::text) AND (jsonb_typeof((generation_policy -> 'prompts'::text)) = 'object'::text) AND ((generation_policy -> 'prompts'::text) ?& ARRAY['systemSupplement'::text, 'systemSupplementHash'::text, 'choiceRepairSystem'::text, 'choiceRepairSystemHash'::text]) AND (jsonb_typeof(((generation_policy -> 'prompts'::text) -> 'systemSupplement'::text)) = 'string'::text) AND (jsonb_typeof(((generation_policy -> 'prompts'::text) -> 'systemSupplementHash'::text)) = 'string'::text) AND (jsonb_typeof(((generation_policy -> 'prompts'::text) -> 'choiceRepairSystem'::text)) = 'string'::text) AND (jsonb_typeof(((generation_policy -> 'prompts'::text) -> 'choiceRepairSystemHash'::text)) = 'string'::text)))), false))),
    CONSTRAINT generation_jobs_input_mode_source_check CHECK ((input_mode_source = ANY (ARRAY['explicit'::text, 'auto'::text, 'generated_choice'::text, 'opening_action'::text, 'fallback'::text]))),
    CONSTRAINT generation_jobs_operation_kind_check CHECK ((operation_kind = ANY (ARRAY['append'::text, 'replace_latest'::text]))),
    CONSTRAINT generation_jobs_requested_input_mode_check CHECK ((requested_input_mode = ANY (ARRAY['auto'::text, 'action'::text, 'scene'::text]))),
    CONSTRAINT generation_jobs_resolved_input_mode_check CHECK ((resolved_input_mode = ANY (ARRAY['action'::text, 'scene'::text]))),
    CONSTRAINT generation_jobs_state_edit_revision_check CHECK (((state_edit_revision IS NULL) OR (state_edit_revision > 0))),
    CONSTRAINT generation_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'replacement_queued'::text, 'assessing'::text, 'generating'::text, 'validating'::text, 'committing'::text, 'completed'::text, 'recoverable'::text, 'failed'::text, 'discarded'::text, 'cancelled'::text]))),
    CONSTRAINT generation_jobs_text_plan_protocol_check CHECK (((text_plan_protocol IS NULL) OR (text_plan_protocol = 2)))
);

--
-- Name: COLUMN generation_jobs.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generation_jobs.status IS 'Durable story workflow phase. Chronicle embedding work is tracked independently in chronicle_jobs.';

--
-- Name: COLUMN generation_jobs.orchestration_private; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generation_jobs.orchestration_private IS 'Private typed referee, roll, and event-trigger state. Never include this object in narrative or Chronicle prompts.';

--
-- Name: COLUMN generation_jobs.operation_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generation_jobs.operation_kind IS 'Append creates the next turn. Replace_latest stages a latest-turn replacement without deleting accepted state before validation.';

--
-- Name: COLUMN generation_jobs.base_state_private; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generation_jobs.base_state_private IS 'Authoritative private campaign state immediately before a staged replacement turn. Never return this value to clients or prompts.';

--
-- Name: COLUMN generation_jobs.prompt_snapshot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generation_jobs.prompt_snapshot IS 'Effective prompt templates captured at queue time. Retries must use this immutable job snapshot.';

--
-- Name: COLUMN generation_jobs.streaming_segments_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generation_jobs.streaming_segments_state IS 'Tracks word count thresholds and segment ordinals created during streaming for incremental illustration enqueue.';

--
-- Name: COLUMN generation_jobs.state_edit_snapshot_private; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generation_jobs.state_edit_snapshot_private IS 'Complete manual state correction captured for durable latest-turn replacement. Never return it to clients or prompts.';

--
-- Name: COLUMN generation_jobs.generation_base_identity; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generation_jobs.generation_base_identity IS 'Immutable authoritative campaign base identity captured at enqueue. Used to fence retries, checkpoints, and commit.';

--
-- Name: prepared_text_physical_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prepared_text_physical_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    logical_kind text NOT NULL,
    reservation_key text NOT NULL,
    logical_reservation jsonb NOT NULL,
    plan_hash text NOT NULL,
    requested_preset_slug text,
    requested_preset_version_id text,
    requested_preset_config_hash text,
    candidate_ordinal integer NOT NULL,
    requested_model text NOT NULL,
    provider_policy jsonb NOT NULL,
    request_payload_hash text NOT NULL,
    request_body text NOT NULL,
    status text DEFAULT 'reserved'::text NOT NULL,
    outcome text,
    failure_reason text,
    provider_response_id text,
    returned_model text,
    returned_provider_route text,
    emitted_output boolean DEFAULT false NOT NULL,
    usage jsonb,
    reported_cost jsonb,
    reserved_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    dispatched_at timestamp with time zone,
    response_started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failure_diagnostic jsonb,
    CONSTRAINT prepared_text_physical_attempts_candidate_ordinal_check CHECK (((candidate_ordinal >= 0) AND (candidate_ordinal <= 31))),
    CONSTRAINT prepared_text_physical_attempts_check CHECK ((((status = 'reserved'::text) AND (dispatched_at IS NULL) AND (completed_at IS NULL) AND (outcome IS NULL)) OR ((status = 'dispatched'::text) AND (dispatched_at IS NOT NULL) AND (completed_at IS NULL) AND (outcome IS NULL)) OR ((status = 'completed'::text) AND (dispatched_at IS NOT NULL) AND (completed_at IS NOT NULL) AND (outcome IS NOT NULL)))),
    CONSTRAINT prepared_text_physical_attempts_check1 CHECK ((((outcome IS NULL) AND (failure_reason IS NULL)) OR ((outcome = 'succeeded'::text) AND (failure_reason IS NULL)) OR ((outcome = 'failed'::text) AND (failure_reason IS NOT NULL)))),
    CONSTRAINT prepared_text_physical_attempts_check2 CHECK ((((requested_preset_slug IS NULL) AND (requested_preset_version_id IS NULL) AND (requested_preset_config_hash IS NULL)) OR ((requested_preset_slug IS NOT NULL) AND (requested_preset_version_id IS NOT NULL) AND (requested_preset_config_hash IS NOT NULL) AND (btrim(requested_preset_slug) <> ''::text) AND (length(requested_preset_slug) <= 200) AND (btrim(requested_preset_version_id) <> ''::text) AND (length(requested_preset_version_id) <= 500) AND (requested_preset_config_hash ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT prepared_text_physical_attempts_failure_diagnostic_check CHECK (((failure_diagnostic IS NULL) OR ((jsonb_typeof(failure_diagnostic) = 'object'::text) AND (((failure_diagnostic -> 'version'::text) = '1'::jsonb) IS TRUE) AND (octet_length((failure_diagnostic)::text) <= 4096)))),
    CONSTRAINT prepared_text_physical_attempts_failure_reason_check CHECK ((failure_reason = ANY (ARRAY['rate_limit'::text, 'provider_unavailable'::text, 'model_unavailable'::text, 'authentication'::text, 'schema_invalid'::text, 'refusal'::text, 'cancelled'::text, 'deadline'::text, 'ambiguous_transport'::text, 'invalid_identity'::text, 'unknown'::text]))),
    CONSTRAINT prepared_text_physical_attempts_logical_kind_check CHECK ((logical_kind = ANY (ARRAY['story'::text, 'authoring'::text, 'illustration'::text, 'direct'::text, 'cast_discovery'::text]))),
    CONSTRAINT prepared_text_physical_attempts_logical_reservation_check CHECK ((jsonb_typeof(logical_reservation) = 'object'::text)),
    CONSTRAINT prepared_text_physical_attempts_outcome_check CHECK ((outcome = ANY (ARRAY['succeeded'::text, 'failed'::text]))),
    CONSTRAINT prepared_text_physical_attempts_plan_hash_check CHECK ((plan_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT prepared_text_physical_attempts_provider_policy_check CHECK ((jsonb_typeof(provider_policy) = 'object'::text)),
    CONSTRAINT prepared_text_physical_attempts_reported_cost_check CHECK (((reported_cost IS NULL) OR (jsonb_typeof(reported_cost) = 'object'::text))),
    CONSTRAINT prepared_text_physical_attempts_request_payload_hash_check CHECK ((request_payload_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT prepared_text_physical_attempts_requested_model_check CHECK (((btrim(requested_model) <> ''::text) AND (length(requested_model) <= 500))),
    CONSTRAINT prepared_text_physical_attempts_reservation_key_check CHECK (((btrim(reservation_key) <> ''::text) AND (length(reservation_key) <= 1000))),
    CONSTRAINT prepared_text_physical_attempts_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'dispatched'::text, 'completed'::text]))),
    CONSTRAINT prepared_text_physical_attempts_usage_check CHECK (((usage IS NULL) OR (jsonb_typeof(usage) = 'object'::text)))
);

--
-- Name: TABLE prepared_text_physical_attempts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.prepared_text_physical_attempts IS 'Private durable concrete-route attempts beneath Story, authoring, illustration, or request-scoped logical text reservations.';

--
-- Name: COLUMN prepared_text_physical_attempts.failure_diagnostic; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prepared_text_physical_attempts.failure_diagnostic IS 'Bounded versioned provider failure evidence; operational, never portable campaign authority.';

--
-- Name: cancelled_dispatch_evidence; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.cancelled_dispatch_evidence AS
 SELECT a.id AS attempt_id,
    a.owner_user_id,
    a.logical_kind,
    COALESCE(g.id, c.id) AS parent_job_id,
    sha256(convert_to((to_jsonb(a.*))::text, 'UTF8'::name)) AS attempt_sha256
   FROM ((public.prepared_text_physical_attempts a
     LEFT JOIN public.generation_jobs g ON (((a.logical_kind = 'story'::text) AND (g.owner_user_id = a.owner_user_id) AND ((g.id)::text = (a.logical_reservation ->> 'generationJobId'::text)) AND (g.status = 'cancelled'::text))))
     LEFT JOIN public.campaign_cast_discovery_jobs c ON (((a.logical_kind = 'cast_discovery'::text) AND (c.owner_user_id = a.owner_user_id) AND ((c.id)::text = (a.logical_reservation ->> 'jobId'::text)) AND (c.status = 'cancelled'::text))))
  WHERE ((a.status = 'dispatched'::text) AND (a.outcome IS NULL) AND ((g.id IS NOT NULL) OR (c.id IS NOT NULL)));

--
-- Name: cancelled_dispatch_recoveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cancelled_dispatch_recoveries (
    attempt_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    parent_job_id uuid NOT NULL,
    logical_kind text NOT NULL,
    attempt_sha256 bytea NOT NULL,
    maintenance_reference text NOT NULL,
    recorded_by text DEFAULT CURRENT_USER NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT cancelled_dispatch_recoveries_attempt_sha256_check CHECK ((octet_length(attempt_sha256) = 32)),
    CONSTRAINT cancelled_dispatch_recoveries_logical_kind_check CHECK ((logical_kind = ANY (ARRAY['story'::text, 'cast_discovery'::text]))),
    CONSTRAINT cancelled_dispatch_recoveries_maintenance_reference_check CHECK (((length(maintenance_reference) >= 3) AND (length(maintenance_reference) <= 200)))
);

--
-- Name: chronicle_chunk_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chronicle_chunk_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    job_type text DEFAULT 'index_memory_chunks_v2'::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    work_version bigint DEFAULT 1 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    lease_token uuid,
    work_signature text DEFAULT repeat('0'::text, 64) NOT NULL,
    processed_signature text,
    CONSTRAINT chronicle_chunk_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT chronicle_chunk_jobs_completed_check CHECK ((((status = 'completed'::text) AND (completed_at IS NOT NULL)) OR ((status <> 'completed'::text) AND (completed_at IS NULL)))),
    CONSTRAINT chronicle_chunk_jobs_job_type_check CHECK ((job_type = 'index_memory_chunks_v2'::text)),
    CONSTRAINT chronicle_chunk_jobs_lease_check CHECK ((((status = 'running'::text) AND (lease_owner IS NOT NULL) AND (btrim(lease_owner) <> ''::text) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((status <> 'running'::text) AND (lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT chronicle_chunk_jobs_processed_signature_check CHECK (((processed_signature IS NULL) OR (processed_signature ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT chronicle_chunk_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT chronicle_chunk_jobs_work_signature_check CHECK ((work_signature ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT chronicle_chunk_jobs_work_version_check CHECK ((work_version > 0))
);

--
-- Name: COLUMN chronicle_chunk_jobs.lease_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chronicle_chunk_jobs.lease_token IS 'Opaque per-claim authority regenerated on every claim, including same-worker expired-lease reclamation.';

--
-- Name: COLUMN chronicle_chunk_jobs.work_signature; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chronicle_chunk_jobs.work_signature IS 'SHA-256 of the current world-version and ordered Chronicle parent ids/content hashes; unchanged enqueue is a no-op.';

--
-- Name: COLUMN chronicle_chunk_jobs.processed_signature; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chronicle_chunk_jobs.processed_signature IS 'SHA-256 of the ordered parent ids/content hashes at or before the durable cursor; NULL forces a restart.';

--
-- Name: chronicle_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chronicle_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    job_type text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    work_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT chronicle_jobs_job_type_check CHECK ((job_type = ANY (ARRAY['reindex_campaign'::text, 'embed_campaign'::text]))),
    CONSTRAINT chronicle_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT chronicle_jobs_work_version_check CHECK ((work_version > 0))
);

--
-- Name: COLUMN chronicle_jobs.work_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chronicle_jobs.work_version IS 'Incremented whenever more Chronicle work arrives so a running job cannot lose concurrent updates.';

--
-- Name: chronicle_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chronicle_memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    world_version_id uuid NOT NULL,
    turn_id uuid,
    memory_kind text NOT NULL,
    ordinal integer DEFAULT 0 NOT NULL,
    content text NOT NULL,
    token_estimate integer NOT NULL,
    importance real DEFAULT 0.5 NOT NULL,
    entities text[] DEFAULT ARRAY[]::text[] NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    embedding public.vector,
    search_document tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding_provider_profile_id uuid,
    embedding_model text,
    embedding_dimensions integer,
    embedding_content_hash text,
    embedding_updated_at timestamp with time zone,
    embedding_provider_fingerprint text,
    entity_ids text[] DEFAULT ARRAY[]::text[] NOT NULL,
    content_hash text GENERATED ALWAYS AS (encode(public.digest(content, 'sha256'::text), 'hex'::text)) STORED,
    CONSTRAINT chronicle_memories_embedding_dimensions_check CHECK ((embedding_dimensions > 0)),
    CONSTRAINT chronicle_memories_embedding_metadata_check CHECK ((((embedding IS NULL) AND (embedding_provider_profile_id IS NULL) AND (embedding_model IS NULL) AND (embedding_dimensions IS NULL) AND (embedding_content_hash IS NULL) AND (embedding_updated_at IS NULL) AND (embedding_provider_fingerprint IS NULL)) OR ((embedding IS NOT NULL) AND (embedding_provider_profile_id IS NOT NULL) AND (embedding_model IS NOT NULL) AND (embedding_dimensions IS NOT NULL) AND (embedding_content_hash IS NOT NULL) AND (embedding_updated_at IS NOT NULL) AND (embedding_provider_fingerprint IS NOT NULL)))),
    CONSTRAINT chronicle_memories_importance_check CHECK (((importance >= (0)::double precision) AND (importance <= (1)::double precision))),
    CONSTRAINT chronicle_memories_memory_kind_check CHECK ((memory_kind = ANY (ARRAY['turn_fiction'::text, 'legacy_summary'::text, 'campaign_summary'::text, 'canonical_fact'::text, 'open_thread'::text]))),
    CONSTRAINT chronicle_memories_token_estimate_check CHECK ((token_estimate >= 0))
);

--
-- Name: COLUMN chronicle_memories.embedding_provider_fingerprint; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chronicle_memories.embedding_provider_fingerprint IS 'Hash of provider endpoint, type, model, task prefixes, and relevant configuration used to create the vector.';

--
-- Name: COLUMN chronicle_memories.entity_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chronicle_memories.entity_ids IS 'Derived stable entity references resolved only from the campaign pinned world version and character snapshot.';

--
-- Name: chronicle_memory_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chronicle_memory_chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    world_version_id uuid NOT NULL,
    parent_memory_id uuid NOT NULL,
    parent_content_hash text NOT NULL,
    chunking_protocol_version text NOT NULL,
    chunk_ordinal integer NOT NULL,
    chunk_kind text NOT NULL,
    content text NOT NULL,
    content_hash text GENERATED ALWAYS AS (encode(public.digest(content, 'sha256'::text), 'hex'::text)) STORED,
    source_start_offset integer DEFAULT 0 NOT NULL,
    source_end_offset integer DEFAULT 0 NOT NULL,
    token_estimate integer NOT NULL,
    entities text[] DEFAULT ARRAY[]::text[] NOT NULL,
    entity_ids text[] DEFAULT ARRAY[]::text[] NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    embedding public.vector,
    embedding_status text DEFAULT 'pending'::text NOT NULL,
    embedding_skip_reason text,
    embedding_provider_profile_id uuid,
    embedding_model text,
    embedding_dimensions integer,
    embedding_protocol_version text,
    embedding_provider_fingerprint text,
    embedding_content_hash text,
    embedding_updated_at timestamp with time zone,
    search_document tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chronicle_memory_chunks_check CHECK ((source_end_offset >= source_start_offset)),
    CONSTRAINT chronicle_memory_chunks_chunk_kind_check CHECK ((chunk_kind = ANY (ARRAY['turn_action'::text, 'turn_narration'::text, 'legacy_summary'::text, 'campaign_summary'::text, 'canonical_fact'::text, 'open_thread'::text]))),
    CONSTRAINT chronicle_memory_chunks_chunk_ordinal_check CHECK ((chunk_ordinal >= 0)),
    CONSTRAINT chronicle_memory_chunks_chunking_protocol_version_check CHECK (((length(btrim(chunking_protocol_version)) >= 1) AND (length(btrim(chunking_protocol_version)) <= 200))),
    CONSTRAINT chronicle_memory_chunks_embedding_dimensions_check CHECK ((embedding_dimensions > 0)),
    CONSTRAINT chronicle_memory_chunks_embedding_metadata_check CHECK ((((embedding_status = 'pending'::text) AND (embedding IS NULL) AND (embedding_skip_reason IS NULL) AND (embedding_provider_profile_id IS NULL) AND (embedding_model IS NULL) AND (embedding_dimensions IS NULL) AND (embedding_protocol_version IS NULL) AND (embedding_provider_fingerprint IS NULL) AND (embedding_content_hash IS NULL) AND (embedding_updated_at IS NULL)) OR ((embedding_status = 'embedded'::text) AND (embedding IS NOT NULL) AND (embedding_skip_reason IS NULL) AND (embedding_provider_profile_id IS NOT NULL) AND (embedding_model IS NOT NULL) AND (embedding_dimensions IS NOT NULL) AND (embedding_protocol_version IS NOT NULL) AND (embedding_provider_fingerprint IS NOT NULL) AND (embedding_content_hash = content_hash) AND (embedding_updated_at IS NOT NULL)) OR ((embedding_status = 'skipped'::text) AND (embedding IS NULL) AND (embedding_skip_reason IS NOT NULL) AND (embedding_provider_profile_id IS NULL) AND (embedding_model IS NULL) AND (embedding_dimensions IS NULL) AND (embedding_protocol_version IS NULL) AND (embedding_provider_fingerprint IS NULL) AND (embedding_content_hash IS NULL) AND (embedding_updated_at IS NULL)))),
    CONSTRAINT chronicle_memory_chunks_embedding_skip_reason_check CHECK (((embedding_skip_reason IS NULL) OR (embedding_skip_reason = ANY (ARRAY['semantic_retrieval_disabled'::text, 'chunk_exceeds_provider_capacity'::text, 'chunk_embedding_skipped'::text])))),
    CONSTRAINT chronicle_memory_chunks_embedding_status_check CHECK ((embedding_status = ANY (ARRAY['pending'::text, 'embedded'::text, 'skipped'::text]))),
    CONSTRAINT chronicle_memory_chunks_parent_content_hash_check CHECK ((parent_content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT chronicle_memory_chunks_source_start_offset_check CHECK ((source_start_offset >= 0)),
    CONSTRAINT chronicle_memory_chunks_token_estimate_check CHECK ((token_estimate >= 0))
);

--
-- Name: COLUMN chronicle_memory_chunks.embedding_skip_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chronicle_memory_chunks.embedding_skip_reason IS 'Closed sanitized reason set; provider text, endpoints, and credentials are never representable here.';

--
-- Name: chronicle_query_embedding_cache_access_sequence; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chronicle_query_embedding_cache_access_sequence
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: chronicle_query_embedding_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chronicle_query_embedding_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    normalized_query_hash text NOT NULL,
    provider_profile_id uuid NOT NULL,
    embedding_model_hash text NOT NULL,
    provider_fingerprint_hash text CONSTRAINT chronicle_query_embedding_ca_provider_fingerprint_hash_not_null NOT NULL,
    query_prefix_hash text NOT NULL,
    embedding_protocol_version text CONSTRAINT chronicle_query_embedding_c_embedding_protocol_version_not_null NOT NULL,
    embedding public.vector NOT NULL,
    embedding_dimensions integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_accessed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '7 days'::interval) NOT NULL,
    hit_count bigint DEFAULT 0 NOT NULL,
    last_accessed_sequence bigint DEFAULT nextval('public.chronicle_query_embedding_cache_access_sequence'::regclass) NOT NULL,
    CONSTRAINT chronicle_query_embedding_cach_embedding_protocol_version_check CHECK ((embedding_protocol_version ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'::text)),
    CONSTRAINT chronicle_query_embedding_cache_dimensions_match CHECK ((public.vector_dims(embedding) = embedding_dimensions)),
    CONSTRAINT chronicle_query_embedding_cache_embedding_dimensions_check CHECK (((embedding_dimensions >= 1) AND (embedding_dimensions <= 16000))),
    CONSTRAINT chronicle_query_embedding_cache_embedding_model_hash_check CHECK ((embedding_model_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT chronicle_query_embedding_cache_hit_count_check CHECK ((hit_count >= 0)),
    CONSTRAINT chronicle_query_embedding_cache_normalized_query_hash_check CHECK ((normalized_query_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT chronicle_query_embedding_cache_provider_fingerprint_hash_check CHECK ((provider_fingerprint_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT chronicle_query_embedding_cache_query_prefix_hash_check CHECK ((query_prefix_hash ~ '^[0-9a-f]{64}$'::text))
);

--
-- Name: TABLE chronicle_query_embedding_cache; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.chronicle_query_embedding_cache IS 'Scoped derived query vectors only; raw queries, expanded queries, prefixes, model names, provider fingerprints, prompts, responses, endpoints, and credentials are forbidden.';

--
-- Name: COLUMN chronicle_query_embedding_cache.normalized_query_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chronicle_query_embedding_cache.normalized_query_hash IS 'SHA-256 of the normalized expanded query; never the query text.';

--
-- Name: COLUMN chronicle_query_embedding_cache.embedding_model_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chronicle_query_embedding_cache.embedding_model_hash IS 'SHA-256 of the embedding model identity; never the raw model name.';

--
-- Name: COLUMN chronicle_query_embedding_cache.provider_fingerprint_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chronicle_query_embedding_cache.provider_fingerprint_hash IS 'SHA-256 of the safe provider fingerprint; never provider configuration or credentials.';

--
-- Name: COLUMN chronicle_query_embedding_cache.query_prefix_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chronicle_query_embedding_cache.query_prefix_hash IS 'SHA-256 of the effective query prefix; never the prefix text.';

--
-- Name: COLUMN chronicle_query_embedding_cache.last_accessed_sequence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chronicle_query_embedding_cache.last_accessed_sequence IS 'Monotonic cache-local access order used to break timestamp ties during LRU eviction.';

--
-- Name: chronicle_retrieval_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chronicle_retrieval_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    world_version_id uuid NOT NULL,
    implementation text NOT NULL,
    candidate_id text NOT NULL,
    parent_memory_id uuid NOT NULL,
    rank integer NOT NULL,
    reason text NOT NULL,
    token_estimate integer NOT NULL,
    selected boolean NOT NULL,
    production_selection boolean NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT chronicle_retrieval_candidates_candidate_id_check CHECK ((candidate_id ~ '^[A-Za-z0-9_.:-]{1,200}$'::text)),
    CONSTRAINT chronicle_retrieval_candidates_implementation_check CHECK ((implementation = ANY (ARRAY['lexical'::text, 'legacy_hybrid'::text, 'chunked_hybrid'::text]))),
    CONSTRAINT chronicle_retrieval_candidates_rank_check CHECK (((rank >= 1) AND (rank <= 10000))),
    CONSTRAINT chronicle_retrieval_candidates_reason_check CHECK ((reason ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'::text)),
    CONSTRAINT chronicle_retrieval_candidates_token_estimate_check CHECK ((token_estimate >= 0))
);

--
-- Name: TABLE chronicle_retrieval_candidates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.chronicle_retrieval_candidates IS 'Safe Chronicle candidate IDs, ranks, reason codes, token estimates, and selection flags only.';

--
-- Name: chronicle_retrieval_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chronicle_retrieval_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    world_version_id uuid NOT NULL,
    query_hash text NOT NULL,
    production_implementation text NOT NULL,
    shadow_enabled boolean NOT NULL,
    retrieval_version text NOT NULL,
    embedding_protocol_version text NOT NULL,
    chunk_protocol_version text NOT NULL,
    provider_fingerprint text,
    query_token_estimate integer NOT NULL,
    cost_ids uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
    lexical_latency_ms integer,
    lexical_fallback_code text,
    legacy_hybrid_latency_ms integer,
    legacy_hybrid_fallback_code text,
    chunked_hybrid_latency_ms integer,
    chunked_hybrid_fallback_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT chronicle_retrieval_runs_chunk_protocol_version_check CHECK ((chunk_protocol_version ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'::text)),
    CONSTRAINT chronicle_retrieval_runs_chunked_hybrid_fallback_code_check CHECK (((chunked_hybrid_fallback_code IS NULL) OR (chunked_hybrid_fallback_code ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'::text))),
    CONSTRAINT chronicle_retrieval_runs_chunked_hybrid_latency_ms_check CHECK ((chunked_hybrid_latency_ms >= 0)),
    CONSTRAINT chronicle_retrieval_runs_embedding_protocol_version_check CHECK ((embedding_protocol_version ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'::text)),
    CONSTRAINT chronicle_retrieval_runs_legacy_hybrid_fallback_code_check CHECK (((legacy_hybrid_fallback_code IS NULL) OR (legacy_hybrid_fallback_code ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'::text))),
    CONSTRAINT chronicle_retrieval_runs_legacy_hybrid_latency_ms_check CHECK ((legacy_hybrid_latency_ms >= 0)),
    CONSTRAINT chronicle_retrieval_runs_lexical_fallback_code_check CHECK (((lexical_fallback_code IS NULL) OR (lexical_fallback_code ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'::text))),
    CONSTRAINT chronicle_retrieval_runs_lexical_latency_ms_check CHECK ((lexical_latency_ms >= 0)),
    CONSTRAINT chronicle_retrieval_runs_production_implementation_check CHECK ((production_implementation = ANY (ARRAY['legacy_hybrid'::text, 'chunked_hybrid'::text]))),
    CONSTRAINT chronicle_retrieval_runs_provider_fingerprint_check CHECK (((provider_fingerprint IS NULL) OR ((length(provider_fingerprint) BETWEEN 1 AND 512) AND (provider_fingerprint ~ '^[A-Za-z0-9_.:-]+$'::text)))),
    CONSTRAINT chronicle_retrieval_runs_query_hash_check CHECK ((query_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT chronicle_retrieval_runs_query_token_estimate_check CHECK ((query_token_estimate >= 0)),
    CONSTRAINT chronicle_retrieval_runs_retrieval_version_check CHECK ((retrieval_version ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'::text))
);

--
-- Name: TABLE chronicle_retrieval_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.chronicle_retrieval_runs IS 'Safe Chronicle comparison metadata only; raw query, action, narration, prompts, responses, endpoints, and credentials are forbidden.';

--
-- Name: durable_filesystem_candidate_authorities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.durable_filesystem_candidate_authorities (
    candidate_token_hash text CONSTRAINT durable_filesystem_candidate_auth_candidate_token_hash_not_null NOT NULL,
    operation_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    purpose text NOT NULL,
    resource_kind text NOT NULL,
    asset_id uuid,
    operation_scope_hash text,
    relative_path text NOT NULL,
    device_id text NOT NULL,
    file_id text NOT NULL,
    change_token text NOT NULL,
    content_hash text NOT NULL,
    byte_length bigint NOT NULL,
    lifecycle text DEFAULT 'issued'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT durable_candidate_scope_check CHECK ((((resource_kind = 'asset'::text) AND (purpose = ANY (ARRAY['asset_original'::text, 'asset_derivative'::text])) AND (asset_id IS NOT NULL) AND (operation_scope_hash IS NULL)) OR ((resource_kind = 'portable'::text) AND (purpose = ANY (ARRAY['portable_staging'::text, 'portable_export'::text])) AND (asset_id IS NULL) AND (operation_scope_hash IS NOT NULL)))),
    CONSTRAINT durable_filesystem_candidate_authori_candidate_token_hash_check CHECK ((candidate_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT durable_filesystem_candidate_authori_operation_scope_hash_check CHECK (((operation_scope_hash IS NULL) OR (operation_scope_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT durable_filesystem_candidate_authorities_byte_length_check CHECK ((byte_length >= 0)),
    CONSTRAINT durable_filesystem_candidate_authorities_change_token_check CHECK ((btrim(change_token) <> ''::text)),
    CONSTRAINT durable_filesystem_candidate_authorities_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT durable_filesystem_candidate_authorities_device_id_check CHECK ((btrim(device_id) <> ''::text)),
    CONSTRAINT durable_filesystem_candidate_authorities_file_id_check CHECK ((btrim(file_id) <> ''::text)),
    CONSTRAINT durable_filesystem_candidate_authorities_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['issued'::text, 'attached'::text, 'expired'::text, 'revoked'::text]))),
    CONSTRAINT durable_filesystem_candidate_authorities_purpose_check CHECK ((purpose = ANY (ARRAY['asset_original'::text, 'asset_derivative'::text, 'portable_staging'::text, 'portable_export'::text]))),
    CONSTRAINT durable_filesystem_candidate_authorities_relative_path_check CHECK (((relative_path <> ''::text) AND (relative_path !~ '(^/|^[A-Za-z]:|^\\\\|\\\\|(^|/)\.\.?(/|$))'::text))),
    CONSTRAINT durable_filesystem_candidate_authorities_resource_kind_check CHECK ((resource_kind = ANY (ARRAY['asset'::text, 'portable'::text])))
);

--
-- Name: durable_filesystem_descriptors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.durable_filesystem_descriptors (
    operation_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    descriptor_role text NOT NULL,
    ordinal integer NOT NULL,
    relative_path text NOT NULL,
    device_id text NOT NULL,
    file_id text NOT NULL,
    change_token text NOT NULL,
    content_hash text NOT NULL,
    byte_length bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT durable_filesystem_descriptors_byte_length_check CHECK ((byte_length >= 0)),
    CONSTRAINT durable_filesystem_descriptors_change_token_check CHECK ((btrim(change_token) <> ''::text)),
    CONSTRAINT durable_filesystem_descriptors_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT durable_filesystem_descriptors_descriptor_role_check CHECK ((descriptor_role = ANY (ARRAY['delivery'::text, 'cleanup'::text]))),
    CONSTRAINT durable_filesystem_descriptors_device_id_check CHECK ((btrim(device_id) <> ''::text)),
    CONSTRAINT durable_filesystem_descriptors_file_id_check CHECK ((btrim(file_id) <> ''::text)),
    CONSTRAINT durable_filesystem_descriptors_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT durable_filesystem_descriptors_relative_path_check CHECK (((relative_path <> ''::text) AND (relative_path !~ '(^/|^[A-Za-z]:|^\\\\|\\\\|(^|/)\.\.?(/|$))'::text)))
);

--
-- Name: durable_filesystem_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.durable_filesystem_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    operation_token_hash text NOT NULL,
    purpose text NOT NULL,
    resource_kind text NOT NULL,
    asset_id uuid,
    operation_scope_hash text,
    lifecycle text DEFAULT 'reserved'::text NOT NULL,
    candidate_token_hash text,
    locator_token_hash text,
    diagnostic_code text,
    lease_id uuid NOT NULL,
    lease_owner text NOT NULL,
    work_version integer DEFAULT 1 NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    attached_at timestamp with time zone,
    finalized_at timestamp with time zone,
    cleanup_requested_at timestamp with time zone,
    cleaned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT durable_filesystem_attachment_check CHECK ((((lifecycle = 'reserved'::text) AND (candidate_token_hash IS NULL) AND (locator_token_hash IS NULL) AND (attached_at IS NULL)) OR ((lifecycle = ANY (ARRAY['attached'::text, 'finalized'::text])) AND (candidate_token_hash IS NOT NULL) AND (locator_token_hash IS NOT NULL) AND (attached_at IS NOT NULL)) OR ((lifecycle = ANY (ARRAY['cleanup_pending'::text, 'cleaned'::text])) AND (((candidate_token_hash IS NULL) AND (locator_token_hash IS NULL) AND (attached_at IS NULL)) OR ((candidate_token_hash IS NOT NULL) AND (locator_token_hash IS NOT NULL) AND (attached_at IS NOT NULL)))))),
    CONSTRAINT durable_filesystem_operations_candidate_token_hash_check CHECK (((candidate_token_hash IS NULL) OR (candidate_token_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT durable_filesystem_operations_diagnostic_code_check CHECK (((diagnostic_code IS NULL) OR (diagnostic_code = ANY (ARRAY['asset_content_invalid'::text, 'asset_hash_mismatch'::text, 'asset_metadata_unavailable'::text, 'asset_storage_unavailable'::text, 'asset_unsupported_media'::text, 'asset_too_large'::text, 'filesystem_containment_denied'::text, 'filesystem_link_denied'::text, 'filesystem_path_invalid'::text, 'filesystem_race_detected'::text])))),
    CONSTRAINT durable_filesystem_operations_lease_owner_check CHECK ((btrim(lease_owner) <> ''::text)),
    CONSTRAINT durable_filesystem_operations_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['reserved'::text, 'attached'::text, 'finalized'::text, 'cleanup_pending'::text, 'cleaned'::text]))),
    CONSTRAINT durable_filesystem_operations_locator_token_hash_check CHECK (((locator_token_hash IS NULL) OR (locator_token_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT durable_filesystem_operations_operation_scope_hash_check CHECK (((operation_scope_hash IS NULL) OR (operation_scope_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT durable_filesystem_operations_operation_token_hash_check CHECK ((operation_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT durable_filesystem_operations_purpose_check CHECK ((purpose = ANY (ARRAY['asset_original'::text, 'asset_derivative'::text, 'portable_staging'::text, 'portable_export'::text]))),
    CONSTRAINT durable_filesystem_operations_resource_kind_check CHECK ((resource_kind = ANY (ARRAY['asset'::text, 'portable'::text]))),
    CONSTRAINT durable_filesystem_operations_work_version_check CHECK ((work_version > 0)),
    CONSTRAINT durable_filesystem_scope_check CHECK ((((resource_kind = 'asset'::text) AND (purpose = ANY (ARRAY['asset_original'::text, 'asset_derivative'::text])) AND (asset_id IS NOT NULL) AND (operation_scope_hash IS NULL)) OR ((resource_kind = 'portable'::text) AND (purpose = ANY (ARRAY['portable_staging'::text, 'portable_export'::text])) AND (asset_id IS NULL) AND (operation_scope_hash IS NOT NULL)))),
    CONSTRAINT durable_filesystem_terminal_check CHECK ((((lifecycle = 'finalized'::text) AND (finalized_at IS NOT NULL) AND (cleaned_at IS NULL)) OR ((lifecycle = 'cleaned'::text) AND (cleaned_at IS NOT NULL)) OR (lifecycle = ANY (ARRAY['reserved'::text, 'attached'::text, 'cleanup_pending'::text]))))
);

--
-- Name: durable_filesystem_prewrite_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.durable_filesystem_prewrite_nodes (
    operation_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    purpose text NOT NULL,
    relative_path text NOT NULL,
    device_id text,
    file_id text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    authority_state text DEFAULT 'identity_bound'::text NOT NULL,
    target_recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    identity_bound_at timestamp with time zone,
    quarantined_at timestamp with time zone,
    quarantine_reason text,
    CONSTRAINT durable_filesystem_prewrite_authority_state_check CHECK ((authority_state = ANY (ARRAY['target_only'::text, 'identity_bound'::text, 'quarantined'::text]))),
    CONSTRAINT durable_filesystem_prewrite_identity_state_check CHECK ((((authority_state = 'target_only'::text) AND (device_id IS NULL) AND (file_id IS NULL) AND (identity_bound_at IS NULL) AND (quarantined_at IS NULL) AND (quarantine_reason IS NULL)) OR ((authority_state = 'identity_bound'::text) AND (device_id IS NOT NULL) AND (btrim(device_id) <> ''::text) AND (file_id IS NOT NULL) AND (btrim(file_id) <> ''::text) AND (identity_bound_at IS NOT NULL) AND (quarantined_at IS NULL) AND (quarantine_reason IS NULL)) OR ((authority_state = 'quarantined'::text) AND (device_id IS NULL) AND (file_id IS NULL) AND (identity_bound_at IS NULL) AND (quarantined_at IS NOT NULL) AND (quarantine_reason IS NOT NULL) AND (btrim(quarantine_reason) <> ''::text)))),
    CONSTRAINT durable_filesystem_prewrite_nodes_device_id_check CHECK ((btrim(device_id) <> ''::text)),
    CONSTRAINT durable_filesystem_prewrite_nodes_file_id_check CHECK ((btrim(file_id) <> ''::text)),
    CONSTRAINT durable_filesystem_prewrite_nodes_purpose_check CHECK ((purpose = ANY (ARRAY['asset_original'::text, 'asset_derivative'::text, 'portable_staging'::text, 'portable_export'::text]))),
    CONSTRAINT durable_filesystem_prewrite_target_check CHECK ((((purpose = ANY (ARRAY['asset_original'::text, 'asset_derivative'::text])) AND (relative_path ~ '^assets/content/[0-9a-f]{64}$'::text)) OR ((purpose = ANY (ARRAY['portable_staging'::text, 'portable_export'::text])) AND (relative_path = public.durable_filesystem_expected_prewrite_path(operation_id, purpose)))))
);

--
-- Name: turn_narration_corrections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.turn_narration_corrections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    revision integer NOT NULL,
    narration text NOT NULL,
    previous_effective_narration_hash text CONSTRAINT turn_narration_corrections_previous_effective_narratio_not_null NOT NULL,
    reason text,
    source text NOT NULL,
    created_by_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT turn_narration_corrections_check CHECK ((created_by_user_id = owner_user_id)),
    CONSTRAINT turn_narration_corrections_narration_check CHECK (((length(btrim(narration)) >= 1) AND (length(btrim(narration)) <= 200000))),
    CONSTRAINT turn_narration_corrections_previous_effective_narration_h_check CHECK ((previous_effective_narration_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT turn_narration_corrections_reason_check CHECK (((reason IS NULL) OR ((length(btrim(reason)) >= 1) AND (length(btrim(reason)) <= 2000)))),
    CONSTRAINT turn_narration_corrections_revision_check CHECK ((revision > 0)),
    CONSTRAINT turn_narration_corrections_source_check CHECK ((source = ANY (ARRAY['user_edit'::text, 'legacy_import'::text, 'administrative'::text])))
);

--
-- Name: TABLE turn_narration_corrections; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.turn_narration_corrections IS 'Append-only accepted-turn narration corrections. The immutable turns.narration ledger remains unchanged.';

--
-- Name: turns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.turns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    turn_number integer NOT NULL,
    source_turn_id text,
    action text DEFAULT ''::text NOT NULL,
    narration text NOT NULL,
    choices jsonb DEFAULT '[]'::jsonb NOT NULL,
    custom_action_suggestion text DEFAULT ''::text NOT NULL,
    image_prompt text DEFAULT ''::text NOT NULL,
    image_url text DEFAULT ''::text NOT NULL,
    mechanics_private jsonb,
    state_snapshot_private jsonb DEFAULT '{}'::jsonb NOT NULL,
    model_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    import_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    input_mode text DEFAULT 'action'::text NOT NULL,
    input_mode_source text DEFAULT 'explicit'::text NOT NULL,
    generation_policy jsonb,
    CONSTRAINT turns_generation_policy_valid CHECK (((generation_policy IS NULL) OR COALESCE(((jsonb_typeof(generation_policy) = 'object'::text) AND (jsonb_typeof((generation_policy -> 'version'::text)) = 'number'::text) AND ((generation_policy ->> 'version'::text) = '1'::text) AND ((((generation_policy ->> 'playMode'::text) = 'legacy'::text) AND ((generation_policy ->> 'turnControlStyle'::text) = ANY (ARRAY['action_only'::text, 'flexible_action'::text])) AND ((generation_policy ? 'protocolVersion'::text) = false) AND ((generation_policy ? 'prompts'::text) = false)) OR (((generation_policy ->> 'playMode'::text) = 'story_only'::text) AND ((generation_policy ->> 'turnControlStyle'::text) = 'flexible_scene'::text) AND ((generation_policy ->> 'protocolVersion'::text) = 'story-only-v1'::text) AND (jsonb_typeof((generation_policy -> 'prompts'::text)) = 'object'::text) AND ((generation_policy -> 'prompts'::text) ?& ARRAY['systemSupplement'::text, 'systemSupplementHash'::text, 'choiceRepairSystem'::text, 'choiceRepairSystemHash'::text]) AND (jsonb_typeof(((generation_policy -> 'prompts'::text) -> 'systemSupplement'::text)) = 'string'::text) AND (jsonb_typeof(((generation_policy -> 'prompts'::text) -> 'systemSupplementHash'::text)) = 'string'::text) AND (jsonb_typeof(((generation_policy -> 'prompts'::text) -> 'choiceRepairSystem'::text)) = 'string'::text) AND (jsonb_typeof(((generation_policy -> 'prompts'::text) -> 'choiceRepairSystemHash'::text)) = 'string'::text)))), false))),
    CONSTRAINT turns_input_mode_check CHECK ((input_mode = ANY (ARRAY['action'::text, 'scene'::text]))),
    CONSTRAINT turns_input_mode_source_check CHECK ((input_mode_source = ANY (ARRAY['explicit'::text, 'auto'::text, 'generated_choice'::text, 'opening_action'::text, 'fallback'::text]))),
    CONSTRAINT turns_turn_number_check CHECK ((turn_number > 0))
);

--
-- Name: effective_turn_narrations; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.effective_turn_narrations AS
 SELECT turn_row.id AS turn_id,
    turn_row.owner_user_id,
    turn_row.campaign_id,
    turn_row.turn_number,
    turn_row.narration AS original_narration,
    COALESCE(correction.narration, turn_row.narration) AS effective_narration,
    COALESCE(correction.revision, 0) AS correction_revision,
    correction.created_at AS corrected_at
   FROM (public.turns turn_row
     LEFT JOIN LATERAL ( SELECT candidate.narration,
            candidate.revision,
            candidate.created_at
           FROM public.turn_narration_corrections candidate
          WHERE ((candidate.owner_user_id = turn_row.owner_user_id) AND (candidate.campaign_id = turn_row.campaign_id) AND (candidate.turn_id = turn_row.id))
          ORDER BY candidate.revision DESC
         LIMIT 1) correction ON (true));

--
-- Name: VIEW effective_turn_narrations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.effective_turn_narrations IS 'Single authoritative projection for consumers that need the latest accepted narration correction.';

--
-- Name: generation_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generation_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    generation_job_id uuid NOT NULL,
    attempt_number integer NOT NULL,
    recovery_kind text DEFAULT 'initial'::text NOT NULL,
    request_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    response_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    provider_response_id text,
    finish_reason text,
    raw_output text,
    validation_errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT generation_attempts_attempt_number_check CHECK ((attempt_number > 0))
);

--
-- Name: illustration_backfill_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.illustration_backfill_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    mode text DEFAULT 'missing'::text NOT NULL,
    status text DEFAULT 'completed'::text NOT NULL,
    config_snapshot jsonb NOT NULL,
    estimated_turns integer NOT NULL,
    estimated_segments integer NOT NULL,
    estimated_images integer NOT NULL,
    queued_sets integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT illustration_backfill_jobs_estimated_images_check CHECK ((estimated_images >= 0)),
    CONSTRAINT illustration_backfill_jobs_estimated_segments_check CHECK ((estimated_segments >= 0)),
    CONSTRAINT illustration_backfill_jobs_estimated_turns_check CHECK ((estimated_turns >= 0)),
    CONSTRAINT illustration_backfill_jobs_mode_check CHECK ((mode = ANY (ARRAY['missing'::text, 'rebuild'::text]))),
    CONSTRAINT illustration_backfill_jobs_queued_sets_check CHECK ((queued_sets >= 0)),
    CONSTRAINT illustration_backfill_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'partial'::text, 'failed'::text])))
);

--
-- Name: illustration_match_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.illustration_match_candidates (
    resolution_job_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    rank integer NOT NULL,
    score numeric NOT NULL,
    score_components jsonb DEFAULT '{}'::jsonb NOT NULL,
    rejection_reasons text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT illustration_match_candidates_rank_check CHECK ((rank > 0))
);

--
-- Name: illustration_prompt_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.illustration_prompt_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    turn_id uuid,
    segment_id uuid NOT NULL,
    provider_profile_id uuid,
    requested_model text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    response_id text,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    prompt_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    generation_job_id uuid,
    text_execution_snapshot jsonb,
    text_plan_protocol smallint,
    CONSTRAINT illustration_prompt_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT illustration_prompt_jobs_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 10))),
    CONSTRAINT illustration_prompt_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'refining'::text, 'completed'::text, 'fallback'::text, 'recoverable'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT illustration_prompt_jobs_text_plan_protocol_check CHECK (((text_plan_protocol IS NULL) OR (text_plan_protocol = 2)))
);

--
-- Name: COLUMN illustration_prompt_jobs.prompt_snapshot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.illustration_prompt_jobs.prompt_snapshot IS 'Effective illustration refinement template captured at queue time.';

--
-- Name: illustration_resolution_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.illustration_resolution_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    turn_id uuid,
    source_policy text NOT NULL,
    matching_scope text NOT NULL,
    confidence_profile text NOT NULL,
    repetition_window integer DEFAULT 5 NOT NULL,
    query_context_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    selected_asset_id uuid,
    selected_score numeric,
    matching_algorithm_version text DEFAULT 'library-match-v1'::text CONSTRAINT illustration_resolution_job_matching_algorithm_version_not_null NOT NULL,
    resolved_threshold numeric,
    image_job_id uuid,
    reason_code text,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    segment_id uuid,
    CONSTRAINT illustration_resolution_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT illustration_resolution_jobs_confidence_profile_check CHECK ((confidence_profile = ANY (ARRAY['strict'::text, 'balanced'::text, 'broad'::text]))),
    CONSTRAINT illustration_resolution_jobs_matching_scope_check CHECK ((matching_scope = ANY (ARRAY['campaign'::text, 'world'::text, 'owner_library'::text, 'shared'::text]))),
    CONSTRAINT illustration_resolution_jobs_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 10))),
    CONSTRAINT illustration_resolution_jobs_repetition_window_check CHECK (((repetition_window >= 0) AND (repetition_window <= 100))),
    CONSTRAINT illustration_resolution_jobs_source_policy_check CHECK ((source_policy = ANY (ARRAY['library_only'::text, 'library_then_generate'::text]))),
    CONSTRAINT illustration_resolution_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'matching'::text, 'matched'::text, 'no_match'::text, 'generation_queued'::text, 'completed'::text, 'recoverable'::text, 'failed'::text, 'cancelled'::text])))
);

--
-- Name: COLUMN illustration_resolution_jobs.query_context_snapshot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.illustration_resolution_jobs.query_context_snapshot IS 'Bounded sanitized fiction-only matching context. Never contains mechanics or private orchestration.';

--
-- Name: image_job_asset_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_job_asset_publications (
    image_job_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    variant_index integer NOT NULL,
    finalization_locator text NOT NULL,
    safe_result jsonb NOT NULL,
    publication_state text DEFAULT 'committed_finalization_pending'::text NOT NULL,
    finalization_attempts integer DEFAULT 0 NOT NULL,
    last_diagnostic text,
    last_attempt_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT image_job_asset_publication_state_check CHECK ((((publication_state = 'committed_finalization_pending'::text) AND (published_at IS NULL)) OR ((publication_state = 'published'::text) AND (published_at IS NOT NULL) AND (last_diagnostic IS NULL)))),
    CONSTRAINT image_job_asset_publications_finalization_attempts_check CHECK ((finalization_attempts >= 0)),
    CONSTRAINT image_job_asset_publications_finalization_locator_check CHECK ((finalization_locator ~ '^narp1\.[0-9a-f]{64}\.[0-9a-f]{64}$'::text)),
    CONSTRAINT image_job_asset_publications_last_diagnostic_check CHECK (((last_diagnostic IS NULL) OR (last_diagnostic = 'asset_publication_finalization_recoverable'::text))),
    CONSTRAINT image_job_asset_publications_publication_state_check CHECK ((publication_state = ANY (ARRAY['committed_finalization_pending'::text, 'published'::text]))),
    CONSTRAINT image_job_asset_publications_safe_result_check CHECK ((jsonb_typeof(safe_result) = 'object'::text)),
    CONSTRAINT image_job_asset_publications_variant_index_check CHECK (((variant_index >= 0) AND (variant_index <= 1)))
);

--
-- Name: TABLE image_job_asset_publications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.image_job_asset_publications IS 'Private immutable image-job/variant to normalized request mapping. Its opaque locator contains no UUID, path, descriptor, bearer, or provider artifact URL.';

--
-- Name: image_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid,
    turn_id uuid,
    provider_profile_id uuid NOT NULL,
    requested_model text NOT NULL,
    prompt text NOT NULL,
    prompt_hash text NOT NULL,
    size text DEFAULT '1024x1024'::text NOT NULL,
    aspect_ratio text DEFAULT '1:1'::text NOT NULL,
    quality text DEFAULT 'auto'::text NOT NULL,
    output_format text DEFAULT 'png'::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    asset_id uuid,
    provider_response_id text,
    response_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    provider_type text NOT NULL,
    generation_revision integer DEFAULT 0 NOT NULL,
    remote_job_id text,
    provider_status text,
    provider_progress numeric(5,2),
    submitted_at timestamp with time zone,
    last_polled_at timestamp with time zone,
    next_poll_at timestamp with time zone,
    generation_deadline timestamp with time zone,
    provider_request_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    provider_result_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    usage_quantity numeric,
    usage_unit text,
    reported_cost numeric,
    reported_currency text,
    world_id uuid,
    target_type text DEFAULT 'turn_illustration'::text NOT NULL,
    provider_queue_position integer,
    provider_eta_at timestamp with time zone,
    segment_id uuid,
    image_count integer DEFAULT 1 NOT NULL,
    generation_job_id uuid,
    activity_revision bigint DEFAULT 0 NOT NULL,
    negative_prompt text DEFAULT ''::text NOT NULL,
    CONSTRAINT image_jobs_activity_revision_check CHECK ((activity_revision >= 0)),
    CONSTRAINT image_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT image_jobs_generation_revision_check CHECK ((generation_revision >= 0)),
    CONSTRAINT image_jobs_image_count_check CHECK (((image_count >= 1) AND (image_count <= 2))),
    CONSTRAINT image_jobs_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 10))),
    CONSTRAINT image_jobs_negative_prompt_check CHECK ((char_length(negative_prompt) <= 500)),
    CONSTRAINT image_jobs_output_format_check CHECK ((output_format = ANY (ARRAY['png'::text, 'jpeg'::text, 'webp'::text]))),
    CONSTRAINT image_jobs_provider_progress_check CHECK (((provider_progress >= (0)::numeric) AND (provider_progress <= (100)::numeric))),
    CONSTRAINT image_jobs_provider_queue_position_check CHECK ((provider_queue_position >= 0)),
    CONSTRAINT image_jobs_quality_check CHECK ((quality = ANY (ARRAY['auto'::text, 'low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT image_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'generating'::text, 'provider_pending'::text, 'downloading'::text, 'completed'::text, 'recoverable'::text, 'failed'::text, 'cancelled'::text, 'expired'::text]))),
    CONSTRAINT image_jobs_target_scope_check CHECK ((((target_type = 'turn_illustration'::text) AND (campaign_id IS NOT NULL) AND (turn_id IS NOT NULL) AND (world_id IS NULL)) OR ((target_type = 'world_cover'::text) AND (campaign_id IS NULL) AND (turn_id IS NULL) AND (world_id IS NOT NULL)) OR ((target_type = 'streaming_illustration'::text) AND (campaign_id IS NOT NULL) AND (turn_id IS NULL) AND (world_id IS NULL) AND (generation_job_id IS NOT NULL)))),
    CONSTRAINT image_jobs_target_type_check CHECK ((target_type = ANY (ARRAY['turn_illustration'::text, 'world_cover'::text, 'streaming_illustration'::text])))
);

--
-- Name: COLUMN image_jobs.prompt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.image_jobs.prompt IS 'Validated fiction-only illustration prompt copied from an accepted turn. Never contains mechanics or private orchestration.';

--
-- Name: COLUMN image_jobs.remote_job_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.image_jobs.remote_job_id IS 'Durable provider-side generation identifier. A worker must poll rather than resubmit whenever this is present.';

--
-- Name: COLUMN image_jobs.provider_request_metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.image_jobs.provider_request_metadata IS 'Sanitized, non-secret request lifecycle metadata. Never contains credentials or story-engine private reasoning.';

--
-- Name: COLUMN image_jobs.provider_result_metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.image_jobs.provider_result_metadata IS 'Sanitized provider result metadata. Temporary artifact URLs must be removed after assets are stored.';

--
-- Name: COLUMN image_jobs.target_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.image_jobs.target_type IS 'Authoritative image-job target. World covers use the default image provider and never require a campaign.';

--
-- Name: COLUMN image_jobs.provider_queue_position; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.image_jobs.provider_queue_position IS 'Best-effort provider queue position for user-visible image generation status.';

--
-- Name: COLUMN image_jobs.provider_eta_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.image_jobs.provider_eta_at IS 'Best-effort provider ETA. Durable completion never depends on this value.';

--
-- Name: import_progress_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_progress_status (
    owner_user_id uuid NOT NULL,
    lookup_key_hash text NOT NULL,
    status text NOT NULL,
    phase text NOT NULL,
    progress_percent double precision NOT NULL,
    message text NOT NULL,
    world_id uuid,
    world_version_id uuid,
    duplicate boolean,
    error_message text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT import_progress_status_error_message_check CHECK (((error_message IS NULL) OR ((length(btrim(error_message)) >= 1) AND (length(btrim(error_message)) <= 2000)))),
    CONSTRAINT import_progress_status_lookup_key_hash_check CHECK ((lookup_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT import_progress_status_message_check CHECK (((length(btrim(message)) >= 1) AND (length(btrim(message)) <= 2000))),
    CONSTRAINT import_progress_status_phase_check CHECK (((length(btrim(phase)) >= 1) AND (length(btrim(phase)) <= 200))),
    CONSTRAINT import_progress_status_progress_percent_check CHECK (((progress_percent >= (0)::double precision) AND (progress_percent <= (100)::double precision))),
    CONSTRAINT import_progress_status_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT import_progress_status_terminal_check CHECK ((((status = 'processing'::text) AND (progress_percent < (100)::double precision) AND (error_message IS NULL)) OR ((status = 'completed'::text) AND (progress_percent = (100)::double precision) AND (error_message IS NULL)) OR ((status = 'failed'::text) AND (progress_percent = (100)::double precision) AND (error_message IS NOT NULL))))
);

--
-- Name: imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.imports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    source_type text NOT NULL,
    source_name text DEFAULT ''::text NOT NULL,
    source_hash text NOT NULL,
    status text NOT NULL,
    world_id uuid,
    world_version_id uuid,
    campaign_id uuid,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT imports_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'completed'::text, 'failed'::text])))
);

--
-- Name: instance_settings_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instance_settings_events (
    id bigint NOT NULL,
    kind text NOT NULL,
    revision bigint NOT NULL,
    actor_user_id uuid NOT NULL,
    operator_session_id uuid,
    cli_reference text,
    maintenance_reference text,
    reason_code text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    changed_keys text[] DEFAULT '{}'::text[] NOT NULL,
    local_single_user boolean DEFAULT false NOT NULL,
    CONSTRAINT instance_settings_events_actor_check CHECK (((num_nonnulls(operator_session_id, cli_reference) + (local_single_user)::integer) = 1)),
    CONSTRAINT instance_settings_events_changed_keys CHECK (((cardinality(changed_keys) <= 43) AND (changed_keys <@ ARRAY['logLevel'::text, 'workerPollIntervalMs'::text, 'textProviderConcurrency'::text, 'archivePreviewTtlSeconds'::text, 'systemArchiveArtifactTtlSeconds'::text, 'systemArchiveUploadTtlSeconds'::text, 'systemArchiveChunkBytes'::text, 'aiAuthoringJobsEnabled'::text, 'aiStorySourceAuthoringEnabled'::text, 'castEditingEnabled'::text, 'castLifecycleEnabled'::text, 'castDiscoveryEnabled'::text, 'castAutoMatchEnabled'::text, 'castContextEnabled'::text, 'castPresetsEnabled'::text, 'castContextWithoutDiscoveryEnabled'::text, 'castBackfillEnabled'::text, 'worldSharingEnabled'::text, 'systemArchiveEnabled'::text, 'workerGenerationConcurrency'::text, 'apiDefaultBodyLimitBytes'::text, 'apiImportBodyLimitBytes'::text, 'apiAssetBodyLimitBytes'::text, 'apiRateLimitWindowSeconds'::text, 'apiRateLimitProviderRequests'::text, 'apiRateLimitGenerationRequests'::text, 'apiRateLimitImportRequests'::text, 'apiConcurrencyProviderRequests'::text, 'apiConcurrencyImportRequests'::text, 'campaignArchiveLimits.maxCompressedBytes'::text, 'campaignArchiveLimits.maxUncompressedBytes'::text, 'campaignArchiveLimits.maxEntries'::text, 'campaignArchiveLimits.maxExpansionRatio'::text, 'campaignArchiveLimits.maxManifestBytes'::text, 'campaignArchiveLimits.maxJsonEntryBytes'::text, 'campaignArchiveLimits.maxOriginalImageBytes'::text, 'systemArchiveLimits.maxCompressedBytes'::text, 'systemArchiveLimits.maxUncompressedBytes'::text, 'systemArchiveLimits.maxEntries'::text, 'systemArchiveLimits.maxExpansionRatio'::text, 'systemArchiveLimits.maxManifestBytes'::text, 'systemArchiveLimits.maxJsonEntryBytes'::text, 'systemArchiveLimits.maxOriginalImageBytes'::text]))),
    CONSTRAINT instance_settings_events_cli_reference_check CHECK (((length(cli_reference) >= 1) AND (length(cli_reference) <= 200))),
    CONSTRAINT instance_settings_events_kind_check CHECK ((kind = ANY (ARRAY['seed'::text, 'proposal'::text, 'rollback'::text, 'activation'::text, 'cancellation'::text]))),
    CONSTRAINT instance_settings_events_maintenance_reference_check CHECK (((length(maintenance_reference) >= 1) AND (length(maintenance_reference) <= 200))),
    CONSTRAINT instance_settings_events_reason_code_check CHECK (((length(reason_code) >= 1) AND (length(reason_code) <= 100)))
);

--
-- Name: instance_settings_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.instance_settings_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.instance_settings_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: instance_settings_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instance_settings_revisions (
    revision bigint NOT NULL,
    previous_revision bigint,
    snapshot jsonb NOT NULL,
    schema_version integer NOT NULL,
    actor_user_id uuid NOT NULL,
    operator_session_id uuid,
    cli_reference text,
    kind text NOT NULL,
    policy_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    local_single_user boolean DEFAULT false NOT NULL,
    CONSTRAINT instance_settings_revisions_actor_check CHECK (((num_nonnulls(operator_session_id, cli_reference) + (local_single_user)::integer) = 1)),
    CONSTRAINT instance_settings_revisions_check1 CHECK ((((revision = 1) AND (previous_revision IS NULL) AND (kind = 'seed'::text)) OR ((revision > 1) AND (previous_revision = (revision - 1)) AND (kind <> 'seed'::text)))),
    CONSTRAINT instance_settings_revisions_cli_reference_check CHECK (((length(cli_reference) >= 1) AND (length(cli_reference) <= 200))),
    CONSTRAINT instance_settings_revisions_kind_check CHECK ((kind = ANY (ARRAY['seed'::text, 'proposal'::text, 'rollback'::text]))),
    CONSTRAINT instance_settings_revisions_policy_digest_check CHECK ((policy_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT instance_settings_revisions_revision_check CHECK ((revision > 0)),
    CONSTRAINT instance_settings_revisions_schema_version_check CHECK ((schema_version = 1)),
    CONSTRAINT instance_settings_revisions_snapshot_check CHECK ((jsonb_typeof(snapshot) = 'object'::text))
);

--
-- Name: instance_settings_runtime_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instance_settings_runtime_reports (
    process_id uuid NOT NULL,
    role text NOT NULL,
    build_version text NOT NULL,
    protocol_version integer NOT NULL,
    active_revision bigint,
    policy_digest text NOT NULL,
    activation_epoch bigint NOT NULL,
    heartbeat_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    effective_configuration_digest text CONSTRAINT instance_settings_runtime_r_effective_configuration_di_not_null NOT NULL,
    readiness_state text NOT NULL,
    CONSTRAINT instance_settings_runtime_re_effective_configuration_dige_check CHECK ((effective_configuration_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT instance_settings_runtime_reports_activation_epoch_check CHECK ((activation_epoch >= 0)),
    CONSTRAINT instance_settings_runtime_reports_policy_digest_check CHECK ((policy_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT instance_settings_runtime_reports_protocol_version_check CHECK ((protocol_version > 0)),
    CONSTRAINT instance_settings_runtime_reports_readiness_state_check CHECK ((readiness_state = ANY (ARRAY['ready'::text, 'blocked'::text, 'stopping'::text]))),
    CONSTRAINT instance_settings_runtime_reports_role_check CHECK ((role = ANY (ARRAY['api'::text, 'worker'::text, 'all'::text])))
);

--
-- Name: instance_settings_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instance_settings_state (
    singleton boolean DEFAULT true NOT NULL,
    installation_id uuid,
    active_revision bigint,
    requested_revision bigint,
    schema_version integer DEFAULT 1 NOT NULL,
    mode text DEFAULT 'environment'::text NOT NULL,
    activation_epoch bigint DEFAULT 0 NOT NULL,
    seed_digest text,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT instance_settings_state_activation_epoch_check CHECK ((activation_epoch >= 0)),
    CONSTRAINT instance_settings_state_check CHECK ((((mode = 'environment'::text) AND (active_revision IS NULL)) OR ((mode = 'database'::text) AND (active_revision IS NOT NULL)))),
    CONSTRAINT instance_settings_state_check1 CHECK ((((requested_revision IS NULL) AND (installation_id IS NULL) AND (seed_digest IS NULL)) OR ((requested_revision IS NOT NULL) AND (installation_id IS NOT NULL) AND (seed_digest IS NOT NULL)))),
    CONSTRAINT instance_settings_state_mode_check CHECK ((mode = ANY (ARRAY['environment'::text, 'database'::text]))),
    CONSTRAINT instance_settings_state_schema_version_check CHECK ((schema_version = 1)),
    CONSTRAINT instance_settings_state_seed_digest_check CHECK ((seed_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT instance_settings_state_singleton_check CHECK (singleton)
);

--
-- Name: local_settings_restart_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_settings_restart_operations (
    id uuid NOT NULL,
    revision bigint NOT NULL,
    expected_active_revision bigint,
    expected_epoch bigint NOT NULL,
    status text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT local_settings_restart_operations_status_check CHECK ((status = ANY (ARRAY['draining'::text, 'restarting'::text, 'failed'::text, 'ready'::text])))
);

--
-- Name: model_chains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_chains (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    world_version_id uuid NOT NULL,
    provider_profile_id uuid NOT NULL,
    model text NOT NULL,
    endpoint_identity text NOT NULL,
    prompt_protocol_version text NOT NULL,
    context_fingerprint text NOT NULL,
    previous_response_id text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: portable_export_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portable_export_artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    retrieval_token_hash text NOT NULL,
    filesystem_operation_id uuid NOT NULL,
    filesystem_operation_purpose text GENERATED ALWAYS AS ('portable_export'::text) STORED,
    export_kind text NOT NULL,
    campaign_id uuid,
    world_id uuid,
    world_version_id uuid,
    content_type text NOT NULL,
    content_hash text NOT NULL,
    byte_length bigint NOT NULL,
    status text DEFAULT 'ready'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    policy_snapshot jsonb,
    CONSTRAINT portable_export_artifacts_byte_length_check CHECK ((byte_length >= 0)),
    CONSTRAINT portable_export_artifacts_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_export_artifacts_content_type_check CHECK ((content_type = ANY (ARRAY['application/zip'::text, 'application/json'::text]))),
    CONSTRAINT portable_export_artifacts_export_kind_check CHECK ((export_kind = ANY (ARRAY['campaign_zip'::text, 'world_json'::text, 'system_zip'::text]))),
    CONSTRAINT portable_export_artifacts_retrieval_token_hash_check CHECK ((retrieval_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_export_artifacts_status_check CHECK ((status = ANY (ARRAY['ready'::text, 'consumed'::text, 'expired'::text, 'failed'::text, 'cleanup_pending'::text, 'cleaned'::text]))),
    CONSTRAINT portable_export_scope_check CHECK ((((export_kind = 'campaign_zip'::text) AND (campaign_id IS NOT NULL) AND (world_id IS NOT NULL) AND (world_version_id IS NOT NULL) AND (content_type = 'application/zip'::text)) OR ((export_kind = 'world_json'::text) AND (campaign_id IS NULL) AND (world_id IS NOT NULL) AND (world_version_id IS NOT NULL) AND (content_type = 'application/json'::text)) OR ((export_kind = 'system_zip'::text) AND (campaign_id IS NULL) AND (world_id IS NULL) AND (world_version_id IS NULL) AND (content_type = 'application/zip'::text))))
);

--
-- Name: portable_import_asset_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portable_import_asset_publications (
    operation_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    import_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    request_id uuid NOT NULL
);

--
-- Name: portable_import_asset_reservation_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portable_import_asset_reservation_intents (
    operation_id uuid NOT NULL,
    owner_user_id uuid CONSTRAINT portable_import_asset_reservation_intent_owner_user_id_not_null NOT NULL,
    ordinal integer NOT NULL,
    asset_id uuid NOT NULL,
    commit_idempotency_key_hash text CONSTRAINT portable_import_asset_reser_commit_idempotency_key_has_not_null NOT NULL,
    command_fingerprint text CONSTRAINT portable_import_asset_reservation__command_fingerprint_not_null NOT NULL,
    asset_idempotency_key_hash text CONSTRAINT portable_import_asset_reser_asset_idempotency_key_hash_not_null NOT NULL,
    asset_request_fingerprint text CONSTRAINT portable_import_asset_reserv_asset_request_fingerprint_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    request_id uuid NOT NULL,
    CONSTRAINT portable_import_asset_reserva_commit_idempotency_key_hash_check CHECK ((commit_idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_import_asset_reservat_asset_idempotency_key_hash_check CHECK ((asset_idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_import_asset_reservati_asset_request_fingerprint_check CHECK ((asset_request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_import_asset_reservation_int_command_fingerprint_check CHECK ((command_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_import_asset_reservation_intents_ordinal_check CHECK (((ordinal >= 0) AND (ordinal < 1000)))
);

--
-- Name: portable_import_normalized_asset_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portable_import_normalized_asset_contexts (
    operation_id uuid NOT NULL,
    owner_user_id uuid CONSTRAINT portable_import_normalized_asset_context_owner_user_id_not_null NOT NULL,
    asset_ordinal integer CONSTRAINT portable_import_normalized_asset_context_asset_ordinal_not_null NOT NULL,
    intent_key text NOT NULL,
    context_snapshot jsonb CONSTRAINT portable_import_normalized_asset_cont_context_snapshot_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT portable_import_normalized_asset_context_context_snapshot_check CHECK ((jsonb_typeof(context_snapshot) = 'object'::text)),
    CONSTRAINT portable_import_normalized_asset_contexts_intent_key_check CHECK (((length(intent_key) >= 1) AND (length(intent_key) <= 500)))
);

--
-- Name: portable_import_normalized_asset_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portable_import_normalized_asset_publications (
    operation_id uuid CONSTRAINT portable_import_normalized_asset_publicat_operation_id_not_null NOT NULL,
    owner_user_id uuid CONSTRAINT portable_import_normalized_asset_publica_owner_user_id_not_null NOT NULL,
    asset_ordinal integer CONSTRAINT portable_import_normalized_asset_publica_asset_ordinal_not_null NOT NULL,
    import_kind text CONSTRAINT portable_import_normalized_asset_publicati_import_kind_not_null NOT NULL,
    authority_fingerprint text CONSTRAINT portable_import_normalized_asset_authority_fingerprint_not_null NOT NULL,
    commit_idempotency_key_hash text CONSTRAINT portable_import_normalized__commit_idempotency_key_has_not_null NOT NULL,
    request_fingerprint text CONSTRAINT portable_import_normalized_asset_p_request_fingerprint_not_null NOT NULL,
    request_idempotency_key_hash text CONSTRAINT portable_import_normalized__request_idempotency_key_ha_not_null NOT NULL,
    request_id uuid,
    import_id uuid,
    finalization_locator text,
    safe_result jsonb,
    publication_state text DEFAULT 'reservation_intent'::text CONSTRAINT portable_import_normalized_asset_pub_publication_state_not_null NOT NULL,
    retirement_reason text,
    retirement_requested_at timestamp with time zone,
    retired_at timestamp with time zone,
    finalization_attempts integer DEFAULT 0 CONSTRAINT portable_import_normalized_asset_finalization_attempts_not_null NOT NULL,
    last_diagnostic text,
    last_attempt_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT portable_import_normalized_asset_publicatio_created_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT portable_import_normalized_asset_publicatio_updated_at_not_null NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT portable_import_normalized_a_request_idempotency_key_hash_check CHECK ((request_idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_import_normalized_as_commit_idempotency_key_hash_check CHECK ((commit_idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_import_normalized_asset_pu_authority_fingerprint_check CHECK ((authority_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_import_normalized_asset_pu_finalization_attempts_check CHECK ((finalization_attempts >= 0)),
    CONSTRAINT portable_import_normalized_asset_pub_finalization_locator_check CHECK (((finalization_locator IS NULL) OR (finalization_locator ~ '^narp1\.[0-9a-f]{64}\.[0-9a-f]{64}$'::text))),
    CONSTRAINT portable_import_normalized_asset_publ_request_fingerprint_check CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_import_normalized_asset_public_publication_state_check CHECK ((publication_state = ANY (ARRAY['reservation_intent'::text, 'reserved'::text, 'retirement_pending'::text, 'retired'::text, 'committed_finalization_pending'::text, 'published'::text]))),
    CONSTRAINT portable_import_normalized_asset_public_retirement_reason_check CHECK (((retirement_reason IS NULL) OR (retirement_reason = ANY (ARRAY['duplicate'::text, 'abandoned'::text, 'optional_unavailable'::text])))),
    CONSTRAINT portable_import_normalized_asset_publicat_last_diagnostic_check CHECK (((last_diagnostic IS NULL) OR (last_diagnostic = 'asset_publication_finalization_recoverable'::text))),
    CONSTRAINT portable_import_normalized_asset_publicatio_asset_ordinal_check CHECK (((asset_ordinal >= 0) AND (asset_ordinal < 1000))),
    CONSTRAINT portable_import_normalized_asset_publication_state_check CHECK ((((publication_state = 'reservation_intent'::text) AND (request_id IS NULL) AND (import_id IS NULL) AND (finalization_locator IS NULL) AND (safe_result IS NULL) AND (published_at IS NULL) AND (retirement_reason IS NULL) AND (retirement_requested_at IS NULL) AND (retired_at IS NULL)) OR ((publication_state = 'reserved'::text) AND (request_id IS NOT NULL) AND (import_id IS NULL) AND (finalization_locator IS NULL) AND (safe_result IS NULL) AND (published_at IS NULL) AND (retirement_reason IS NULL) AND (retirement_requested_at IS NULL) AND (retired_at IS NULL)) OR ((publication_state = 'retirement_pending'::text) AND (import_id IS NULL) AND (finalization_locator IS NULL) AND (safe_result IS NULL) AND (published_at IS NULL) AND (retirement_reason IS NOT NULL) AND ((retirement_reason <> 'duplicate'::text) OR (request_id IS NOT NULL)) AND (retirement_requested_at IS NOT NULL) AND (retired_at IS NULL)) OR ((publication_state = 'retired'::text) AND (import_id IS NULL) AND (finalization_locator IS NULL) AND (safe_result IS NULL) AND (published_at IS NULL) AND (retirement_reason IS NOT NULL) AND ((retirement_reason <> 'duplicate'::text) OR (request_id IS NOT NULL)) AND (retirement_requested_at IS NOT NULL) AND (retired_at IS NOT NULL)) OR ((publication_state = 'committed_finalization_pending'::text) AND (request_id IS NOT NULL) AND (import_id IS NOT NULL) AND (finalization_locator IS NOT NULL) AND (safe_result IS NOT NULL) AND (published_at IS NULL) AND (retirement_reason IS NULL) AND (retirement_requested_at IS NULL) AND (retired_at IS NULL)) OR ((publication_state = 'published'::text) AND (request_id IS NOT NULL) AND (import_id IS NOT NULL) AND (finalization_locator IS NOT NULL) AND (safe_result IS NOT NULL) AND (published_at IS NOT NULL) AND (last_diagnostic IS NULL) AND (retirement_reason IS NULL) AND (retirement_requested_at IS NULL) AND (retired_at IS NULL)))),
    CONSTRAINT portable_import_normalized_asset_publications_import_kind_check CHECK ((import_kind = ANY (ARRAY['campaign_zip'::text, 'legacy_story'::text]))),
    CONSTRAINT portable_import_normalized_asset_publications_safe_result_check CHECK (((safe_result IS NULL) OR (jsonb_typeof(safe_result) = 'object'::text)))
);

--
-- Name: TABLE portable_import_normalized_asset_publications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portable_import_normalized_asset_publications IS 'Private operation-owned prewrite intent and immutable portable import to normalized 0064 request/result mapping. Contains no path, descriptor, bearer, external URL, or caller ownership input.';

--
-- Name: portable_import_normalized_asset_references; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portable_import_normalized_asset_references (
    operation_id uuid CONSTRAINT portable_import_normalized_asset_referenc_operation_id_not_null NOT NULL,
    owner_user_id uuid CONSTRAINT portable_import_normalized_asset_referen_owner_user_id_not_null NOT NULL,
    asset_ordinal integer CONSTRAINT portable_import_normalized_asset_referen_asset_ordinal_not_null NOT NULL,
    intent_key text NOT NULL,
    reference_snapshot jsonb CONSTRAINT portable_import_normalized_asset_re_reference_snapshot_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT portable_import_normalized_asset_refer_reference_snapshot_check CHECK ((jsonb_typeof(reference_snapshot) = 'object'::text)),
    CONSTRAINT portable_import_normalized_asset_references_intent_key_check CHECK (((length(intent_key) >= 1) AND (length(intent_key) <= 500)))
);

--
-- Name: portable_import_normalized_asset_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portable_import_normalized_asset_sources (
    operation_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    asset_ordinal integer NOT NULL,
    source_ordinal integer CONSTRAINT portable_import_normalized_asset_source_source_ordinal_not_null NOT NULL,
    source_kind text NOT NULL,
    source_asset_id text CONSTRAINT portable_import_normalized_asset_sourc_source_asset_id_not_null NOT NULL,
    source_record_id text,
    source_key text,
    requested_library_snapshot jsonb CONSTRAINT portable_import_normalized__requested_library_snapshot_not_null NOT NULL,
    binding_intent_keys jsonb DEFAULT '[]'::jsonb CONSTRAINT portable_import_normalized_asset_s_binding_intent_keys_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT portable_import_normalized_ass_requested_library_snapshot_check CHECK ((jsonb_typeof(requested_library_snapshot) = 'object'::text)),
    CONSTRAINT portable_import_normalized_asset_sour_binding_intent_keys_check CHECK ((jsonb_typeof(binding_intent_keys) = 'array'::text)),
    CONSTRAINT portable_import_normalized_asset_sources_source_asset_id_check CHECK ((source_asset_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)),
    CONSTRAINT portable_import_normalized_asset_sources_source_key_check CHECK (((source_key IS NULL) OR (source_key ~ '^source-key-sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT portable_import_normalized_asset_sources_source_kind_check CHECK ((source_kind = ANY (ARRAY['campaign_zip'::text, 'legacy_story'::text]))),
    CONSTRAINT portable_import_normalized_asset_sources_source_ordinal_check CHECK (((source_ordinal >= 0) AND (source_ordinal < 1000))),
    CONSTRAINT portable_import_normalized_asset_sources_source_record_id_check CHECK (((source_record_id IS NULL) OR (source_record_id ~ '^[0-9a-f]{64}$'::text)))
);

--
-- Name: portable_import_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portable_import_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    staged_input_id uuid NOT NULL,
    import_kind text NOT NULL,
    preview_token_hash text NOT NULL,
    result_retrieval_token_hash text,
    content_fingerprint text NOT NULL,
    destination_fingerprint text NOT NULL,
    destination_kind text NOT NULL,
    destination_world_id uuid,
    destination_world_version_id uuid,
    source_installation_id text,
    source_record_id text,
    status text DEFAULT 'previewed'::text NOT NULL,
    preview_projection jsonb NOT NULL,
    diagnostic_codes text[] DEFAULT '{}'::text[] NOT NULL,
    idempotency_key_hash text,
    commit_request_fingerprint text,
    import_id uuid,
    result_projection jsonb,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    normalized_payload jsonb,
    authority_fingerprint text,
    provider_configuration_fingerprint text,
    selected_character_id text,
    policy_snapshot jsonb,
    CONSTRAINT portable_import_commit_check CHECK ((((status = 'committed'::text) AND (idempotency_key_hash IS NOT NULL) AND (result_retrieval_token_hash IS NOT NULL) AND (import_id IS NOT NULL) AND (result_projection IS NOT NULL) AND (completed_at IS NOT NULL)) OR (status <> 'committed'::text))),
    CONSTRAINT portable_import_destination_scope_check CHECK ((((destination_kind = 'existing_world_version'::text) AND (destination_world_id IS NOT NULL) AND (destination_world_version_id IS NOT NULL)) OR ((destination_kind = ANY (ARRAY['embedded_create_world'::text, 'create_world'::text])) AND (destination_world_id IS NULL) AND (destination_world_version_id IS NULL)))),
    CONSTRAINT portable_import_idempotency_check CHECK ((((idempotency_key_hash IS NULL) AND (commit_request_fingerprint IS NULL)) OR ((idempotency_key_hash IS NOT NULL) AND (commit_request_fingerprint IS NOT NULL)))),
    CONSTRAINT portable_import_kind_destination_check CHECK ((((import_kind = 'campaign_zip'::text) AND (destination_kind = ANY (ARRAY['embedded_create_world'::text, 'existing_world_version'::text]))) OR ((import_kind = 'legacy_story'::text) AND (destination_kind = ANY (ARRAY['create_world'::text, 'existing_world_version'::text]))) OR ((import_kind = 'story_text'::text) AND (destination_kind = 'existing_world_version'::text)) OR ((import_kind = ANY (ARRAY['infinite_worlds'::text, 'cyoa'::text, 'world_json'::text, 'world_text'::text])) AND (destination_kind = 'create_world'::text)))),
    CONSTRAINT portable_import_normalized_payload_safe_check CHECK (((normalized_payload IS NULL) OR public.portable_import_normalized_payload_is_safe(normalized_payload))),
    CONSTRAINT portable_import_operations_authority_fingerprint_check CHECK (((authority_fingerprint IS NULL) OR (authority_fingerprint ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT portable_import_operations_commit_request_fingerprint_check CHECK (((commit_request_fingerprint IS NULL) OR (commit_request_fingerprint ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT portable_import_operations_content_fingerprint_check CHECK ((content_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_import_operations_destination_fingerprint_check CHECK ((destination_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_import_operations_destination_kind_check CHECK ((destination_kind = ANY (ARRAY['embedded_create_world'::text, 'existing_world_version'::text, 'create_world'::text]))),
    CONSTRAINT portable_import_operations_diagnostic_codes_check CHECK (((array_position(diagnostic_codes, NULL::text) IS NULL) AND (diagnostic_codes <@ ARRAY['archive_cleanup_required'::text, 'archive_containment_denied'::text, 'archive_entry_limit_exceeded'::text, 'archive_expired'::text, 'archive_format_invalid'::text, 'archive_link_denied'::text, 'archive_path_invalid'::text, 'archive_size_limit_exceeded'::text, 'archive_truncated'::text, 'archive_unavailable'::text, 'import_conflict'::text, 'import_idempotency_mismatch'::text, 'import_invalid'::text, 'transaction_unavailable'::text]))),
    CONSTRAINT portable_import_operations_idempotency_key_hash_check CHECK (((idempotency_key_hash IS NULL) OR (idempotency_key_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT portable_import_operations_import_kind_check CHECK ((import_kind = ANY (ARRAY['campaign_zip'::text, 'legacy_story'::text, 'infinite_worlds'::text, 'cyoa'::text, 'world_json'::text, 'world_text'::text, 'story_text'::text]))),
    CONSTRAINT portable_import_operations_preview_token_hash_check CHECK ((preview_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_import_operations_provider_configuration_fingerp_check CHECK (((provider_configuration_fingerprint IS NULL) OR (provider_configuration_fingerprint ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT portable_import_operations_result_retrieval_token_hash_check CHECK (((result_retrieval_token_hash IS NULL) OR (result_retrieval_token_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT portable_import_operations_selected_character_id_check CHECK (((selected_character_id IS NULL) OR ((length(selected_character_id) >= 1) AND (length(selected_character_id) <= 512)))),
    CONSTRAINT portable_import_operations_status_check CHECK ((status = ANY (ARRAY['previewed'::text, 'superseded'::text, 'consuming'::text, 'committed'::text, 'expired'::text, 'failed'::text, 'cleanup_pending'::text, 'cleaned'::text]))),
    CONSTRAINT portable_import_private_authority_check CHECK ((((normalized_payload IS NULL) AND (authority_fingerprint IS NULL)) OR ((normalized_payload IS NOT NULL) AND (jsonb_typeof(normalized_payload) = 'object'::text) AND (octet_length((normalized_payload)::text) <= 16777216) AND (authority_fingerprint IS NOT NULL))))
);

--
-- Name: COLUMN portable_import_operations.source_installation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.portable_import_operations.source_installation_id IS 'Opaque source provenance only. It is never a local owner or authorization key.';

--
-- Name: COLUMN portable_import_operations.source_record_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.portable_import_operations.source_record_id IS 'Opaque source-record provenance only. It is never a local foreign key or authorization key.';

--
-- Name: portable_import_work; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portable_import_work (
    operation_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    phase text DEFAULT 'previewed'::text NOT NULL,
    percentage smallint DEFAULT 20 NOT NULL,
    diagnostic_code text,
    status text DEFAULT 'running'::text NOT NULL,
    work_version integer DEFAULT 1 NOT NULL,
    lease_id uuid,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    terminal_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT portable_import_work_diagnostic_code_check CHECK (((diagnostic_code IS NULL) OR (diagnostic_code = ANY (ARRAY['archive_cleanup_required'::text, 'archive_containment_denied'::text, 'archive_entry_limit_exceeded'::text, 'archive_expired'::text, 'archive_format_invalid'::text, 'archive_link_denied'::text, 'archive_path_invalid'::text, 'archive_size_limit_exceeded'::text, 'archive_truncated'::text, 'archive_unavailable'::text, 'import_conflict'::text, 'import_idempotency_mismatch'::text, 'import_invalid'::text, 'transaction_unavailable'::text])))),
    CONSTRAINT portable_import_work_lease_check CHECK ((((lease_id IS NULL) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_id IS NOT NULL) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT portable_import_work_lease_owner_check CHECK (((lease_owner IS NULL) OR ((length(lease_owner) >= 1) AND (length(lease_owner) <= 512)))),
    CONSTRAINT portable_import_work_percentage_check CHECK (((percentage >= 0) AND (percentage <= 100))),
    CONSTRAINT portable_import_work_phase_check CHECK ((phase = ANY (ARRAY['staged'::text, 'decoding'::text, 'previewed'::text, 'claiming'::text, 'mutating'::text, 'publishing_assets'::text, 'committing'::text, 'finalizing'::text, 'completed'::text]))),
    CONSTRAINT portable_import_work_status_check CHECK ((status = ANY (ARRAY['running'::text, 'recoverable'::text, 'aborted'::text, 'completed'::text, 'expired'::text]))),
    CONSTRAINT portable_import_work_terminal_check CHECK ((((status = ANY (ARRAY['running'::text, 'recoverable'::text])) AND (terminal_at IS NULL)) OR ((status = ANY (ARRAY['aborted'::text, 'completed'::text, 'expired'::text])) AND (terminal_at IS NOT NULL)))),
    CONSTRAINT portable_import_work_work_version_check CHECK ((work_version > 0))
);

--
-- Name: portable_staged_inputs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portable_staged_inputs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    handle_token_hash text NOT NULL,
    filesystem_operation_id uuid NOT NULL,
    filesystem_operation_purpose text GENERATED ALWAYS AS ('portable_staging'::text) STORED,
    status text DEFAULT 'staged'::text NOT NULL,
    content_hash text NOT NULL,
    byte_length bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT portable_staged_consumption_check CHECK ((((status = 'staged'::text) AND (consumed_at IS NULL)) OR (status = ANY (ARRAY['expired'::text, 'failed'::text, 'cleanup_pending'::text, 'cleaned'::text])) OR ((status = 'consumed'::text) AND (consumed_at IS NOT NULL)))),
    CONSTRAINT portable_staged_inputs_byte_length_check CHECK ((byte_length >= 0)),
    CONSTRAINT portable_staged_inputs_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_staged_inputs_handle_token_hash_check CHECK ((handle_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT portable_staged_inputs_status_check CHECK ((status = ANY (ARRAY['staged'::text, 'consumed'::text, 'expired'::text, 'failed'::text, 'cleanup_pending'::text, 'cleaned'::text])))
);

--
-- Name: private_filesystem_delivery_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.private_filesystem_delivery_grants (
    grant_token_hash text NOT NULL,
    candidate_token_hash text CONSTRAINT private_filesystem_delivery_grant_candidate_token_hash_not_null NOT NULL,
    operation_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    purpose text NOT NULL,
    resource_kind text NOT NULL,
    asset_id uuid,
    operation_scope_hash text,
    descriptor_role text GENERATED ALWAYS AS ('delivery'::text) STORED,
    descriptor_ordinal integer GENERATED ALWAYS AS (0) STORED,
    lifecycle text DEFAULT 'issued'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    redeemed_at timestamp with time zone,
    expired_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT private_delivery_grant_completion_check CHECK ((((lifecycle = 'issued'::text) AND (redeemed_at IS NULL) AND (expired_at IS NULL) AND (revoked_at IS NULL)) OR ((lifecycle = 'redeemed'::text) AND (redeemed_at IS NOT NULL) AND (expired_at IS NULL) AND (revoked_at IS NULL)) OR ((lifecycle = 'expired'::text) AND (redeemed_at IS NULL) AND (expired_at IS NOT NULL) AND (revoked_at IS NULL)) OR ((lifecycle = 'revoked'::text) AND (redeemed_at IS NULL) AND (expired_at IS NULL) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT private_delivery_grant_scope_check CHECK ((((resource_kind = 'asset'::text) AND (purpose = ANY (ARRAY['asset_original'::text, 'asset_derivative'::text])) AND (asset_id IS NOT NULL) AND (operation_scope_hash IS NULL)) OR ((resource_kind = 'portable'::text) AND (purpose = ANY (ARRAY['portable_staging'::text, 'portable_export'::text])) AND (asset_id IS NULL) AND (operation_scope_hash IS NOT NULL)))),
    CONSTRAINT private_filesystem_delivery_grants_candidate_token_hash_check CHECK ((candidate_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT private_filesystem_delivery_grants_grant_token_hash_check CHECK ((grant_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT private_filesystem_delivery_grants_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['issued'::text, 'redeemed'::text, 'expired'::text, 'revoked'::text]))),
    CONSTRAINT private_filesystem_delivery_grants_operation_scope_hash_check CHECK (((operation_scope_hash IS NULL) OR (operation_scope_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT private_filesystem_delivery_grants_purpose_check CHECK ((purpose = ANY (ARRAY['asset_original'::text, 'asset_derivative'::text, 'portable_staging'::text, 'portable_export'::text]))),
    CONSTRAINT private_filesystem_delivery_grants_resource_kind_check CHECK ((resource_kind = ANY (ARRAY['asset'::text, 'portable'::text])))
);

--
-- Name: prompt_template_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_template_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid,
    prompt_key text NOT NULL,
    content text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    compatibility_required_shape_version text,
    compatibility_content_hash text,
    compatibility_acknowledged_at timestamp with time zone,
    compatibility_protocol_identity text,
    CONSTRAINT prompt_template_overrides_compatibility_metadata_check CHECK ((((compatibility_required_shape_version IS NULL) AND (compatibility_protocol_identity IS NULL) AND (compatibility_content_hash IS NULL) AND (compatibility_acknowledged_at IS NULL)) OR ((compatibility_required_shape_version IS NOT NULL) AND (compatibility_protocol_identity IS NOT NULL) AND (compatibility_content_hash IS NOT NULL) AND (compatibility_content_hash ~ '^[a-f0-9]{64}$'::text) AND (compatibility_acknowledged_at IS NOT NULL)))),
    CONSTRAINT prompt_template_overrides_content_check CHECK (((char_length(btrim(content)) > 0) AND (char_length(content) <=
CASE
    WHEN (prompt_key = 'story_system'::text) THEN 64000
    ELSE 16000
END)))
);

--
-- Name: TABLE prompt_template_overrides; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.prompt_template_overrides IS 'User-owned application defaults and campaign-specific overrides for application-owned LLM instruction templates.';

--
-- Name: provider_cost_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_cost_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    turn_id uuid,
    provider_profile_id uuid,
    generation_job_id uuid,
    image_job_id uuid,
    chronicle_job_id uuid,
    local_call_id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_type text NOT NULL,
    provider_response_id text,
    category text NOT NULL,
    operation text NOT NULL,
    requested_model text DEFAULT ''::text NOT NULL,
    resolved_model text DEFAULT ''::text NOT NULL,
    amount numeric NOT NULL,
    currency text NOT NULL,
    usage_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_cost_events_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT provider_cost_events_category_check CHECK ((category = ANY (ARRAY['story'::text, 'image'::text, 'memory'::text]))),
    CONSTRAINT provider_cost_events_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text))
);

--
-- Name: TABLE provider_cost_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.provider_cost_events IS 'Append-only provider-reported campaign charges. Missing provider cost data never creates a row.';

--
-- Name: provider_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    name text NOT NULL,
    provider_type text NOT NULL,
    provider_role text DEFAULT 'text'::text NOT NULL,
    base_url text NOT NULL,
    default_model text DEFAULT ''::text NOT NULL,
    context_window_tokens integer DEFAULT 32768 NOT NULL,
    max_output_tokens integer DEFAULT 4096 NOT NULL,
    temperature real DEFAULT 0.8 NOT NULL,
    configuration jsonb DEFAULT '{}'::jsonb NOT NULL,
    encrypted_api_key text,
    credential_nonce text,
    credential_auth_tag text,
    credential_key_version integer,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    health_status text DEFAULT 'unknown'::text NOT NULL,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    last_health_check_at timestamp with time zone,
    last_health_error text,
    is_default boolean DEFAULT false NOT NULL,
    request_timeout_ms integer DEFAULT 300000 NOT NULL,
    text_selection jsonb,
    CONSTRAINT provider_profiles_check CHECK ((((encrypted_api_key IS NULL) AND (credential_nonce IS NULL) AND (credential_auth_tag IS NULL) AND (credential_key_version IS NULL)) OR ((encrypted_api_key IS NOT NULL) AND (credential_nonce IS NOT NULL) AND (credential_auth_tag IS NOT NULL) AND (credential_key_version IS NOT NULL)))),
    CONSTRAINT provider_profiles_consecutive_failures_check CHECK ((consecutive_failures >= 0)),
    CONSTRAINT provider_profiles_context_window_tokens_check CHECK (((context_window_tokens >= 1024) AND (context_window_tokens <= 4000000))),
    CONSTRAINT provider_profiles_health_status_check CHECK ((health_status = ANY (ARRAY['unknown'::text, 'healthy'::text, 'degraded'::text, 'unavailable'::text]))),
    CONSTRAINT provider_profiles_max_output_tokens_check CHECK (((max_output_tokens >= 128) AND (max_output_tokens <= 262144))),
    CONSTRAINT provider_profiles_provider_role_check CHECK ((provider_role = ANY (ARRAY['text'::text, 'image'::text, 'embedding'::text, 'intent'::text]))),
    CONSTRAINT provider_profiles_provider_type_check CHECK ((provider_type = ANY (ARRAY['lmstudio'::text, 'openrouter'::text, 'manifest'::text, 'openai_compatible'::text, 'sogni'::text, 'sogni_sdk'::text]))),
    CONSTRAINT provider_profiles_request_timeout_ms_check CHECK (((request_timeout_ms >= 5000) AND (request_timeout_ms <= 3600000))),
    CONSTRAINT provider_profiles_temperature_check CHECK (((temperature >= (0)::double precision) AND (temperature <= (2)::double precision))),
    CONSTRAINT provider_profiles_text_selection_shape_check CHECK (((text_selection IS NULL) OR ((jsonb_typeof(text_selection) = 'object'::text) AND ((((text_selection ->> 'kind'::text) = 'model'::text) AND (text_selection ? 'modelId'::text) AND (jsonb_typeof((text_selection -> 'modelId'::text)) = 'string'::text)) OR (((text_selection ->> 'kind'::text) = 'openrouter_preset'::text) AND (text_selection ? 'slug'::text) AND (jsonb_typeof((text_selection -> 'slug'::text)) = 'string'::text) AND ((text_selection ->> 'slug'::text) ~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'::text))))))
);

--
-- Name: COLUMN provider_profiles.provider_role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.provider_profiles.provider_role IS 'Provider purpose. Intent providers only classify Auto turn input and never generate story narration.';

--
-- Name: COLUMN provider_profiles.request_timeout_ms; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.provider_profiles.request_timeout_ms IS 'Overall provider HTTP request deadline in milliseconds. Defaults to five minutes.';

--
-- Name: settings_operator_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings_operator_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_user_id uuid NOT NULL,
    token_digest text NOT NULL,
    csrf_digest text NOT NULL,
    key_fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT settings_operator_sessions_check CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:15:00'::interval)))),
    CONSTRAINT settings_operator_sessions_csrf_digest_check CHECK ((csrf_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT settings_operator_sessions_key_fingerprint_check CHECK ((key_fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT settings_operator_sessions_token_digest_check CHECK ((token_digest ~ '^[a-f0-9]{64}$'::text))
);

--
-- Name: settings_unlock_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings_unlock_attempts (
    bucket text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    attempts integer NOT NULL,
    CONSTRAINT settings_unlock_attempts_attempts_check CHECK (((attempts >= 1) AND (attempts <= 1001)))
);

--
-- Name: story_activity_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_activity_events (
    event_id uuid NOT NULL,
    sequence bigint NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    published_at timestamp with time zone NOT NULL,
    source text NOT NULL,
    kind text NOT NULL,
    severity text NOT NULL,
    job_id uuid,
    generation_job_id uuid,
    segment_id uuid,
    turn_id uuid,
    snapshot jsonb NOT NULL,
    CONSTRAINT story_activity_events_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT story_activity_events_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'error'::text, 'success'::text]))),
    CONSTRAINT story_activity_events_snapshot_check CHECK ((jsonb_typeof(snapshot) = 'object'::text)),
    CONSTRAINT story_activity_events_source_check CHECK ((source = ANY (ARRAY['generation'::text, 'image'::text, 'illustration_segment'::text])))
);

--
-- Name: story_activity_events_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.story_activity_events_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: story_activity_events_sequence_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.story_activity_events_sequence_seq OWNED BY public.story_activity_events.sequence;

--
-- Name: summary_checkpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.summary_checkpoints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    through_turn integer DEFAULT 0 NOT NULL,
    summary_kind text NOT NULL,
    content jsonb NOT NULL,
    token_estimate integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: system_archive_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_archive_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    idempotency_key_hash text NOT NULL,
    staged_input_id uuid,
    export_artifact_id uuid,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    report jsonb,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    policy_snapshot jsonb,
    CONSTRAINT system_archive_jobs_idempotency_key_hash_check CHECK ((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT system_archive_jobs_kind_check CHECK ((kind = ANY (ARRAY['export'::text, 'import'::text]))),
    CONSTRAINT system_archive_jobs_kind_status_check CHECK ((((kind = 'export'::text) AND (status = ANY (ARRAY['queued'::text, 'capturing'::text, 'writing'::text, 'verifying'::text, 'published'::text, 'cancelling'::text, 'cancelled'::text, 'failed'::text, 'expired'::text]))) OR ((kind = 'import'::text) AND (status = ANY (ARRAY['queued'::text, 'uploading'::text, 'validating'::text, 'previewed'::text, 'revalidating'::text, 'waiting_for_gate'::text, 'importing'::text, 'authoritative_committed'::text, 'rebuilding'::text, 'completed'::text, 'cancelling'::text, 'cancelled'::text, 'rolled_back'::text, 'failed'::text, 'expired'::text]))))),
    CONSTRAINT system_archive_jobs_lease_check CHECK ((((status = ANY (ARRAY['capturing'::text, 'writing'::text, 'verifying'::text, 'uploading'::text, 'validating'::text, 'revalidating'::text, 'importing'::text, 'authoritative_committed'::text, 'rebuilding'::text])) AND (lease_owner IS NOT NULL) AND (btrim(lease_owner) <> ''::text) AND (lease_expires_at IS NOT NULL)) OR ((status = 'cancelling'::text) AND (((lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (btrim(lease_owner) <> ''::text) AND (lease_expires_at IS NOT NULL)))) OR ((status = ANY (ARRAY['queued'::text, 'previewed'::text, 'waiting_for_gate'::text, 'published'::text, 'completed'::text, 'cancelled'::text, 'rolled_back'::text, 'failed'::text, 'expired'::text])) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT system_archive_jobs_progress_check CHECK ((jsonb_typeof(progress) = 'object'::text)),
    CONSTRAINT system_archive_jobs_published_artifact_check CHECK (((kind <> 'export'::text) OR (status <> 'published'::text) OR (export_artifact_id IS NOT NULL))),
    CONSTRAINT system_archive_jobs_report_check CHECK (((report IS NULL) OR (jsonb_typeof(report) = 'object'::text))),
    CONSTRAINT system_archive_jobs_resource_scope_check CHECK ((((kind = 'export'::text) AND (staged_input_id IS NULL)) OR ((kind = 'import'::text) AND (staged_input_id IS NOT NULL) AND (export_artifact_id IS NULL)))),
    CONSTRAINT system_archive_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'capturing'::text, 'writing'::text, 'verifying'::text, 'published'::text, 'uploading'::text, 'validating'::text, 'previewed'::text, 'revalidating'::text, 'waiting_for_gate'::text, 'importing'::text, 'authoritative_committed'::text, 'rebuilding'::text, 'completed'::text, 'cancelling'::text, 'cancelled'::text, 'rolled_back'::text, 'failed'::text, 'expired'::text])))
);

--
-- Name: system_archive_upload_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_archive_upload_chunks (
    upload_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    filesystem_operation_id uuid NOT NULL,
    filesystem_operation_purpose text GENERATED ALWAYS AS ('portable_staging'::text) STORED,
    chunk_index integer NOT NULL,
    byte_offset bigint NOT NULL,
    byte_length bigint NOT NULL,
    content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT system_archive_upload_chunks_byte_length_check CHECK (((byte_length > 0) AND (byte_length <= '9007199254740991'::bigint))),
    CONSTRAINT system_archive_upload_chunks_byte_offset_check CHECK (((byte_offset >= 0) AND (byte_offset <= '9007199254740991'::bigint))),
    CONSTRAINT system_archive_upload_chunks_chunk_index_check CHECK ((chunk_index >= 0)),
    CONSTRAINT system_archive_upload_chunks_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text))
);

--
-- Name: system_archive_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_archive_uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    handle_token_hash text NOT NULL,
    filesystem_operation_id uuid NOT NULL,
    filesystem_operation_purpose text GENERATED ALWAYS AS ('portable_staging'::text) STORED,
    status text DEFAULT 'created'::text NOT NULL,
    byte_length bigint NOT NULL,
    received_bytes bigint DEFAULT 0 NOT NULL,
    content_hash text NOT NULL,
    staged_input_id uuid,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    policy_snapshot jsonb,
    CONSTRAINT system_archive_uploads_byte_length_check CHECK (((byte_length >= 0) AND (byte_length <= '9007199254740991'::bigint))),
    CONSTRAINT system_archive_uploads_check CHECK (((received_bytes >= 0) AND (received_bytes <= byte_length))),
    CONSTRAINT system_archive_uploads_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT system_archive_uploads_handle_token_hash_check CHECK ((handle_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT system_archive_uploads_lifecycle_check CHECK ((((status = 'created'::text) AND (received_bytes = 0) AND (staged_input_id IS NULL)) OR ((status = 'uploading'::text) AND (received_bytes > 0) AND (staged_input_id IS NULL)) OR ((status = 'completed'::text) AND (received_bytes = byte_length) AND (staged_input_id IS NOT NULL)) OR (status = ANY (ARRAY['expired'::text, 'failed'::text])))),
    CONSTRAINT system_archive_uploads_status_check CHECK ((status = ANY (ARRAY['created'::text, 'uploading'::text, 'completed'::text, 'expired'::text, 'failed'::text])))
);

--
-- Name: text_provider_capacity_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.text_provider_capacity_leases (
    id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

--
-- Name: turn_illustration_segment_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.turn_illustration_segment_assets (
    segment_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    image_job_id uuid,
    variant_index integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT turn_illustration_segment_assets_variant_index_check CHECK (((variant_index >= 0) AND (variant_index <= 1)))
);

--
-- Name: turn_illustration_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.turn_illustration_segments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    illustration_set_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    turn_id uuid,
    ordinal integer NOT NULL,
    start_offset integer NOT NULL,
    end_offset integer NOT NULL,
    start_word integer NOT NULL,
    end_word integer NOT NULL,
    source_text text NOT NULL,
    source_text_hash text NOT NULL,
    direct_prompt text NOT NULL,
    resolved_prompt text DEFAULT ''::text NOT NULL,
    prompt_source text DEFAULT 'direct'::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    generation_job_id uuid,
    activity_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT turn_illustration_segments_activity_revision_check CHECK ((activity_revision >= 0)),
    CONSTRAINT turn_illustration_segments_check CHECK ((end_offset >= start_offset)),
    CONSTRAINT turn_illustration_segments_check1 CHECK ((end_word >= start_word)),
    CONSTRAINT turn_illustration_segments_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT turn_illustration_segments_prompt_source_check CHECK ((prompt_source = ANY (ARRAY['direct'::text, 'ai_refined'::text, 'ai_fallback'::text, 'legacy'::text]))),
    CONSTRAINT turn_illustration_segments_start_offset_check CHECK ((start_offset >= 0)),
    CONSTRAINT turn_illustration_segments_start_word_check CHECK ((start_word >= 0)),
    CONSTRAINT turn_illustration_segments_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'refining'::text, 'generating'::text, 'completed'::text, 'recoverable'::text, 'failed'::text])))
);

--
-- Name: turn_illustration_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.turn_illustration_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    turn_id uuid,
    source_text_hash text NOT NULL,
    segment_word_count integer NOT NULL,
    images_per_segment integer NOT NULL,
    prompt_mode text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    character_visual_reference text DEFAULT ''::text NOT NULL,
    generation_job_id uuid,
    CONSTRAINT turn_illustration_sets_images_per_segment_check CHECK (((images_per_segment >= 1) AND (images_per_segment <= 2))),
    CONSTRAINT turn_illustration_sets_prompt_mode_check CHECK ((prompt_mode = ANY (ARRAY['direct'::text, 'ai_refined'::text, 'legacy'::text]))),
    CONSTRAINT turn_illustration_sets_segment_word_count_check CHECK (((segment_word_count >= 100) AND (segment_word_count <= 5000))),
    CONSTRAINT turn_illustration_sets_status_check CHECK ((status = ANY (ARRAY['provisional'::text, 'queued'::text, 'refining'::text, 'generating'::text, 'completed'::text, 'partial'::text, 'failed'::text, 'superseded'::text, 'orphaned'::text])))
);

--
-- Name: COLUMN turn_illustration_sets.character_visual_reference; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.turn_illustration_sets.character_visual_reference IS 'Fiction-only bounded character appearance snapshot used for this illustration set.';

--
-- Name: turn_input_classifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.turn_input_classifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    input_hash text NOT NULL,
    requested_selection text DEFAULT 'auto'::text NOT NULL,
    classification text NOT NULL,
    resolved_mode text NOT NULL,
    confidence_band text NOT NULL,
    provider_profile_id uuid,
    provider_source text NOT NULL,
    diagnostics jsonb DEFAULT '{}'::jsonb NOT NULL,
    consumed_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '00:15:00'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT turn_input_classifications_classification_check CHECK ((classification = ANY (ARRAY['action'::text, 'scene'::text, 'mixed'::text, 'uncertain'::text]))),
    CONSTRAINT turn_input_classifications_confidence_band_check CHECK ((confidence_band = ANY (ARRAY['clear'::text, 'probable'::text, 'ambiguous'::text]))),
    CONSTRAINT turn_input_classifications_provider_source_check CHECK ((provider_source = ANY (ARRAY['intent_default'::text, 'story_text'::text, 'campaign_fallback'::text]))),
    CONSTRAINT turn_input_classifications_requested_selection_check CHECK ((requested_selection = 'auto'::text)),
    CONSTRAINT turn_input_classifications_resolved_mode_check CHECK ((resolved_mode = ANY (ARRAY['action'::text, 'scene'::text])))
);

--
-- Name: TABLE turn_input_classifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.turn_input_classifications IS 'Short-lived private audit records for Auto mode. Raw player input is never duplicated here; only a hash is stored.';

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    system_key text,
    display_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);

--
-- Name: world_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.world_drafts (
    world_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    based_on_world_version_id uuid,
    revision integer DEFAULT 1 NOT NULL,
    content jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT world_drafts_revision_check CHECK ((revision > 0))
);

--
-- Name: world_generation_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.world_generation_progress (
    progress_key text NOT NULL,
    owner_user_id uuid NOT NULL,
    status text DEFAULT 'processing'::text NOT NULL,
    phase text NOT NULL,
    progress_percent integer DEFAULT 0 NOT NULL,
    message text DEFAULT ''::text NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:30:00'::interval) NOT NULL,
    CONSTRAINT world_generation_progress_progress_percent_check CHECK (((progress_percent >= 0) AND (progress_percent <= 100))),
    CONSTRAINT world_generation_progress_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'completed'::text, 'failed'::text])))
);

--
-- Name: world_share_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.world_share_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    world_id uuid NOT NULL,
    world_version_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    redeemed_count bigint DEFAULT 0 NOT NULL,
    last_redeemed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT world_share_links_redeemed_count_check CHECK ((redeemed_count >= 0)),
    CONSTRAINT world_share_links_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);

--
-- Name: TABLE world_share_links; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.world_share_links IS 'Revocable expiring bearer links pinned to immutable portable world versions; raw tokens are never persisted.';

--
-- Name: world_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.world_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    world_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    version_number integer NOT NULL,
    content jsonb NOT NULL,
    source_hash text,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    release_notes text DEFAULT ''::text NOT NULL,
    created_from_revision integer,
    CONSTRAINT world_versions_version_number_check CHECK ((version_number > 0))
);

--
-- Name: worlds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worlds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    forked_from_world_id uuid,
    forked_from_world_version_id uuid,
    next_version_number integer DEFAULT 1 NOT NULL,
    cover_asset_id uuid,
    CONSTRAINT worlds_next_version_number_check CHECK ((next_version_number > 0)),
    CONSTRAINT worlds_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])))
);

--
-- Name: activity_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_events ALTER COLUMN id SET DEFAULT nextval('public.activity_events_id_seq'::regclass);

--
-- Name: story_activity_events sequence; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_activity_events ALTER COLUMN sequence SET DEFAULT nextval('public.story_activity_events_sequence_seq'::regclass);

--
-- Name: activity_event_outbox activity_event_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_event_outbox
    ADD CONSTRAINT activity_event_outbox_pkey PRIMARY KEY (event_id);

--
-- Name: activity_event_outbox activity_event_outbox_source_source_id_activity_revision_or_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_event_outbox
    ADD CONSTRAINT activity_event_outbox_source_source_id_activity_revision_or_key UNIQUE (source, source_id, activity_revision, ordinal);

--
-- Name: activity_events activity_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_events
    ADD CONSTRAINT activity_events_pkey PRIMARY KEY (id);

--
-- Name: api_admission_buckets api_admission_buckets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_admission_buckets
    ADD CONSTRAINT api_admission_buckets_pkey PRIMARY KEY (owner_user_id, operation, window_started_at);

--
-- Name: api_admission_events api_admission_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_admission_events
    ADD CONSTRAINT api_admission_events_pkey PRIMARY KEY (id);

--
-- Name: api_admission_leases api_admission_leases_owner_user_id_operation_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_admission_leases
    ADD CONSTRAINT api_admission_leases_owner_user_id_operation_request_id_key UNIQUE (owner_user_id, operation, request_id);

--
-- Name: api_admission_leases api_admission_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_admission_leases
    ADD CONSTRAINT api_admission_leases_pkey PRIMARY KEY (id);

--
-- Name: api_admission_recoveries api_admission_recoveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_admission_recoveries
    ADD CONSTRAINT api_admission_recoveries_pkey PRIMARY KEY (id);

--
-- Name: api_admission_windows api_admission_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_admission_windows
    ADD CONSTRAINT api_admission_windows_pkey PRIMARY KEY (owner_user_id, operation, window_started_at, window_expires_at);

--
-- Name: archive_previews archive_previews_legacy_drain_policy_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.archive_previews
    ADD CONSTRAINT archive_previews_legacy_drain_policy_check CHECK ((legacy_drain_policy = ANY (ARRAY['retain_until_secure_cleanup'::text, 'live_path_cleanup_compatibility'::text]))) NOT VALID;

--
-- Name: archive_previews archive_previews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.archive_previews
    ADD CONSTRAINT archive_previews_pkey PRIMARY KEY (id);

--
-- Name: archive_previews archive_previews_storage_security_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.archive_previews
    ADD CONSTRAINT archive_previews_storage_security_check CHECK ((((storage_security_state = 'legacy_path_v1'::text) AND (secure_staged_input_id IS NULL)) OR ((storage_security_state = 'identity_bound_v2'::text) AND (secure_staged_input_id IS NOT NULL)))) NOT VALID;

--
-- Name: archive_previews archive_previews_storage_security_state_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.archive_previews
    ADD CONSTRAINT archive_previews_storage_security_state_check CHECK ((storage_security_state = ANY (ARRAY['legacy_path_v1'::text, 'identity_bound_v2'::text]))) NOT VALID;

--
-- Name: archive_previews archive_previews_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.archive_previews
    ADD CONSTRAINT archive_previews_token_hash_key UNIQUE (token_hash);

--
-- Name: asset_derivatives asset_derivatives_owner_user_id_source_asset_id_derivative__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_derivatives
    ADD CONSTRAINT asset_derivatives_owner_user_id_source_asset_id_derivative__key UNIQUE (owner_user_id, source_asset_id, derivative_kind, transform_version, pixel_width, pixel_height);

--
-- Name: asset_derivatives asset_derivatives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_derivatives
    ADD CONSTRAINT asset_derivatives_pkey PRIMARY KEY (id);

--
-- Name: asset_generation_contexts asset_generation_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_generation_contexts
    ADD CONSTRAINT asset_generation_contexts_pkey PRIMARY KEY (id);

--
-- Name: asset_library_entries asset_library_entries_asset_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_library_entries
    ADD CONSTRAINT asset_library_entries_asset_id_owner_user_id_key UNIQUE (asset_id, owner_user_id);

--
-- Name: asset_library_entries asset_library_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_library_entries
    ADD CONSTRAINT asset_library_entries_pkey PRIMARY KEY (asset_id);

--
-- Name: asset_metadata_backfill_jobs asset_metadata_backfill_jobs_asset_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_metadata_backfill_jobs
    ADD CONSTRAINT asset_metadata_backfill_jobs_asset_id_owner_user_id_key UNIQUE (asset_id, owner_user_id);

--
-- Name: asset_metadata_backfill_jobs asset_metadata_backfill_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_metadata_backfill_jobs
    ADD CONSTRAINT asset_metadata_backfill_jobs_pkey PRIMARY KEY (id);

--
-- Name: asset_metadata_backfill_publications asset_metadata_backfill_publication_filesystem_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_metadata_backfill_publications
    ADD CONSTRAINT asset_metadata_backfill_publication_filesystem_operation_id_key UNIQUE (filesystem_operation_id);

--
-- Name: asset_metadata_backfill_publications asset_metadata_backfill_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_metadata_backfill_publications
    ADD CONSTRAINT asset_metadata_backfill_publications_pkey PRIMARY KEY (owner_user_id, asset_id);

--
-- Name: asset_mutation_idempotency asset_mutation_idempotency_owner_user_id_mutation_kind_idem_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_mutation_idempotency
    ADD CONSTRAINT asset_mutation_idempotency_owner_user_id_mutation_kind_idem_key UNIQUE (owner_user_id, mutation_kind, idempotency_key_hash);

--
-- Name: asset_mutation_idempotency asset_mutation_idempotency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_mutation_idempotency
    ADD CONSTRAINT asset_mutation_idempotency_pkey PRIMARY KEY (id);

--
-- Name: asset_publication_content_arbitrations asset_publication_content_arb_owner_user_id_canonical_asset_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_content_arbitrations
    ADD CONSTRAINT asset_publication_content_arb_owner_user_id_canonical_asset_key UNIQUE (owner_user_id, canonical_asset_id);

--
-- Name: asset_publication_content_arbitrations asset_publication_content_arbitrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_content_arbitrations
    ADD CONSTRAINT asset_publication_content_arbitrations_pkey PRIMARY KEY (owner_user_id, content_hash);

--
-- Name: asset_publication_identities asset_publication_identities_asset_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_identities
    ADD CONSTRAINT asset_publication_identities_asset_id_owner_user_id_key UNIQUE (asset_id, owner_user_id);

--
-- Name: asset_publication_identities asset_publication_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_identities
    ADD CONSTRAINT asset_publication_identities_pkey PRIMARY KEY (asset_id);

--
-- Name: asset_publication_library_initializations asset_publication_library_ini_owner_user_id_canonical_asset_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_library_initializations
    ADD CONSTRAINT asset_publication_library_ini_owner_user_id_canonical_asset_key UNIQUE (owner_user_id, canonical_asset_id);

--
-- Name: asset_publication_library_initializations asset_publication_library_initializations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_library_initializations
    ADD CONSTRAINT asset_publication_library_initializations_pkey PRIMARY KEY (request_id, owner_user_id);

--
-- Name: asset_publication_request_contexts asset_publication_request_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_request_contexts
    ADD CONSTRAINT asset_publication_request_contexts_pkey PRIMARY KEY (request_id, owner_user_id, intent_key);

--
-- Name: asset_publication_request_derivatives asset_publication_request_der_request_id_owner_user_id_cont_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_request_derivatives
    ADD CONSTRAINT asset_publication_request_der_request_id_owner_user_id_cont_key UNIQUE (request_id, owner_user_id, content_hash);

--
-- Name: asset_publication_request_derivatives asset_publication_request_derivatives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_request_derivatives
    ADD CONSTRAINT asset_publication_request_derivatives_pkey PRIMARY KEY (request_id, owner_user_id, ordinal);

--
-- Name: asset_publication_request_references asset_publication_request_references_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_request_references
    ADD CONSTRAINT asset_publication_request_references_pkey PRIMARY KEY (request_id, owner_user_id, intent_key);

--
-- Name: asset_publication_request_results asset_publication_request_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_request_results
    ADD CONSTRAINT asset_publication_request_results_pkey PRIMARY KEY (request_id, owner_user_id);

--
-- Name: asset_publication_request_sources asset_publication_request_sou_request_id_owner_user_id_sour_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_request_sources
    ADD CONSTRAINT asset_publication_request_sou_request_id_owner_user_id_sour_key UNIQUE (request_id, owner_user_id, source_kind, source_asset_id, source_record_id, source_key);

--
-- Name: asset_publication_request_sources asset_publication_request_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_request_sources
    ADD CONSTRAINT asset_publication_request_sources_pkey PRIMARY KEY (request_id, owner_user_id, ordinal);

--
-- Name: asset_publication_requests asset_publication_requests_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_requests
    ADD CONSTRAINT asset_publication_requests_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: asset_publication_requests asset_publication_requests_owner_user_id_idempotency_key_ha_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_requests
    ADD CONSTRAINT asset_publication_requests_owner_user_id_idempotency_key_ha_key UNIQUE (owner_user_id, idempotency_key_hash);

--
-- Name: asset_publication_requests asset_publication_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_requests
    ADD CONSTRAINT asset_publication_requests_pkey PRIMARY KEY (id);

--
-- Name: asset_references asset_references_asset_id_campaign_id_turn_id_asset_role_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_references
    ADD CONSTRAINT asset_references_asset_id_campaign_id_turn_id_asset_role_key UNIQUE NULLS NOT DISTINCT (asset_id, campaign_id, turn_id, asset_role);

--
-- Name: asset_references asset_references_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_references
    ADD CONSTRAINT asset_references_pkey PRIMARY KEY (id);

--
-- Name: assets assets_id_owner_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_id_owner_unique UNIQUE (id, owner_user_id);

--
-- Name: assets assets_owner_user_id_content_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_owner_user_id_content_hash_key UNIQUE (owner_user_id, content_hash);

--
-- Name: assets assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_pkey PRIMARY KEY (id);

--
-- Name: authoring_job_stages authoring_job_stages_job_id_stage_key_generation_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authoring_job_stages
    ADD CONSTRAINT authoring_job_stages_job_id_stage_key_generation_key UNIQUE (job_id, stage_key, generation);

--
-- Name: authoring_job_stages authoring_job_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authoring_job_stages
    ADD CONSTRAINT authoring_job_stages_pkey PRIMARY KEY (id);

--
-- Name: authoring_jobs authoring_jobs_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authoring_jobs
    ADD CONSTRAINT authoring_jobs_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: authoring_jobs authoring_jobs_owner_user_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authoring_jobs
    ADD CONSTRAINT authoring_jobs_owner_user_id_idempotency_key_key UNIQUE (owner_user_id, idempotency_key);

--
-- Name: authoring_jobs authoring_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authoring_jobs
    ADD CONSTRAINT authoring_jobs_pkey PRIMARY KEY (id);

--
-- Name: campaign_activity_history campaign_activity_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_activity_history
    ADD CONSTRAINT campaign_activity_history_pkey PRIMARY KEY (owner_user_id, campaign_id);

--
-- Name: campaign_canonical_facts campaign_canonical_facts_campaign_id_source_turn_id_source__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_canonical_facts
    ADD CONSTRAINT campaign_canonical_facts_campaign_id_source_turn_id_source__key UNIQUE (campaign_id, source_turn_id, source_fact_index);

--
-- Name: campaign_canonical_facts campaign_canonical_facts_id_campaign_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_canonical_facts
    ADD CONSTRAINT campaign_canonical_facts_id_campaign_id_owner_user_id_key UNIQUE (id, campaign_id, owner_user_id);

--
-- Name: campaign_canonical_facts campaign_canonical_facts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_canonical_facts
    ADD CONSTRAINT campaign_canonical_facts_pkey PRIMARY KEY (id);

--
-- Name: campaign_cast_characters campaign_cast_characters_id_campaign_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_characters
    ADD CONSTRAINT campaign_cast_characters_id_campaign_id_owner_user_id_key UNIQUE (id, campaign_id, owner_user_id);

--
-- Name: campaign_cast_characters campaign_cast_characters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_characters
    ADD CONSTRAINT campaign_cast_characters_pkey PRIMARY KEY (id);

--
-- Name: campaign_cast_discovery_candidates campaign_cast_discovery_candi_job_id_chunk_ordinal_local_ke_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_candidates
    ADD CONSTRAINT campaign_cast_discovery_candi_job_id_chunk_ordinal_local_ke_key UNIQUE (job_id, chunk_ordinal, local_key);

--
-- Name: campaign_cast_discovery_candidates campaign_cast_discovery_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_candidates
    ADD CONSTRAINT campaign_cast_discovery_candidates_pkey PRIMARY KEY (id);

--
-- Name: campaign_cast_discovery_jobs campaign_cast_discovery_jobs_campaign_id_turn_id_narration__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_jobs
    ADD CONSTRAINT campaign_cast_discovery_jobs_campaign_id_turn_id_narration__key UNIQUE (campaign_id, turn_id, narration_revision, timeline_revision, protocol);

--
-- Name: campaign_cast_discovery_jobs campaign_cast_discovery_jobs_id_campaign_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_jobs
    ADD CONSTRAINT campaign_cast_discovery_jobs_id_campaign_id_owner_user_id_key UNIQUE (id, campaign_id, owner_user_id);

--
-- Name: campaign_cast_discovery_jobs campaign_cast_discovery_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_jobs
    ADD CONSTRAINT campaign_cast_discovery_jobs_pkey PRIMARY KEY (id);

--
-- Name: campaign_cast_discovery_receipts campaign_cast_discovery_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_receipts
    ADD CONSTRAINT campaign_cast_discovery_receipts_pkey PRIMARY KEY (job_id, chunk_ordinal);

--
-- Name: campaign_cast_discovery_retries campaign_cast_discovery_retries_job_id_retry_generation_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_retries
    ADD CONSTRAINT campaign_cast_discovery_retries_job_id_retry_generation_key UNIQUE (job_id, retry_generation);

--
-- Name: campaign_cast_discovery_retries campaign_cast_discovery_retries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_retries
    ADD CONSTRAINT campaign_cast_discovery_retries_pkey PRIMARY KEY (job_id, idempotency_key);

--
-- Name: campaign_cast_events campaign_cast_events_campaign_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_events
    ADD CONSTRAINT campaign_cast_events_campaign_id_idempotency_key_key UNIQUE (campaign_id, idempotency_key);

--
-- Name: campaign_cast_events campaign_cast_events_id_campaign_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_events
    ADD CONSTRAINT campaign_cast_events_id_campaign_id_owner_user_id_key UNIQUE (id, campaign_id, owner_user_id);

--
-- Name: campaign_cast_events campaign_cast_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_events
    ADD CONSTRAINT campaign_cast_events_pkey PRIMARY KEY (id);

--
-- Name: campaign_cast_observations campaign_cast_observations_id_character_id_field_campaign_i_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_observations
    ADD CONSTRAINT campaign_cast_observations_id_character_id_field_campaign_i_key UNIQUE (id, character_id, field, campaign_id, owner_user_id);

--
-- Name: campaign_cast_observations campaign_cast_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_observations
    ADD CONSTRAINT campaign_cast_observations_pkey PRIMARY KEY (id);

--
-- Name: campaign_cast_profiles campaign_cast_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_profiles
    ADD CONSTRAINT campaign_cast_profiles_pkey PRIMARY KEY (character_id);

--
-- Name: campaign_cast_promotion_receipts campaign_cast_promotion_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_promotion_receipts
    ADD CONSTRAINT campaign_cast_promotion_receipts_pkey PRIMARY KEY (owner_user_id, world_id, idempotency_key);

--
-- Name: campaign_cast_scan_sources campaign_cast_scan_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_scan_sources
    ADD CONSTRAINT campaign_cast_scan_sources_pkey PRIMARY KEY (scan_id, turn_number);

--
-- Name: campaign_cast_scans campaign_cast_scans_campaign_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_scans
    ADD CONSTRAINT campaign_cast_scans_campaign_id_idempotency_key_key UNIQUE (campaign_id, idempotency_key);

--
-- Name: campaign_cast_scans campaign_cast_scans_id_campaign_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_scans
    ADD CONSTRAINT campaign_cast_scans_id_campaign_id_owner_user_id_key UNIQUE (id, campaign_id, owner_user_id);

--
-- Name: campaign_cast_scans campaign_cast_scans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_scans
    ADD CONSTRAINT campaign_cast_scans_pkey PRIMARY KEY (id);

--
-- Name: campaign_cast_state campaign_cast_state_campaign_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_state
    ADD CONSTRAINT campaign_cast_state_campaign_id_owner_user_id_key UNIQUE (campaign_id, owner_user_id);

--
-- Name: campaign_cast_state campaign_cast_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_state
    ADD CONSTRAINT campaign_cast_state_pkey PRIMARY KEY (campaign_id);

--
-- Name: campaign_character_profile_edits campaign_character_profile_edits_campaign_id_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_character_profile_edits
    ADD CONSTRAINT campaign_character_profile_edits_campaign_id_revision_key UNIQUE (campaign_id, revision);

--
-- Name: campaign_character_profile_edits campaign_character_profile_edits_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_character_profile_edits
    ADD CONSTRAINT campaign_character_profile_edits_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: campaign_character_profile_edits campaign_character_profile_edits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_character_profile_edits
    ADD CONSTRAINT campaign_character_profile_edits_pkey PRIMARY KEY (id);

--
-- Name: campaign_illustration_configs campaign_illustration_configs_campaign_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_illustration_configs
    ADD CONSTRAINT campaign_illustration_configs_campaign_id_owner_user_id_key UNIQUE (campaign_id, owner_user_id);

--
-- Name: campaign_illustration_configs campaign_illustration_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_illustration_configs
    ADD CONSTRAINT campaign_illustration_configs_pkey PRIMARY KEY (campaign_id);

--
-- Name: campaign_memory_configs campaign_memory_configs_campaign_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_memory_configs
    ADD CONSTRAINT campaign_memory_configs_campaign_id_owner_user_id_key UNIQUE (campaign_id, owner_user_id);

--
-- Name: campaign_memory_configs campaign_memory_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_memory_configs
    ADD CONSTRAINT campaign_memory_configs_pkey PRIMARY KEY (campaign_id);

--
-- Name: campaign_state_edits campaign_state_edits_campaign_id_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_state_edits
    ADD CONSTRAINT campaign_state_edits_campaign_id_revision_key UNIQUE (campaign_id, revision);

--
-- Name: campaign_state_edits campaign_state_edits_owner_identity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_state_edits
    ADD CONSTRAINT campaign_state_edits_owner_identity UNIQUE (id, campaign_id, owner_user_id);

--
-- Name: campaign_state_edits campaign_state_edits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_state_edits
    ADD CONSTRAINT campaign_state_edits_pkey PRIMARY KEY (id);

--
-- Name: campaign_state campaign_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_state
    ADD CONSTRAINT campaign_state_pkey PRIMARY KEY (campaign_id);

--
-- Name: campaign_story_memory_enrollments campaign_story_memory_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_story_memory_enrollments
    ADD CONSTRAINT campaign_story_memory_enrollments_pkey PRIMARY KEY (campaign_id);

--
-- Name: campaign_world_migrations campaign_world_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_world_migrations
    ADD CONSTRAINT campaign_world_migrations_pkey PRIMARY KEY (id);

--
-- Name: campaign_world_transfers campaign_world_transfers_owner_user_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_world_transfers
    ADD CONSTRAINT campaign_world_transfers_owner_user_id_idempotency_key_key UNIQUE (owner_user_id, idempotency_key);

--
-- Name: campaign_world_transfers campaign_world_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_world_transfers
    ADD CONSTRAINT campaign_world_transfers_pkey PRIMARY KEY (id);

--
-- Name: campaigns campaigns_id_owner_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_id_owner_unique UNIQUE (id, owner_user_id);

--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);

--
-- Name: cancelled_dispatch_recoveries cancelled_dispatch_recoveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cancelled_dispatch_recoveries
    ADD CONSTRAINT cancelled_dispatch_recoveries_pkey PRIMARY KEY (attempt_id);

--
-- Name: chronicle_chunk_jobs chronicle_chunk_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_chunk_jobs
    ADD CONSTRAINT chronicle_chunk_jobs_pkey PRIMARY KEY (id);

--
-- Name: chronicle_jobs chronicle_jobs_id_owner_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_jobs
    ADD CONSTRAINT chronicle_jobs_id_owner_unique UNIQUE (id, owner_user_id);

--
-- Name: chronicle_jobs chronicle_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_jobs
    ADD CONSTRAINT chronicle_jobs_pkey PRIMARY KEY (id);

--
-- Name: chronicle_memories chronicle_memories_campaign_id_turn_id_memory_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memories
    ADD CONSTRAINT chronicle_memories_campaign_id_turn_id_memory_kind_key UNIQUE NULLS NOT DISTINCT (campaign_id, turn_id, memory_kind);

--
-- Name: chronicle_memories chronicle_memories_chunk_parent_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memories
    ADD CONSTRAINT chronicle_memories_chunk_parent_scope_unique UNIQUE (id, owner_user_id, campaign_id, world_version_id);

--
-- Name: chronicle_memories chronicle_memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memories
    ADD CONSTRAINT chronicle_memories_pkey PRIMARY KEY (id);

--
-- Name: chronicle_memory_chunks chronicle_memory_chunks_parent_version_ordinal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memory_chunks
    ADD CONSTRAINT chronicle_memory_chunks_parent_version_ordinal_key UNIQUE (parent_memory_id, parent_content_hash, chunking_protocol_version, chunk_ordinal);

--
-- Name: chronicle_memory_chunks chronicle_memory_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memory_chunks
    ADD CONSTRAINT chronicle_memory_chunks_pkey PRIMARY KEY (id);

--
-- Name: chronicle_query_embedding_cache chronicle_query_embedding_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_query_embedding_cache
    ADD CONSTRAINT chronicle_query_embedding_cache_pkey PRIMARY KEY (id);

--
-- Name: chronicle_query_embedding_cache chronicle_query_embedding_cache_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_query_embedding_cache
    ADD CONSTRAINT chronicle_query_embedding_cache_scope_unique UNIQUE (owner_user_id, campaign_id, normalized_query_hash, provider_profile_id, embedding_model_hash, provider_fingerprint_hash, query_prefix_hash, embedding_protocol_version);

--
-- Name: chronicle_retrieval_candidates chronicle_retrieval_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_retrieval_candidates
    ADD CONSTRAINT chronicle_retrieval_candidates_pkey PRIMARY KEY (id);

--
-- Name: chronicle_retrieval_candidates chronicle_retrieval_candidates_run_candidate_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_retrieval_candidates
    ADD CONSTRAINT chronicle_retrieval_candidates_run_candidate_unique UNIQUE (run_id, implementation, candidate_id);

--
-- Name: chronicle_retrieval_runs chronicle_retrieval_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_retrieval_runs
    ADD CONSTRAINT chronicle_retrieval_runs_pkey PRIMARY KEY (id);

--
-- Name: chronicle_retrieval_runs chronicle_retrieval_runs_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_retrieval_runs
    ADD CONSTRAINT chronicle_retrieval_runs_scope_unique UNIQUE (id, owner_user_id, campaign_id, world_version_id);

--
-- Name: durable_filesystem_operations durable_filesystem_asset_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_operations
    ADD CONSTRAINT durable_filesystem_asset_scope_unique UNIQUE (id, owner_user_id, purpose, asset_id);

--
-- Name: durable_filesystem_candidate_authorities durable_filesystem_candidate__candidate_token_hash_operatio_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_candidate_authorities
    ADD CONSTRAINT durable_filesystem_candidate__candidate_token_hash_operatio_key UNIQUE (candidate_token_hash, operation_id, owner_user_id, purpose);

--
-- Name: durable_filesystem_candidate_authorities durable_filesystem_candidate_authorities_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_candidate_authorities
    ADD CONSTRAINT durable_filesystem_candidate_authorities_operation_id_key UNIQUE (operation_id);

--
-- Name: durable_filesystem_candidate_authorities durable_filesystem_candidate_authorities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_candidate_authorities
    ADD CONSTRAINT durable_filesystem_candidate_authorities_pkey PRIMARY KEY (candidate_token_hash);

--
-- Name: durable_filesystem_descriptors durable_filesystem_descriptor_operation_id_owner_user_id_de_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_descriptors
    ADD CONSTRAINT durable_filesystem_descriptor_operation_id_owner_user_id_de_key UNIQUE (operation_id, owner_user_id, descriptor_role, ordinal);

--
-- Name: durable_filesystem_descriptors durable_filesystem_descriptors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_descriptors
    ADD CONSTRAINT durable_filesystem_descriptors_pkey PRIMARY KEY (operation_id, descriptor_role, ordinal);

--
-- Name: durable_filesystem_operations durable_filesystem_operations_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_operations
    ADD CONSTRAINT durable_filesystem_operations_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: durable_filesystem_operations durable_filesystem_operations_id_owner_user_id_purpose_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_operations
    ADD CONSTRAINT durable_filesystem_operations_id_owner_user_id_purpose_key UNIQUE (id, owner_user_id, purpose);

--
-- Name: durable_filesystem_operations durable_filesystem_operations_operation_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_operations
    ADD CONSTRAINT durable_filesystem_operations_operation_token_hash_key UNIQUE (operation_token_hash);

--
-- Name: durable_filesystem_operations durable_filesystem_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_operations
    ADD CONSTRAINT durable_filesystem_operations_pkey PRIMARY KEY (id);

--
-- Name: durable_filesystem_prewrite_nodes durable_filesystem_prewrite_n_operation_id_owner_user_id_pu_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_prewrite_nodes
    ADD CONSTRAINT durable_filesystem_prewrite_n_operation_id_owner_user_id_pu_key UNIQUE (operation_id, owner_user_id, purpose);

--
-- Name: durable_filesystem_prewrite_nodes durable_filesystem_prewrite_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_prewrite_nodes
    ADD CONSTRAINT durable_filesystem_prewrite_nodes_pkey PRIMARY KEY (operation_id);

--
-- Name: generation_attempts generation_attempts_generation_job_id_attempt_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_attempts
    ADD CONSTRAINT generation_attempts_generation_job_id_attempt_number_key UNIQUE (generation_job_id, attempt_number);

--
-- Name: generation_attempts generation_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_attempts
    ADD CONSTRAINT generation_attempts_pkey PRIMARY KEY (id);

--
-- Name: generation_jobs generation_jobs_campaign_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_jobs
    ADD CONSTRAINT generation_jobs_campaign_id_idempotency_key_key UNIQUE (campaign_id, idempotency_key);

--
-- Name: generation_jobs generation_jobs_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_jobs
    ADD CONSTRAINT generation_jobs_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: generation_jobs generation_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_jobs
    ADD CONSTRAINT generation_jobs_pkey PRIMARY KEY (id);

--
-- Name: illustration_backfill_jobs illustration_backfill_jobs_campaign_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_backfill_jobs
    ADD CONSTRAINT illustration_backfill_jobs_campaign_id_idempotency_key_key UNIQUE (campaign_id, idempotency_key);

--
-- Name: illustration_backfill_jobs illustration_backfill_jobs_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_backfill_jobs
    ADD CONSTRAINT illustration_backfill_jobs_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: illustration_backfill_jobs illustration_backfill_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_backfill_jobs
    ADD CONSTRAINT illustration_backfill_jobs_pkey PRIMARY KEY (id);

--
-- Name: illustration_match_candidates illustration_match_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_match_candidates
    ADD CONSTRAINT illustration_match_candidates_pkey PRIMARY KEY (resolution_job_id, asset_id);

--
-- Name: illustration_match_candidates illustration_match_candidates_resolution_job_id_rank_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_match_candidates
    ADD CONSTRAINT illustration_match_candidates_resolution_job_id_rank_key UNIQUE (resolution_job_id, rank);

--
-- Name: illustration_prompt_jobs illustration_prompt_jobs_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_prompt_jobs
    ADD CONSTRAINT illustration_prompt_jobs_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: illustration_prompt_jobs illustration_prompt_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_prompt_jobs
    ADD CONSTRAINT illustration_prompt_jobs_pkey PRIMARY KEY (id);

--
-- Name: illustration_prompt_jobs illustration_prompt_jobs_segment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_prompt_jobs
    ADD CONSTRAINT illustration_prompt_jobs_segment_id_key UNIQUE (segment_id);

--
-- Name: illustration_resolution_jobs illustration_resolution_jobs_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_resolution_jobs
    ADD CONSTRAINT illustration_resolution_jobs_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: illustration_resolution_jobs illustration_resolution_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_resolution_jobs
    ADD CONSTRAINT illustration_resolution_jobs_pkey PRIMARY KEY (id);

--
-- Name: image_job_asset_publications image_job_asset_publications_image_job_id_owner_user_id_req_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_job_asset_publications
    ADD CONSTRAINT image_job_asset_publications_image_job_id_owner_user_id_req_key UNIQUE (image_job_id, owner_user_id, request_id, variant_index);

--
-- Name: image_job_asset_publications image_job_asset_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_job_asset_publications
    ADD CONSTRAINT image_job_asset_publications_pkey PRIMARY KEY (image_job_id, variant_index);

--
-- Name: image_job_asset_publications image_job_asset_publications_request_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_job_asset_publications
    ADD CONSTRAINT image_job_asset_publications_request_id_owner_user_id_key UNIQUE (request_id, owner_user_id);

--
-- Name: image_jobs image_jobs_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_jobs
    ADD CONSTRAINT image_jobs_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: image_jobs image_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_jobs
    ADD CONSTRAINT image_jobs_pkey PRIMARY KEY (id);

--
-- Name: import_progress_status import_progress_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_progress_status
    ADD CONSTRAINT import_progress_status_pkey PRIMARY KEY (owner_user_id, lookup_key_hash);

--
-- Name: imports imports_id_owner_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imports
    ADD CONSTRAINT imports_id_owner_unique UNIQUE (id, owner_user_id);

--
-- Name: imports imports_owner_user_id_source_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imports
    ADD CONSTRAINT imports_owner_user_id_source_hash_key UNIQUE (owner_user_id, source_hash);

--
-- Name: imports imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imports
    ADD CONSTRAINT imports_pkey PRIMARY KEY (id);

--
-- Name: instance_settings_events instance_settings_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_settings_events
    ADD CONSTRAINT instance_settings_events_pkey PRIMARY KEY (id);

--
-- Name: instance_settings_revisions instance_settings_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_settings_revisions
    ADD CONSTRAINT instance_settings_revisions_pkey PRIMARY KEY (revision);

--
-- Name: instance_settings_runtime_reports instance_settings_runtime_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_settings_runtime_reports
    ADD CONSTRAINT instance_settings_runtime_reports_pkey PRIMARY KEY (process_id);

--
-- Name: instance_settings_state instance_settings_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_settings_state
    ADD CONSTRAINT instance_settings_state_pkey PRIMARY KEY (singleton);

--
-- Name: local_settings_restart_operations local_settings_restart_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_settings_restart_operations
    ADD CONSTRAINT local_settings_restart_operations_pkey PRIMARY KEY (id);

--
-- Name: model_chains model_chains_campaign_id_provider_profile_id_model_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_chains
    ADD CONSTRAINT model_chains_campaign_id_provider_profile_id_model_endpoint_key UNIQUE (campaign_id, provider_profile_id, model, endpoint_identity, prompt_protocol_version, context_fingerprint);

--
-- Name: model_chains model_chains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_chains
    ADD CONSTRAINT model_chains_pkey PRIMARY KEY (id);

--
-- Name: portable_export_artifacts portable_export_artifacts_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_export_artifacts
    ADD CONSTRAINT portable_export_artifacts_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: portable_export_artifacts portable_export_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_export_artifacts
    ADD CONSTRAINT portable_export_artifacts_pkey PRIMARY KEY (id);

--
-- Name: portable_export_artifacts portable_export_artifacts_retrieval_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_export_artifacts
    ADD CONSTRAINT portable_export_artifacts_retrieval_token_hash_key UNIQUE (retrieval_token_hash);

--
-- Name: portable_import_asset_publications portable_import_asset_publications_import_id_asset_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_asset_publications
    ADD CONSTRAINT portable_import_asset_publications_import_id_asset_id_key UNIQUE (import_id, asset_id);

--
-- Name: portable_import_asset_publications portable_import_asset_publications_import_request_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_asset_publications
    ADD CONSTRAINT portable_import_asset_publications_import_request_unique UNIQUE (import_id, request_id);

--
-- Name: portable_import_asset_publications portable_import_asset_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_asset_publications
    ADD CONSTRAINT portable_import_asset_publications_pkey PRIMARY KEY (operation_id, asset_id);

--
-- Name: portable_import_asset_reservation_intents portable_import_asset_reservation_int_operation_id_asset_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_asset_reservation_intents
    ADD CONSTRAINT portable_import_asset_reservation_int_operation_id_asset_id_key UNIQUE (operation_id, asset_id);

--
-- Name: portable_import_asset_reservation_intents portable_import_asset_reservation_intents_operation_request_uni; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_asset_reservation_intents
    ADD CONSTRAINT portable_import_asset_reservation_intents_operation_request_uni UNIQUE (operation_id, request_id);

--
-- Name: portable_import_asset_reservation_intents portable_import_asset_reservation_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_asset_reservation_intents
    ADD CONSTRAINT portable_import_asset_reservation_intents_pkey PRIMARY KEY (operation_id, ordinal);

--
-- Name: portable_import_normalized_asset_sources portable_import_normalized_as_operation_id_asset_ordinal_so_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_sources
    ADD CONSTRAINT portable_import_normalized_as_operation_id_asset_ordinal_so_key UNIQUE NULLS NOT DISTINCT (operation_id, asset_ordinal, source_kind, source_asset_id, source_record_id, source_key);

--
-- Name: portable_import_normalized_asset_publications portable_import_normalized_as_operation_id_request_fingerpr_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_publications
    ADD CONSTRAINT portable_import_normalized_as_operation_id_request_fingerpr_key UNIQUE (operation_id, request_fingerprint, request_idempotency_key_hash);

--
-- Name: portable_import_normalized_asset_contexts portable_import_normalized_asset_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_contexts
    ADD CONSTRAINT portable_import_normalized_asset_contexts_pkey PRIMARY KEY (operation_id, asset_ordinal, intent_key);

--
-- Name: portable_import_normalized_asset_publications portable_import_normalized_asset_p_request_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_publications
    ADD CONSTRAINT portable_import_normalized_asset_p_request_id_owner_user_id_key UNIQUE (request_id, owner_user_id);

--
-- Name: portable_import_normalized_asset_publications portable_import_normalized_asset_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_publications
    ADD CONSTRAINT portable_import_normalized_asset_publications_pkey PRIMARY KEY (operation_id, asset_ordinal);

--
-- Name: portable_import_normalized_asset_references portable_import_normalized_asset_references_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_references
    ADD CONSTRAINT portable_import_normalized_asset_references_pkey PRIMARY KEY (operation_id, asset_ordinal, intent_key);

--
-- Name: portable_import_normalized_asset_sources portable_import_normalized_asset_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_sources
    ADD CONSTRAINT portable_import_normalized_asset_sources_pkey PRIMARY KEY (operation_id, asset_ordinal, source_ordinal);

--
-- Name: portable_import_operations portable_import_operations_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_operations
    ADD CONSTRAINT portable_import_operations_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: portable_import_operations portable_import_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_operations
    ADD CONSTRAINT portable_import_operations_pkey PRIMARY KEY (id);

--
-- Name: portable_import_operations portable_import_operations_preview_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_operations
    ADD CONSTRAINT portable_import_operations_preview_token_hash_key UNIQUE (preview_token_hash);

--
-- Name: portable_import_work portable_import_work_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_work
    ADD CONSTRAINT portable_import_work_pkey PRIMARY KEY (operation_id);

--
-- Name: portable_staged_inputs portable_staged_inputs_handle_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_staged_inputs
    ADD CONSTRAINT portable_staged_inputs_handle_token_hash_key UNIQUE (handle_token_hash);

--
-- Name: portable_staged_inputs portable_staged_inputs_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_staged_inputs
    ADD CONSTRAINT portable_staged_inputs_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: portable_staged_inputs portable_staged_inputs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_staged_inputs
    ADD CONSTRAINT portable_staged_inputs_pkey PRIMARY KEY (id);

--
-- Name: prepared_text_physical_attempts prepared_text_physical_attemp_logical_kind_reservation_key__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prepared_text_physical_attempts
    ADD CONSTRAINT prepared_text_physical_attemp_logical_kind_reservation_key__key UNIQUE (logical_kind, reservation_key, candidate_ordinal);

--
-- Name: prepared_text_physical_attempts prepared_text_physical_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prepared_text_physical_attempts
    ADD CONSTRAINT prepared_text_physical_attempts_pkey PRIMARY KEY (id);

--
-- Name: private_filesystem_delivery_grants private_filesystem_delivery_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_filesystem_delivery_grants
    ADD CONSTRAINT private_filesystem_delivery_grants_pkey PRIMARY KEY (grant_token_hash);

--
-- Name: private_finalized_asset_delivery_grants private_finalized_asset_delivery_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_finalized_asset_delivery_grants
    ADD CONSTRAINT private_finalized_asset_delivery_grants_pkey PRIMARY KEY (grant_token_hash);

--
-- Name: private_legacy_asset_read_capabilities private_legacy_asset_read_capabilities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_legacy_asset_read_capabilities
    ADD CONSTRAINT private_legacy_asset_read_capabilities_pkey PRIMARY KEY (capability_token_hash);

--
-- Name: prompt_template_overrides prompt_template_overrides_owner_user_id_campaign_id_prompt__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_template_overrides
    ADD CONSTRAINT prompt_template_overrides_owner_user_id_campaign_id_prompt__key UNIQUE NULLS NOT DISTINCT (owner_user_id, campaign_id, prompt_key);

--
-- Name: prompt_template_overrides prompt_template_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_template_overrides
    ADD CONSTRAINT prompt_template_overrides_pkey PRIMARY KEY (id);

--
-- Name: provider_cost_events provider_cost_events_owner_user_id_local_call_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cost_events
    ADD CONSTRAINT provider_cost_events_owner_user_id_local_call_id_key UNIQUE (owner_user_id, local_call_id);

--
-- Name: provider_cost_events provider_cost_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cost_events
    ADD CONSTRAINT provider_cost_events_pkey PRIMARY KEY (id);

--
-- Name: provider_profiles provider_profiles_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_profiles
    ADD CONSTRAINT provider_profiles_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: provider_profiles provider_profiles_owner_user_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_profiles
    ADD CONSTRAINT provider_profiles_owner_user_id_name_key UNIQUE (owner_user_id, name);

--
-- Name: provider_profiles provider_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_profiles
    ADD CONSTRAINT provider_profiles_pkey PRIMARY KEY (id);

--
-- Name: settings_operator_sessions settings_operator_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings_operator_sessions
    ADD CONSTRAINT settings_operator_sessions_pkey PRIMARY KEY (id);

--
-- Name: settings_operator_sessions settings_operator_sessions_token_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings_operator_sessions
    ADD CONSTRAINT settings_operator_sessions_token_digest_key UNIQUE (token_digest);

--
-- Name: settings_unlock_attempts settings_unlock_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings_unlock_attempts
    ADD CONSTRAINT settings_unlock_attempts_pkey PRIMARY KEY (bucket);

--
-- Name: story_activity_events story_activity_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_activity_events
    ADD CONSTRAINT story_activity_events_pkey PRIMARY KEY (event_id);

--
-- Name: story_activity_events story_activity_events_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_activity_events
    ADD CONSTRAINT story_activity_events_sequence_key UNIQUE (sequence);

--
-- Name: summary_checkpoints summary_checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.summary_checkpoints
    ADD CONSTRAINT summary_checkpoints_pkey PRIMARY KEY (id);

--
-- Name: system_archive_jobs system_archive_jobs_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_jobs
    ADD CONSTRAINT system_archive_jobs_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: system_archive_jobs system_archive_jobs_owner_user_id_kind_idempotency_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_jobs
    ADD CONSTRAINT system_archive_jobs_owner_user_id_kind_idempotency_key_hash_key UNIQUE (owner_user_id, kind, idempotency_key_hash);

--
-- Name: system_archive_jobs system_archive_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_jobs
    ADD CONSTRAINT system_archive_jobs_pkey PRIMARY KEY (id);

--
-- Name: system_archive_upload_chunks system_archive_upload_chunks_offset_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_upload_chunks
    ADD CONSTRAINT system_archive_upload_chunks_offset_key UNIQUE (upload_id, byte_offset);

--
-- Name: system_archive_upload_chunks system_archive_upload_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_upload_chunks
    ADD CONSTRAINT system_archive_upload_chunks_pkey PRIMARY KEY (upload_id, chunk_index);

--
-- Name: system_archive_upload_chunks system_archive_upload_chunks_upload_id_owner_user_id_chunk__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_upload_chunks
    ADD CONSTRAINT system_archive_upload_chunks_upload_id_owner_user_id_chunk__key UNIQUE (upload_id, owner_user_id, chunk_index);

--
-- Name: system_archive_uploads system_archive_uploads_filesystem_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_uploads
    ADD CONSTRAINT system_archive_uploads_filesystem_operation_id_key UNIQUE (filesystem_operation_id);

--
-- Name: system_archive_uploads system_archive_uploads_handle_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_uploads
    ADD CONSTRAINT system_archive_uploads_handle_token_hash_key UNIQUE (handle_token_hash);

--
-- Name: system_archive_uploads system_archive_uploads_id_owner_user_id_filesystem_operatio_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_uploads
    ADD CONSTRAINT system_archive_uploads_id_owner_user_id_filesystem_operatio_key UNIQUE (id, owner_user_id, filesystem_operation_id);

--
-- Name: system_archive_uploads system_archive_uploads_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_uploads
    ADD CONSTRAINT system_archive_uploads_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: system_archive_uploads system_archive_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_uploads
    ADD CONSTRAINT system_archive_uploads_pkey PRIMARY KEY (id);

--
-- Name: text_provider_capacity_leases text_provider_capacity_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.text_provider_capacity_leases
    ADD CONSTRAINT text_provider_capacity_leases_pkey PRIMARY KEY (id);

--
-- Name: turn_illustration_segment_assets turn_illustration_segment_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_segment_assets
    ADD CONSTRAINT turn_illustration_segment_assets_pkey PRIMARY KEY (segment_id, variant_index);

--
-- Name: turn_illustration_segment_assets turn_illustration_segment_assets_segment_id_asset_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_segment_assets
    ADD CONSTRAINT turn_illustration_segment_assets_segment_id_asset_id_key UNIQUE (segment_id, asset_id);

--
-- Name: turn_illustration_segments turn_illustration_segments_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_segments
    ADD CONSTRAINT turn_illustration_segments_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: turn_illustration_segments turn_illustration_segments_illustration_set_id_ordinal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_segments
    ADD CONSTRAINT turn_illustration_segments_illustration_set_id_ordinal_key UNIQUE (illustration_set_id, ordinal);

--
-- Name: turn_illustration_segments turn_illustration_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_segments
    ADD CONSTRAINT turn_illustration_segments_pkey PRIMARY KEY (id);

--
-- Name: turn_illustration_sets turn_illustration_sets_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_sets
    ADD CONSTRAINT turn_illustration_sets_id_owner_user_id_key UNIQUE (id, owner_user_id);

--
-- Name: turn_illustration_sets turn_illustration_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_sets
    ADD CONSTRAINT turn_illustration_sets_pkey PRIMARY KEY (id);

--
-- Name: turn_input_classifications turn_input_classifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_input_classifications
    ADD CONSTRAINT turn_input_classifications_pkey PRIMARY KEY (id);

--
-- Name: turn_narration_corrections turn_narration_corrections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_narration_corrections
    ADD CONSTRAINT turn_narration_corrections_pkey PRIMARY KEY (id);

--
-- Name: turn_narration_corrections turn_narration_corrections_turn_id_campaign_id_owner_user_i_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_narration_corrections
    ADD CONSTRAINT turn_narration_corrections_turn_id_campaign_id_owner_user_i_key UNIQUE (turn_id, campaign_id, owner_user_id, revision);

--
-- Name: turns turns_campaign_id_turn_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_campaign_id_turn_number_key UNIQUE (campaign_id, turn_number);

--
-- Name: turns turns_id_campaign_owner_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_id_campaign_owner_unique UNIQUE (id, campaign_id, owner_user_id);

--
-- Name: turns turns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_pkey PRIMARY KEY (id);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Name: users users_system_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_system_key_key UNIQUE (system_key);

--
-- Name: world_drafts world_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_drafts
    ADD CONSTRAINT world_drafts_pkey PRIMARY KEY (world_id);

--
-- Name: world_drafts world_drafts_world_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_drafts
    ADD CONSTRAINT world_drafts_world_id_owner_user_id_key UNIQUE (world_id, owner_user_id);

--
-- Name: world_generation_progress world_generation_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_generation_progress
    ADD CONSTRAINT world_generation_progress_pkey PRIMARY KEY (progress_key);

--
-- Name: world_share_links world_share_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_share_links
    ADD CONSTRAINT world_share_links_pkey PRIMARY KEY (id);

--
-- Name: world_share_links world_share_links_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_share_links
    ADD CONSTRAINT world_share_links_token_hash_key UNIQUE (token_hash);

--
-- Name: world_versions world_versions_id_owner_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_versions
    ADD CONSTRAINT world_versions_id_owner_unique UNIQUE (id, owner_user_id);

--
-- Name: world_versions world_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_versions
    ADD CONSTRAINT world_versions_pkey PRIMARY KEY (id);

--
-- Name: world_versions world_versions_world_id_version_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_versions
    ADD CONSTRAINT world_versions_world_id_version_number_key UNIQUE (world_id, version_number);

--
-- Name: worlds worlds_id_owner_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worlds
    ADD CONSTRAINT worlds_id_owner_unique UNIQUE (id, owner_user_id);

--
-- Name: worlds worlds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worlds
    ADD CONSTRAINT worlds_pkey PRIMARY KEY (id);

--
-- Name: activity_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_outbox_pending ON public.activity_event_outbox USING btree (occurred_at, event_id) WHERE ((published_at IS NULL) AND (quarantine_code IS NULL));

--
-- Name: activity_outbox_receipt_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_outbox_receipt_retention ON public.activity_event_outbox USING btree (published_at, event_id) WHERE ((published_at IS NOT NULL) AND (quarantine_code IS NULL));

--
-- Name: activity_outbox_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_outbox_scope ON public.activity_event_outbox USING btree (owner_user_id, campaign_id);

--
-- Name: api_admission_buckets_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_admission_buckets_expiry_idx ON public.api_admission_buckets USING btree (window_expires_at);

--
-- Name: api_admission_events_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_admission_events_expiry_idx ON public.api_admission_events USING btree (accepted_at);

--
-- Name: api_admission_events_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_admission_events_scope_idx ON public.api_admission_events USING btree (owner_user_id, operation, accepted_at);

--
-- Name: api_admission_leases_scope_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_admission_leases_scope_expiry_idx ON public.api_admission_leases USING btree (owner_user_id, operation, expires_at);

--
-- Name: api_admission_windows_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_admission_windows_expiry_idx ON public.api_admission_windows USING btree (window_expires_at);

--
-- Name: archive_previews_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX archive_previews_expiry_idx ON public.archive_previews USING btree (expires_at);

--
-- Name: archive_previews_owner_fingerprint_destination_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX archive_previews_owner_fingerprint_destination_live_idx ON public.archive_previews USING btree (owner_user_id, archive_type, content_fingerprint, destination_hash) WHERE (status = 'previewed'::text);

--
-- Name: archive_previews_owner_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX archive_previews_owner_scope_idx ON public.archive_previews USING btree (owner_user_id, archive_type, content_fingerprint);

--
-- Name: asset_derivatives_filesystem_operation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX asset_derivatives_filesystem_operation_idx ON public.asset_derivatives USING btree (filesystem_operation_id) WHERE (filesystem_operation_id IS NOT NULL);

--
-- Name: asset_derivatives_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_derivatives_source_idx ON public.asset_derivatives USING btree (owner_user_id, source_asset_id, derivative_kind, pixel_width);

--
-- Name: asset_generation_context_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_generation_context_asset_idx ON public.asset_generation_contexts USING btree (owner_user_id, asset_id, created_at DESC);

--
-- Name: asset_generation_context_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_generation_context_campaign_idx ON public.asset_generation_contexts USING btree (owner_user_id, campaign_id, created_at DESC) WHERE (campaign_id IS NOT NULL);

--
-- Name: asset_generation_context_characters_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_generation_context_characters_idx ON public.asset_generation_contexts USING gin (characters);

--
-- Name: asset_generation_context_entities_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_generation_context_entities_idx ON public.asset_generation_contexts USING gin (entities);

--
-- Name: asset_generation_context_job_variant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX asset_generation_context_job_variant_idx ON public.asset_generation_contexts USING btree (image_job_id, variant_index) WHERE (image_job_id IS NOT NULL);

--
-- Name: asset_generation_context_locations_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_generation_context_locations_idx ON public.asset_generation_contexts USING gin (locations);

--
-- Name: asset_generation_context_world_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_generation_context_world_idx ON public.asset_generation_contexts USING btree (owner_user_id, world_id, world_version_id, created_at DESC) WHERE (world_id IS NOT NULL);

--
-- Name: asset_library_owner_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_library_owner_created_idx ON public.asset_library_entries USING btree (owner_user_id, created_at DESC, asset_id DESC);

--
-- Name: asset_library_owner_favorite_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_library_owner_favorite_idx ON public.asset_library_entries USING btree (owner_user_id, favorite, created_at DESC) WHERE (favorite = true);

--
-- Name: asset_library_owner_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_library_owner_scope_idx ON public.asset_library_entries USING btree (owner_user_id, reuse_scope, review_status, automatic_reuse_enabled, created_at DESC);

--
-- Name: asset_library_tags_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_library_tags_idx ON public.asset_library_entries USING gin (tags);

--
-- Name: asset_metadata_backfill_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_metadata_backfill_claim_idx ON public.asset_metadata_backfill_jobs USING btree (status, next_attempt_at, lease_expires_at, created_at, id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'recoverable'::text]));

--
-- Name: asset_metadata_backfill_publication_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_metadata_backfill_publication_pending_idx ON public.asset_metadata_backfill_publications USING btree (owner_user_id, asset_id) WHERE (lifecycle = 'attached'::text);

--
-- Name: asset_mutation_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_mutation_target_idx ON public.asset_mutation_idempotency USING btree (owner_user_id, mutation_kind, target_asset_id, campaign_id, turn_id, world_id);

--
-- Name: asset_publication_identity_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX asset_publication_identity_idempotency_idx ON public.asset_publication_identities USING btree (owner_user_id, idempotency_key_hash) WHERE (idempotency_key_hash IS NOT NULL);

--
-- Name: asset_references_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_references_campaign_idx ON public.asset_references USING btree (owner_user_id, campaign_id, created_at DESC);

--
-- Name: assets_filesystem_operation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX assets_filesystem_operation_idx ON public.assets USING btree (filesystem_operation_id) WHERE (filesystem_operation_id IS NOT NULL);

--
-- Name: authoring_job_stages_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX authoring_job_stages_claim_idx ON public.authoring_job_stages USING btree (status, next_attempt_at, lease_expires_at, created_at, id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'recoverable'::text]));

--
-- Name: authoring_job_stages_source_review_generation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX authoring_job_stages_source_review_generation_idx ON public.authoring_job_stages USING btree (job_id, source_review_generation) WHERE (source_review_generation IS NOT NULL);

--
-- Name: authoring_jobs_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX authoring_jobs_expiry_idx ON public.authoring_jobs USING btree (expires_at);

--
-- Name: authoring_jobs_owner_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX authoring_jobs_owner_status_created_idx ON public.authoring_jobs USING btree (owner_user_id, status, created_at DESC, id DESC);

--
-- Name: campaign_canonical_facts_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_canonical_facts_active_idx ON public.campaign_canonical_facts USING btree (owner_user_id, campaign_id, source_turn_number DESC) WHERE (valid_until_turn IS NULL);

--
-- Name: campaign_canonical_facts_edit_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX campaign_canonical_facts_edit_source_idx ON public.campaign_canonical_facts USING btree (campaign_id, source_state_edit_id, source_fact_index) WHERE (source_state_edit_id IS NOT NULL);

--
-- Name: campaign_canonical_facts_entity_ids_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_canonical_facts_entity_ids_idx ON public.campaign_canonical_facts USING gin (entity_ids);

--
-- Name: campaign_canonical_facts_normalized_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_canonical_facts_normalized_idx ON public.campaign_canonical_facts USING btree (owner_user_id, campaign_id, normalized_content) WHERE (valid_until_turn IS NULL);

--
-- Name: campaign_cast_detach_review_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX campaign_cast_detach_review_unique ON public.campaign_cast_discovery_candidates USING btree (campaign_id, local_key) WHERE (job_id IS NULL);

--
-- Name: campaign_cast_discovery_candidates_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_cast_discovery_candidates_pending ON public.campaign_cast_discovery_candidates USING btree (campaign_id, created_at, id) WHERE (status = 'pending'::text);

--
-- Name: campaign_cast_discovery_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_cast_discovery_claim ON public.campaign_cast_discovery_jobs USING btree (status, available_at, created_at);

--
-- Name: campaign_cast_discovery_one_running; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX campaign_cast_discovery_one_running ON public.campaign_cast_discovery_jobs USING btree (campaign_id) WHERE (status = 'running'::text);

--
-- Name: campaign_cast_discovery_scan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_cast_discovery_scan ON public.campaign_cast_discovery_jobs USING btree (scan_id) WHERE (scan_id IS NOT NULL);

--
-- Name: campaign_cast_events_boundary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_cast_events_boundary_idx ON public.campaign_cast_events USING btree (campaign_id, effective_turn_number, sequence);

--
-- Name: campaign_cast_observations_character_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_cast_observations_character_idx ON public.campaign_cast_observations USING btree (campaign_id, character_id, sequence);

--
-- Name: campaign_cast_observations_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_cast_observations_source_idx ON public.campaign_cast_observations USING btree (source_turn_id, narration_revision);

--
-- Name: campaign_cast_one_active_scan; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX campaign_cast_one_active_scan ON public.campaign_cast_scans USING btree (campaign_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'paused'::text, 'failed'::text]));

--
-- Name: campaign_cast_one_protagonist_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX campaign_cast_one_protagonist_idx ON public.campaign_cast_characters USING btree (campaign_id) WHERE ((origin ->> 'kind'::text) = 'protagonist'::text);

--
-- Name: campaign_cast_world_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX campaign_cast_world_origin_idx ON public.campaign_cast_characters USING btree (campaign_id, world_version_id, world_entity_id) WHERE ((origin ->> 'kind'::text) = 'world'::text);

--
-- Name: campaign_character_profile_edits_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_character_profile_edits_campaign_idx ON public.campaign_character_profile_edits USING btree (owner_user_id, campaign_id, revision DESC);

--
-- Name: campaign_state_edits_turn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_state_edits_turn_idx ON public.campaign_state_edits USING btree (owner_user_id, campaign_id, effective_turn_number, revision DESC);

--
-- Name: campaign_story_memory_enrollments_owner_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_story_memory_enrollments_owner_campaign_idx ON public.campaign_story_memory_enrollments USING btree (owner_user_id, campaign_id);

--
-- Name: campaign_world_migrations_from_version_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_world_migrations_from_version_scope_idx ON public.campaign_world_migrations USING btree (owner_user_id, from_world_version_id);

--
-- Name: campaign_world_migrations_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_world_migrations_scope_idx ON public.campaign_world_migrations USING btree (owner_user_id, campaign_id, created_at DESC);

--
-- Name: campaign_world_migrations_to_version_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_world_migrations_to_version_scope_idx ON public.campaign_world_migrations USING btree (owner_user_id, to_world_version_id);

--
-- Name: campaign_world_transfers_from_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_world_transfers_from_version_idx ON public.campaign_world_transfers USING btree (owner_user_id, from_world_version_id);

--
-- Name: campaign_world_transfers_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_world_transfers_source_idx ON public.campaign_world_transfers USING btree (owner_user_id, source_campaign_id, created_at DESC) WHERE (source_campaign_id IS NOT NULL);

--
-- Name: campaign_world_transfers_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_world_transfers_target_idx ON public.campaign_world_transfers USING btree (owner_user_id, target_campaign_id, created_at DESC) WHERE (target_campaign_id IS NOT NULL);

--
-- Name: campaign_world_transfers_to_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_world_transfers_to_version_idx ON public.campaign_world_transfers USING btree (owner_user_id, to_world_version_id);

--
-- Name: campaigns_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaigns_owner_idx ON public.campaigns USING btree (owner_user_id, updated_at DESC);

--
-- Name: campaigns_world_version_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaigns_world_version_scope_idx ON public.campaigns USING btree (owner_user_id, world_version_id);

--
-- Name: chronicle_chunk_jobs_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_chunk_jobs_claim_idx ON public.chronicle_chunk_jobs USING btree (status, created_at) WHERE (status = 'queued'::text);

--
-- Name: chronicle_chunk_jobs_one_active_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chronicle_chunk_jobs_one_active_campaign_idx ON public.chronicle_chunk_jobs USING btree (campaign_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

--
-- Name: chronicle_chunk_jobs_running_lease_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_chunk_jobs_running_lease_idx ON public.chronicle_chunk_jobs USING btree (status, lease_expires_at, created_at) WHERE (status = 'running'::text);

--
-- Name: chronicle_jobs_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_jobs_claim_idx ON public.chronicle_jobs USING btree (status, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

--
-- Name: chronicle_jobs_one_active_reindex_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chronicle_jobs_one_active_reindex_idx ON public.chronicle_jobs USING btree (campaign_id, job_type) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

--
-- Name: chronicle_jobs_one_running_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chronicle_jobs_one_running_campaign_idx ON public.chronicle_jobs USING btree (campaign_id) WHERE (status = 'running'::text);

--
-- Name: chronicle_memories_embedding_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_memories_embedding_scope_idx ON public.chronicle_memories USING btree (owner_user_id, campaign_id, embedding_provider_profile_id, embedding_model) WHERE (embedding IS NOT NULL);

--
-- Name: chronicle_memories_entity_ids_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_memories_entity_ids_idx ON public.chronicle_memories USING gin (entity_ids);

--
-- Name: chronicle_memories_world_version_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_memories_world_version_scope_idx ON public.chronicle_memories USING btree (owner_user_id, world_version_id);

--
-- Name: chronicle_memory_chunks_embedded_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_memory_chunks_embedded_scope_idx ON public.chronicle_memory_chunks USING btree (owner_user_id, campaign_id, world_version_id, embedding_provider_profile_id, embedding_model) WHERE (embedding_status = 'embedded'::text);

--
-- Name: chronicle_memory_chunks_entity_ids_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_memory_chunks_entity_ids_idx ON public.chronicle_memory_chunks USING gin (entity_ids);

--
-- Name: chronicle_memory_chunks_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_memory_chunks_scope_idx ON public.chronicle_memory_chunks USING btree (owner_user_id, campaign_id, world_version_id, parent_memory_id, chunk_ordinal);

--
-- Name: chronicle_memory_chunks_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_memory_chunks_search_idx ON public.chronicle_memory_chunks USING gin (search_document);

--
-- Name: chronicle_memory_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_memory_scope_idx ON public.chronicle_memories USING btree (owner_user_id, campaign_id, ordinal DESC);

--
-- Name: chronicle_memory_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_memory_search_idx ON public.chronicle_memories USING gin (search_document);

--
-- Name: chronicle_query_embedding_cache_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_query_embedding_cache_expiry_idx ON public.chronicle_query_embedding_cache USING btree (expires_at);

--
-- Name: chronicle_query_embedding_cache_lru_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_query_embedding_cache_lru_idx ON public.chronicle_query_embedding_cache USING btree (owner_user_id, campaign_id, last_accessed_sequence DESC, last_accessed_at DESC, created_at DESC, id DESC);

--
-- Name: chronicle_retrieval_candidates_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_retrieval_candidates_scope_idx ON public.chronicle_retrieval_candidates USING btree (campaign_id, run_id, implementation, rank);

--
-- Name: chronicle_retrieval_runs_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chronicle_retrieval_runs_retention_idx ON public.chronicle_retrieval_runs USING btree (campaign_id, created_at DESC, id DESC);

--
-- Name: durable_filesystem_candidate_authorities_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX durable_filesystem_candidate_authorities_expiry_idx ON public.durable_filesystem_candidate_authorities USING btree (lifecycle, expires_at, created_at, operation_id) WHERE (lifecycle = 'issued'::text);

--
-- Name: durable_filesystem_candidate_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX durable_filesystem_candidate_hash_idx ON public.durable_filesystem_operations USING btree (candidate_token_hash) WHERE (candidate_token_hash IS NOT NULL);

--
-- Name: durable_filesystem_delivery_descriptor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX durable_filesystem_delivery_descriptor_idx ON public.durable_filesystem_descriptors USING btree (operation_id) WHERE (descriptor_role = 'delivery'::text);

--
-- Name: durable_filesystem_locator_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX durable_filesystem_locator_hash_idx ON public.durable_filesystem_operations USING btree (locator_token_hash) WHERE (locator_token_hash IS NOT NULL);

--
-- Name: durable_filesystem_operations_recovery_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX durable_filesystem_operations_recovery_idx ON public.durable_filesystem_operations USING btree (lifecycle, lease_expires_at, expires_at, created_at, id) WHERE (lifecycle = ANY (ARRAY['reserved'::text, 'attached'::text, 'cleanup_pending'::text]));

--
-- Name: durable_filesystem_portable_expiry_recovery_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX durable_filesystem_portable_expiry_recovery_idx ON public.durable_filesystem_operations USING btree (lifecycle, lease_expires_at, expires_at, created_at, id) WHERE ((resource_kind = 'portable'::text) AND (lifecycle = ANY (ARRAY['reserved'::text, 'attached'::text, 'finalized'::text, 'cleanup_pending'::text])));

--
-- Name: durable_filesystem_prewrite_recovery_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX durable_filesystem_prewrite_recovery_idx ON public.durable_filesystem_prewrite_nodes USING btree (created_at, operation_id);

--
-- Name: generation_attempts_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX generation_attempts_job_idx ON public.generation_attempts USING btree (owner_user_id, generation_job_id, attempt_number);

--
-- Name: generation_jobs_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX generation_jobs_claim_idx ON public.generation_jobs USING btree (status, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'replacement_queued'::text, 'assessing'::text, 'generating'::text, 'validating'::text, 'committing'::text]));

--
-- Name: generation_jobs_one_active_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX generation_jobs_one_active_campaign_idx ON public.generation_jobs USING btree (campaign_id) WHERE (status = ANY (ARRAY['queued'::text, 'assessing'::text, 'generating'::text, 'validating'::text, 'committing'::text, 'indexing'::text]));

--
-- Name: generation_jobs_one_active_per_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX generation_jobs_one_active_per_campaign ON public.generation_jobs USING btree (campaign_id) WHERE (status = ANY (ARRAY['queued'::text, 'replacement_queued'::text, 'assessing'::text, 'generating'::text, 'validating'::text, 'committing'::text, 'recoverable'::text]));

--
-- Name: illustration_prompt_jobs_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX illustration_prompt_jobs_claim_idx ON public.illustration_prompt_jobs USING btree (status, next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'refining'::text, 'recoverable'::text]));

--
-- Name: illustration_resolution_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX illustration_resolution_campaign_idx ON public.illustration_resolution_jobs USING btree (owner_user_id, campaign_id, created_at DESC);

--
-- Name: illustration_resolution_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX illustration_resolution_claim_idx ON public.illustration_resolution_jobs USING btree (status, next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'matching'::text, 'recoverable'::text]));

--
-- Name: illustration_resolution_jobs_legacy_turn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX illustration_resolution_jobs_legacy_turn_idx ON public.illustration_resolution_jobs USING btree (turn_id) WHERE (segment_id IS NULL);

--
-- Name: illustration_resolution_jobs_segment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX illustration_resolution_jobs_segment_idx ON public.illustration_resolution_jobs USING btree (segment_id) WHERE (segment_id IS NOT NULL);

--
-- Name: image_job_asset_publications_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX image_job_asset_publications_pending_idx ON public.image_job_asset_publications USING btree (created_at, image_job_id, variant_index) WHERE (publication_state = 'committed_finalization_pending'::text);

--
-- Name: image_jobs_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX image_jobs_campaign_idx ON public.image_jobs USING btree (owner_user_id, campaign_id, created_at DESC);

--
-- Name: image_jobs_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX image_jobs_claim_idx ON public.image_jobs USING btree (status, next_attempt_at, next_poll_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'generating'::text, 'provider_pending'::text, 'downloading'::text]));

--
-- Name: image_jobs_one_active_legacy_turn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX image_jobs_one_active_legacy_turn_idx ON public.image_jobs USING btree (turn_id) WHERE ((segment_id IS NULL) AND (target_type = 'turn_illustration'::text) AND (status = ANY (ARRAY['queued'::text, 'generating'::text, 'provider_pending'::text, 'downloading'::text])));

--
-- Name: image_jobs_one_active_segment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX image_jobs_one_active_segment_idx ON public.image_jobs USING btree (segment_id) WHERE ((segment_id IS NOT NULL) AND (target_type = 'turn_illustration'::text) AND (status = ANY (ARRAY['queued'::text, 'generating'::text, 'provider_pending'::text, 'downloading'::text])));

--
-- Name: image_jobs_one_active_world_cover_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX image_jobs_one_active_world_cover_idx ON public.image_jobs USING btree (world_id) WHERE ((target_type = 'world_cover'::text) AND (status = ANY (ARRAY['queued'::text, 'generating'::text, 'provider_pending'::text, 'downloading'::text])));

--
-- Name: image_jobs_remote_provider_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX image_jobs_remote_provider_job_idx ON public.image_jobs USING btree (provider_profile_id, remote_job_id) WHERE (remote_job_id IS NOT NULL);

--
-- Name: image_jobs_streaming_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX image_jobs_streaming_claim_idx ON public.image_jobs USING btree (generation_job_id, status, created_at) WHERE ((target_type = 'streaming_illustration'::text) AND (status = ANY (ARRAY['queued'::text, 'generating'::text, 'provider_pending'::text, 'downloading'::text])));

--
-- Name: image_jobs_world_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX image_jobs_world_idx ON public.image_jobs USING btree (owner_user_id, world_id, created_at DESC) WHERE (world_id IS NOT NULL);

--
-- Name: import_progress_status_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_progress_status_expiry_idx ON public.import_progress_status USING btree (expires_at, owner_user_id, lookup_key_hash);

--
-- Name: imports_world_version_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX imports_world_version_scope_idx ON public.imports USING btree (owner_user_id, world_version_id) WHERE (world_version_id IS NOT NULL);

--
-- Name: local_settings_restart_one_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX local_settings_restart_one_pending ON public.local_settings_restart_operations USING btree ((true)) WHERE (status = ANY (ARRAY['draining'::text, 'restarting'::text]));

--
-- Name: model_chains_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX model_chains_scope_idx ON public.model_chains USING btree (owner_user_id, campaign_id, active, updated_at DESC);

--
-- Name: model_chains_world_version_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX model_chains_world_version_scope_idx ON public.model_chains USING btree (owner_user_id, world_version_id);

--
-- Name: portable_export_artifacts_authority_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portable_export_artifacts_authority_lookup_idx ON public.portable_export_artifacts USING btree (owner_user_id, export_kind, campaign_id, world_id, world_version_id, retrieval_token_hash, filesystem_operation_id);

--
-- Name: portable_export_artifacts_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portable_export_artifacts_expiry_idx ON public.portable_export_artifacts USING btree (status, expires_at, created_at, id) WHERE (status = ANY (ARRAY['ready'::text, 'expired'::text, 'cleanup_pending'::text]));

--
-- Name: portable_export_artifacts_filesystem_operation_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX portable_export_artifacts_filesystem_operation_key ON public.portable_export_artifacts USING btree (filesystem_operation_id);

--
-- Name: portable_import_asset_publications_import_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portable_import_asset_publications_import_idx ON public.portable_import_asset_publications USING btree (owner_user_id, import_id, asset_id);

--
-- Name: portable_import_asset_publications_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portable_import_asset_publications_request_idx ON public.portable_import_asset_publications USING btree (owner_user_id, request_id, import_id);

--
-- Name: portable_import_asset_reservation_intents_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portable_import_asset_reservation_intents_owner_idx ON public.portable_import_asset_reservation_intents USING btree (owner_user_id, operation_id, ordinal);

--
-- Name: portable_import_asset_reservation_intents_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portable_import_asset_reservation_intents_request_idx ON public.portable_import_asset_reservation_intents USING btree (owner_user_id, request_id, operation_id);

--
-- Name: portable_import_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX portable_import_idempotency_idx ON public.portable_import_operations USING btree (owner_user_id, import_kind, idempotency_key_hash) WHERE (idempotency_key_hash IS NOT NULL);

--
-- Name: portable_import_live_preview_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX portable_import_live_preview_idx ON public.portable_import_operations USING btree (owner_user_id, import_kind, content_fingerprint, destination_fingerprint) WHERE (status = 'previewed'::text);

--
-- Name: portable_import_normalized_asset_publications_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portable_import_normalized_asset_publications_pending_idx ON public.portable_import_normalized_asset_publications USING btree (owner_user_id, publication_state, created_at, operation_id, asset_ordinal) WHERE (publication_state = ANY (ARRAY['reservation_intent'::text, 'reserved'::text, 'retirement_pending'::text, 'committed_finalization_pending'::text]));

--
-- Name: portable_import_operations_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portable_import_operations_expiry_idx ON public.portable_import_operations USING btree (status, expires_at, created_at, id) WHERE (status = ANY (ARRAY['previewed'::text, 'superseded'::text, 'expired'::text, 'cleanup_pending'::text]));

--
-- Name: portable_import_result_retrieval_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX portable_import_result_retrieval_hash_idx ON public.portable_import_operations USING btree (result_retrieval_token_hash) WHERE (result_retrieval_token_hash IS NOT NULL);

--
-- Name: portable_import_work_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portable_import_work_expiry_idx ON public.portable_import_work USING btree (status, expires_at, updated_at, operation_id) WHERE (status = ANY (ARRAY['running'::text, 'recoverable'::text, 'completed'::text, 'aborted'::text, 'expired'::text]));

--
-- Name: portable_import_work_lease_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portable_import_work_lease_idx ON public.portable_import_work USING btree (status, lease_expires_at, operation_id) WHERE ((lease_id IS NOT NULL) AND (status = ANY (ARRAY['running'::text, 'recoverable'::text])));

--
-- Name: portable_import_work_owner_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portable_import_work_owner_status_idx ON public.portable_import_work USING btree (owner_user_id, status, updated_at DESC, operation_id);

--
-- Name: portable_staged_inputs_authority_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portable_staged_inputs_authority_lookup_idx ON public.portable_staged_inputs USING btree (owner_user_id, handle_token_hash, filesystem_operation_id);

--
-- Name: portable_staged_inputs_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portable_staged_inputs_expiry_idx ON public.portable_staged_inputs USING btree (status, expires_at, created_at, id) WHERE (status = ANY (ARRAY['staged'::text, 'expired'::text, 'cleanup_pending'::text]));

--
-- Name: portable_staged_inputs_filesystem_operation_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX portable_staged_inputs_filesystem_operation_key ON public.portable_staged_inputs USING btree (filesystem_operation_id);

--
-- Name: prepared_text_physical_attempts_owner_reserved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prepared_text_physical_attempts_owner_reserved_idx ON public.prepared_text_physical_attempts USING btree (owner_user_id, reserved_at DESC);

--
-- Name: private_filesystem_delivery_grants_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX private_filesystem_delivery_grants_expiry_idx ON public.private_filesystem_delivery_grants USING btree (lifecycle, expires_at, created_at, operation_id) WHERE (lifecycle = 'issued'::text);

--
-- Name: private_finalized_asset_delivery_grants_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX private_finalized_asset_delivery_grants_expiry_idx ON public.private_finalized_asset_delivery_grants USING btree (lifecycle, expires_at, created_at, grant_token_hash) WHERE (lifecycle = 'issued'::text);

--
-- Name: private_finalized_asset_delivery_grants_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX private_finalized_asset_delivery_grants_scope_idx ON public.private_finalized_asset_delivery_grants USING btree (owner_user_id, asset_id, delivery_intent, selected_row_kind, selected_row_id);

--
-- Name: private_legacy_asset_read_capabilities_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX private_legacy_asset_read_capabilities_expiry_idx ON public.private_legacy_asset_read_capabilities USING btree (lifecycle, expires_at, created_at, capability_token_hash) WHERE (lifecycle = 'issued'::text);

--
-- Name: private_legacy_asset_read_capabilities_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX private_legacy_asset_read_capabilities_scope_idx ON public.private_legacy_asset_read_capabilities USING btree (owner_user_id, asset_id, delivery_intent, selected_row_kind, selected_row_id);

--
-- Name: prompt_template_overrides_owner_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompt_template_overrides_owner_campaign_idx ON public.prompt_template_overrides USING btree (owner_user_id, campaign_id, prompt_key);

--
-- Name: provider_cost_events_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_cost_events_campaign_idx ON public.provider_cost_events USING btree (owner_user_id, campaign_id, currency, occurred_at DESC);

--
-- Name: provider_cost_events_generation_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_cost_events_generation_job_idx ON public.provider_cost_events USING btree (generation_job_id) WHERE (generation_job_id IS NOT NULL);

--
-- Name: provider_cost_events_provider_response_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX provider_cost_events_provider_response_idx ON public.provider_cost_events USING btree (owner_user_id, provider_type, provider_response_id) WHERE ((provider_response_id IS NOT NULL) AND (provider_response_id <> ''::text));

--
-- Name: provider_cost_events_turn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_cost_events_turn_idx ON public.provider_cost_events USING btree (owner_user_id, turn_id, currency) WHERE (turn_id IS NOT NULL);

--
-- Name: provider_profiles_one_default_per_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX provider_profiles_one_default_per_role_idx ON public.provider_profiles USING btree (owner_user_id, provider_role) WHERE (is_default = true);

--
-- Name: provider_profiles_owner_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_profiles_owner_role_idx ON public.provider_profiles USING btree (owner_user_id, provider_role, enabled, updated_at DESC);

--
-- Name: settings_operator_sessions_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX settings_operator_sessions_expiry ON public.settings_operator_sessions USING btree (expires_at);

--
-- Name: story_activity_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX story_activity_retention ON public.story_activity_events USING btree (published_at, sequence);

--
-- Name: story_activity_scope_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX story_activity_scope_sequence ON public.story_activity_events USING btree (owner_user_id, campaign_id, sequence DESC);

--
-- Name: summary_checkpoints_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX summary_checkpoints_scope_idx ON public.summary_checkpoints USING btree (owner_user_id, campaign_id, through_turn DESC);

--
-- Name: system_archive_jobs_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_archive_jobs_claim_idx ON public.system_archive_jobs USING btree (status, lease_expires_at, created_at, id) WHERE (status = ANY (ARRAY['queued'::text, 'capturing'::text, 'writing'::text, 'verifying'::text, 'uploading'::text, 'validating'::text, 'revalidating'::text, 'importing'::text, 'authoritative_committed'::text, 'rebuilding'::text, 'cancelling'::text]));

--
-- Name: system_archive_jobs_one_active_export_per_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX system_archive_jobs_one_active_export_per_owner_idx ON public.system_archive_jobs USING btree (owner_user_id) WHERE ((kind = 'export'::text) AND (status = ANY (ARRAY['queued'::text, 'capturing'::text, 'writing'::text, 'verifying'::text, 'cancelling'::text])));

--
-- Name: system_archive_jobs_one_active_import_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX system_archive_jobs_one_active_import_idx ON public.system_archive_jobs USING btree (kind) WHERE ((kind = 'import'::text) AND (status = ANY (ARRAY['queued'::text, 'uploading'::text, 'validating'::text, 'previewed'::text, 'revalidating'::text, 'waiting_for_gate'::text, 'importing'::text, 'authoritative_committed'::text, 'rebuilding'::text, 'cancelling'::text])));

--
-- Name: system_archive_upload_chunks_range_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_archive_upload_chunks_range_idx ON public.system_archive_upload_chunks USING btree (upload_id, byte_offset, byte_length);

--
-- Name: system_archive_uploads_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_archive_uploads_expiry_idx ON public.system_archive_uploads USING btree (status, expires_at, updated_at, id) WHERE (status = ANY (ARRAY['created'::text, 'uploading'::text, 'expired'::text]));

--
-- Name: text_provider_capacity_leases_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX text_provider_capacity_leases_expiry ON public.text_provider_capacity_leases USING btree (expires_at);

--
-- Name: turn_illustration_segments_turn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX turn_illustration_segments_turn_idx ON public.turn_illustration_segments USING btree (owner_user_id, turn_id, ordinal);

--
-- Name: turn_illustration_sets_active_turn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX turn_illustration_sets_active_turn_idx ON public.turn_illustration_sets USING btree (turn_id) WHERE is_active;

--
-- Name: turn_illustration_sets_generation_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX turn_illustration_sets_generation_job_idx ON public.turn_illustration_sets USING btree (generation_job_id) WHERE (generation_job_id IS NOT NULL);

--
-- Name: turn_illustration_sets_one_provisional_per_generation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX turn_illustration_sets_one_provisional_per_generation ON public.turn_illustration_sets USING btree (generation_job_id) WHERE ((status = 'provisional'::text) AND (generation_job_id IS NOT NULL));

--
-- Name: turn_input_classifications_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX turn_input_classifications_scope_idx ON public.turn_input_classifications USING btree (owner_user_id, campaign_id, created_at DESC);

--
-- Name: turn_narration_corrections_effective_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX turn_narration_corrections_effective_idx ON public.turn_narration_corrections USING btree (owner_user_id, campaign_id, turn_id, revision DESC);

--
-- Name: turns_owner_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX turns_owner_campaign_idx ON public.turns USING btree (owner_user_id, campaign_id, turn_number);

--
-- Name: world_drafts_based_on_version_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX world_drafts_based_on_version_scope_idx ON public.world_drafts USING btree (owner_user_id, based_on_world_version_id) WHERE (based_on_world_version_id IS NOT NULL);

--
-- Name: world_drafts_owner_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX world_drafts_owner_updated_idx ON public.world_drafts USING btree (owner_user_id, updated_at DESC);

--
-- Name: world_generation_progress_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX world_generation_progress_expiry_idx ON public.world_generation_progress USING btree (expires_at);

--
-- Name: world_generation_progress_owner_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX world_generation_progress_owner_key_idx ON public.world_generation_progress USING btree (owner_user_id, progress_key);

--
-- Name: world_share_links_active_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX world_share_links_active_expiry_idx ON public.world_share_links USING btree (expires_at) WHERE (revoked_at IS NULL);

--
-- Name: world_share_links_owner_world_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX world_share_links_owner_world_idx ON public.world_share_links USING btree (owner_user_id, world_id, created_at DESC);

--
-- Name: world_versions_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX world_versions_owner_idx ON public.world_versions USING btree (owner_user_id, world_id);

--
-- Name: worlds_forked_from_version_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worlds_forked_from_version_scope_idx ON public.worlds USING btree (owner_user_id, forked_from_world_version_id) WHERE (forked_from_world_version_id IS NOT NULL);

--
-- Name: worlds_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worlds_owner_idx ON public.worlds USING btree (owner_user_id, updated_at DESC);

--
-- Name: api_admission_recoveries api_admission_recoveries_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER api_admission_recoveries_immutable BEFORE DELETE OR UPDATE ON public.api_admission_recoveries FOR EACH ROW EXECUTE FUNCTION public.protect_instance_settings_evidence();

--
-- Name: asset_derivatives asset_derivatives_filesystem_binding_immutable_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER asset_derivatives_filesystem_binding_immutable_trigger BEFORE UPDATE ON public.asset_derivatives FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_filesystem_binding_immutability();

--
-- Name: durable_filesystem_operations asset_filesystem_identity_lifecycle_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER asset_filesystem_identity_lifecycle_trigger BEFORE INSERT ON public.durable_filesystem_operations FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_filesystem_identity_lifecycle();

--
-- Name: asset_publication_library_initializations asset_publication_library_initializations_mutation_guard_trigge; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER asset_publication_library_initializations_mutation_guard_trigge BEFORE DELETE OR UPDATE ON public.asset_publication_library_initializations FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_publication_library_initialization_mutation();

--
-- Name: asset_publication_request_contexts asset_publication_request_contexts_immutable_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER asset_publication_request_contexts_immutable_trigger BEFORE DELETE OR UPDATE ON public.asset_publication_request_contexts FOR EACH ROW EXECUTE FUNCTION public.reject_asset_publication_request_child_mutation();

--
-- Name: asset_publication_request_derivatives asset_publication_request_derivatives_immutable_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER asset_publication_request_derivatives_immutable_trigger BEFORE DELETE OR UPDATE ON public.asset_publication_request_derivatives FOR EACH ROW EXECUTE FUNCTION public.reject_asset_publication_request_child_mutation();

--
-- Name: asset_publication_request_references asset_publication_request_references_immutable_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER asset_publication_request_references_immutable_trigger BEFORE DELETE OR UPDATE ON public.asset_publication_request_references FOR EACH ROW EXECUTE FUNCTION public.reject_asset_publication_request_child_mutation();

--
-- Name: asset_publication_request_results asset_publication_request_results_immutable_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER asset_publication_request_results_immutable_trigger BEFORE DELETE OR UPDATE ON public.asset_publication_request_results FOR EACH ROW EXECUTE FUNCTION public.reject_asset_publication_request_child_mutation();

--
-- Name: asset_publication_request_sources asset_publication_request_sources_immutable_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER asset_publication_request_sources_immutable_trigger BEFORE DELETE OR UPDATE ON public.asset_publication_request_sources FOR EACH ROW EXECUTE FUNCTION public.reject_asset_publication_request_child_mutation();

--
-- Name: asset_publication_requests asset_publication_requests_canonical_binding_guard_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER asset_publication_requests_canonical_binding_guard_trigger BEFORE INSERT OR UPDATE ON public.asset_publication_requests FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_publication_request_canonical_binding();

--
-- Name: asset_publication_requests asset_publication_requests_mutation_guard_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER asset_publication_requests_mutation_guard_trigger BEFORE DELETE OR UPDATE ON public.asset_publication_requests FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_publication_request_mutation();

--
-- Name: assets assets_filesystem_binding_immutable_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assets_filesystem_binding_immutable_trigger BEFORE UPDATE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_filesystem_binding_immutability();

--
-- Name: authoring_job_stages authoring_job_stages_text_plan_protocol_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER authoring_job_stages_text_plan_protocol_fence BEFORE UPDATE ON public.authoring_job_stages FOR EACH ROW EXECUTE FUNCTION public.fence_authoring_stage_text_plan_protocol();

--
-- Name: authoring_jobs authoring_jobs_text_plan_protocol_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER authoring_jobs_text_plan_protocol_fence BEFORE UPDATE ON public.authoring_jobs FOR EACH ROW EXECUTE FUNCTION public.fence_authoring_job_text_plan_protocol();

--
-- Name: campaigns campaign_story_memory_default_enrollment; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER campaign_story_memory_default_enrollment AFTER INSERT ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.seed_campaign_story_memory_default();

--
-- Name: campaigns campaigns_portable_scope_parent_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER campaigns_portable_scope_parent_trigger BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.protect_portable_scope_parent_update();

--
-- Name: cancelled_dispatch_recoveries cancelled_dispatch_recoveries_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cancelled_dispatch_recoveries_immutable BEFORE DELETE OR UPDATE ON public.cancelled_dispatch_recoveries FOR EACH ROW EXECUTE FUNCTION public.protect_instance_settings_evidence();

--
-- Name: campaign_cast_characters cast_workspace_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_delete AFTER DELETE ON public.campaign_cast_characters REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: campaign_cast_discovery_candidates cast_workspace_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_delete AFTER DELETE ON public.campaign_cast_discovery_candidates REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: campaign_cast_discovery_jobs cast_workspace_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_delete AFTER DELETE ON public.campaign_cast_discovery_jobs REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: campaign_cast_events cast_workspace_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_delete AFTER DELETE ON public.campaign_cast_events REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: campaign_cast_observations cast_workspace_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_delete AFTER DELETE ON public.campaign_cast_observations REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: turns cast_workspace_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_delete AFTER DELETE ON public.turns REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: campaign_cast_characters cast_workspace_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_insert AFTER INSERT ON public.campaign_cast_characters REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: campaign_cast_discovery_candidates cast_workspace_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_insert AFTER INSERT ON public.campaign_cast_discovery_candidates REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: campaign_cast_discovery_jobs cast_workspace_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_insert AFTER INSERT ON public.campaign_cast_discovery_jobs REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: campaign_cast_events cast_workspace_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_insert AFTER INSERT ON public.campaign_cast_events REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: campaign_cast_observations cast_workspace_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_insert AFTER INSERT ON public.campaign_cast_observations REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: turns cast_workspace_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_insert AFTER INSERT ON public.turns REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: campaign_cast_characters cast_workspace_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_update AFTER UPDATE ON public.campaign_cast_characters REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: campaign_cast_discovery_candidates cast_workspace_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_update AFTER UPDATE ON public.campaign_cast_discovery_candidates REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: campaign_cast_discovery_jobs cast_workspace_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_update AFTER UPDATE ON public.campaign_cast_discovery_jobs FOR EACH ROW WHEN (((old.status IS DISTINCT FROM new.status) OR (old.diagnostic_code IS DISTINCT FROM new.diagnostic_code))) EXECUTE FUNCTION public.bump_cast_workspace_revision_row();

--
-- Name: campaign_cast_events cast_workspace_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_update AFTER UPDATE ON public.campaign_cast_events REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: campaign_cast_observations cast_workspace_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_update AFTER UPDATE ON public.campaign_cast_observations REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.bump_cast_workspace_revision_statement();

--
-- Name: turns cast_workspace_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cast_workspace_update AFTER UPDATE ON public.turns FOR EACH ROW WHEN ((old.narration IS DISTINCT FROM new.narration)) EXECUTE FUNCTION public.bump_cast_workspace_revision_row();

--
-- Name: campaigns clear_deleted_campaign_asset_provenance_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER clear_deleted_campaign_asset_provenance_trigger BEFORE DELETE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.clear_deleted_campaign_asset_provenance();

--
-- Name: assets create_default_asset_library_entry_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER create_default_asset_library_entry_trigger AFTER INSERT ON public.assets FOR EACH ROW EXECUTE FUNCTION public.create_default_asset_library_entry();

--
-- Name: assets create_legacy_asset_publication_identity_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER create_legacy_asset_publication_identity_trigger AFTER INSERT ON public.assets FOR EACH ROW EXECUTE FUNCTION public.create_legacy_asset_publication_identity();

--
-- Name: durable_filesystem_operations durable_asset_operation_retention_insert_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER durable_asset_operation_retention_insert_trigger BEFORE INSERT ON public.durable_filesystem_operations FOR EACH ROW EXECUTE FUNCTION public.enforce_durable_asset_operation_retention();

--
-- Name: assets durable_asset_operation_retention_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER durable_asset_operation_retention_trigger BEFORE DELETE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.enforce_durable_asset_operation_retention();

--
-- Name: durable_filesystem_candidate_authorities durable_filesystem_candidate_authorities_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER durable_filesystem_candidate_authorities_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.durable_filesystem_candidate_authorities FOR EACH ROW EXECUTE FUNCTION public.enforce_durable_filesystem_candidate_authority();

--
-- Name: durable_filesystem_descriptors durable_filesystem_descriptors_immutable_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER durable_filesystem_descriptors_immutable_trigger BEFORE DELETE OR UPDATE ON public.durable_filesystem_descriptors FOR EACH ROW EXECUTE FUNCTION public.reject_durable_filesystem_descriptor_mutation();

--
-- Name: durable_filesystem_operations durable_filesystem_operations_authority_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER durable_filesystem_operations_authority_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.durable_filesystem_operations FOR EACH ROW EXECUTE FUNCTION public.enforce_durable_filesystem_operation_authority();

--
-- Name: durable_filesystem_operations durable_filesystem_portable_cleanup_match_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER durable_filesystem_portable_cleanup_match_trigger AFTER INSERT OR DELETE OR UPDATE ON public.durable_filesystem_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_portable_filesystem_cleanup_match();

--
-- Name: durable_filesystem_prewrite_nodes durable_filesystem_prewrite_authority_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER durable_filesystem_prewrite_authority_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.durable_filesystem_prewrite_nodes FOR EACH ROW EXECUTE FUNCTION public.enforce_durable_filesystem_prewrite_authority();

--
-- Name: image_job_asset_publications enforce_image_job_asset_publication_mapping_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_image_job_asset_publication_mapping_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.image_job_asset_publications FOR EACH ROW EXECUTE FUNCTION public.enforce_image_job_asset_publication_mapping();

--
-- Name: generation_jobs generation_jobs_notify_changed_v1; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER generation_jobs_notify_changed_v1 AFTER INSERT OR UPDATE OF status, partial_output, attempts, result_turn_id ON public.generation_jobs FOR EACH ROW EXECUTE FUNCTION public.notify_generation_job_changed_v1();

--
-- Name: generation_jobs generation_jobs_text_plan_protocol_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER generation_jobs_text_plan_protocol_fence BEFORE INSERT OR UPDATE ON public.generation_jobs FOR EACH ROW EXECUTE FUNCTION public.fence_generation_text_plan_protocol();

--
-- Name: illustration_prompt_jobs illustration_prompt_jobs_text_plan_protocol_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER illustration_prompt_jobs_text_plan_protocol_fence BEFORE INSERT OR UPDATE ON public.illustration_prompt_jobs FOR EACH ROW EXECUTE FUNCTION public.fence_illustration_prompt_text_plan_protocol();

--
-- Name: imports imports_portable_scope_parent_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER imports_portable_scope_parent_trigger BEFORE UPDATE ON public.imports FOR EACH ROW EXECUTE FUNCTION public.protect_portable_scope_parent_update();

--
-- Name: instance_settings_events instance_settings_events_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER instance_settings_events_immutable BEFORE DELETE OR UPDATE ON public.instance_settings_events FOR EACH ROW EXECUTE FUNCTION public.protect_instance_settings_evidence();

--
-- Name: instance_settings_revisions instance_settings_revisions_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER instance_settings_revisions_immutable BEFORE DELETE OR UPDATE ON public.instance_settings_revisions FOR EACH ROW EXECUTE FUNCTION public.protect_instance_settings_evidence();

--
-- Name: portable_export_artifacts portable_export_artifacts_authority_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_export_artifacts_authority_trigger BEFORE INSERT OR UPDATE ON public.portable_export_artifacts FOR EACH ROW EXECUTE FUNCTION public.enforce_portable_export_artifact_authority();

--
-- Name: portable_export_artifacts portable_export_artifacts_cleanup_match_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER portable_export_artifacts_cleanup_match_trigger AFTER INSERT OR UPDATE ON public.portable_export_artifacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_portable_filesystem_cleanup_match();

--
-- Name: portable_export_artifacts portable_export_artifacts_deletion_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_export_artifacts_deletion_trigger BEFORE DELETE ON public.portable_export_artifacts FOR EACH ROW EXECUTE FUNCTION public.guard_portable_export_artifact_deletion();

--
-- Name: portable_export_artifacts portable_export_artifacts_scope_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_export_artifacts_scope_trigger BEFORE INSERT OR UPDATE ON public.portable_export_artifacts FOR EACH ROW EXECUTE FUNCTION public.validate_portable_export_artifact_scope();

--
-- Name: portable_export_artifacts portable_export_policy_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_export_policy_immutable BEFORE UPDATE ON public.portable_export_artifacts FOR EACH ROW EXECUTE FUNCTION public.protect_archive_policy_snapshot();

--
-- Name: portable_import_asset_publications portable_import_asset_publications_guard_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_import_asset_publications_guard_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.portable_import_asset_publications FOR EACH ROW EXECUTE FUNCTION public.enforce_portable_import_asset_publication();

--
-- Name: portable_import_asset_reservation_intents portable_import_asset_reservation_intents_guard_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_import_asset_reservation_intents_guard_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.portable_import_asset_reservation_intents FOR EACH ROW EXECUTE FUNCTION public.enforce_portable_import_asset_reservation_intent();

--
-- Name: portable_import_normalized_asset_contexts portable_import_normalized_asset_contexts_guard_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_import_normalized_asset_contexts_guard_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.portable_import_normalized_asset_contexts FOR EACH ROW EXECUTE FUNCTION public.enforce_portable_import_normalized_asset_context();

--
-- Name: portable_import_normalized_asset_publications portable_import_normalized_asset_publications_guard_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_import_normalized_asset_publications_guard_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.portable_import_normalized_asset_publications FOR EACH ROW EXECUTE FUNCTION public.enforce_portable_import_normalized_asset_publication();

--
-- Name: portable_import_normalized_asset_references portable_import_normalized_asset_references_guard_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_import_normalized_asset_references_guard_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.portable_import_normalized_asset_references FOR EACH ROW EXECUTE FUNCTION public.enforce_portable_import_normalized_asset_reference();

--
-- Name: portable_import_normalized_asset_sources portable_import_normalized_asset_sources_guard_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_import_normalized_asset_sources_guard_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.portable_import_normalized_asset_sources FOR EACH ROW EXECUTE FUNCTION public.enforce_portable_import_normalized_asset_source();

--
-- Name: portable_import_operations portable_import_operations_scope_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_import_operations_scope_trigger BEFORE INSERT OR UPDATE ON public.portable_import_operations FOR EACH ROW EXECUTE FUNCTION public.validate_portable_import_operation_scope();

--
-- Name: portable_import_operations portable_import_policy_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_import_policy_immutable BEFORE UPDATE ON public.portable_import_operations FOR EACH ROW EXECUTE FUNCTION public.protect_archive_policy_snapshot();

--
-- Name: portable_import_operations portable_import_private_authority_immutable_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_import_private_authority_immutable_trigger BEFORE UPDATE ON public.portable_import_operations FOR EACH ROW WHEN ((old.normalized_payload IS NOT NULL)) EXECUTE FUNCTION public.enforce_portable_import_private_authority();

--
-- Name: portable_import_work portable_import_work_transition_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_import_work_transition_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.portable_import_work FOR EACH ROW EXECUTE FUNCTION public.enforce_portable_import_work_transition();

--
-- Name: portable_staged_inputs portable_staged_inputs_authority_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portable_staged_inputs_authority_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.portable_staged_inputs FOR EACH ROW EXECUTE FUNCTION public.enforce_portable_staged_input_authority();

--
-- Name: portable_staged_inputs portable_staged_inputs_cleanup_match_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER portable_staged_inputs_cleanup_match_trigger AFTER INSERT OR UPDATE ON public.portable_staged_inputs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_portable_filesystem_cleanup_match();

--
-- Name: private_filesystem_delivery_grants private_filesystem_delivery_grants_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER private_filesystem_delivery_grants_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.private_filesystem_delivery_grants FOR EACH ROW EXECUTE FUNCTION public.enforce_private_filesystem_delivery_grant();

--
-- Name: private_finalized_asset_delivery_grants private_finalized_asset_delivery_grants_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER private_finalized_asset_delivery_grants_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.private_finalized_asset_delivery_grants FOR EACH ROW EXECUTE FUNCTION public.enforce_private_finalized_asset_delivery_grant();

--
-- Name: private_legacy_asset_read_capabilities private_legacy_asset_read_capabilities_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER private_legacy_asset_read_capabilities_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.private_legacy_asset_read_capabilities FOR EACH ROW EXECUTE FUNCTION public.enforce_private_legacy_asset_read_capability();

--
-- Name: system_archive_jobs system_archive_jobs_scope_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER system_archive_jobs_scope_trigger BEFORE INSERT OR UPDATE ON public.system_archive_jobs FOR EACH ROW EXECUTE FUNCTION public.enforce_system_archive_job_scope();

--
-- Name: system_archive_upload_chunks system_archive_upload_chunks_scope_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER system_archive_upload_chunks_scope_trigger BEFORE INSERT OR UPDATE ON public.system_archive_upload_chunks FOR EACH ROW EXECUTE FUNCTION public.enforce_system_archive_upload_chunk_scope();

--
-- Name: system_archive_uploads system_archive_uploads_scope_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER system_archive_uploads_scope_trigger BEFORE INSERT OR UPDATE ON public.system_archive_uploads FOR EACH ROW EXECUTE FUNCTION public.enforce_system_archive_upload_scope();

--
-- Name: system_archive_jobs system_job_policy_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER system_job_policy_immutable BEFORE UPDATE ON public.system_archive_jobs FOR EACH ROW EXECUTE FUNCTION public.protect_archive_policy_snapshot();

--
-- Name: system_archive_uploads system_upload_policy_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER system_upload_policy_immutable BEFORE UPDATE ON public.system_archive_uploads FOR EACH ROW EXECUTE FUNCTION public.protect_archive_policy_snapshot();

--
-- Name: world_versions world_versions_maintain_next_version_number; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER world_versions_maintain_next_version_number AFTER INSERT ON public.world_versions FOR EACH ROW EXECUTE FUNCTION public.maintain_world_next_version_number();

--
-- Name: world_versions world_versions_portable_scope_parent_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER world_versions_portable_scope_parent_trigger BEFORE UPDATE ON public.world_versions FOR EACH ROW EXECUTE FUNCTION public.protect_portable_scope_parent_update();

--
-- Name: activity_event_outbox activity_event_outbox_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_event_outbox
    ADD CONSTRAINT activity_event_outbox_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: activity_event_outbox activity_event_outbox_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_event_outbox
    ADD CONSTRAINT activity_event_outbox_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: activity_events activity_events_campaign_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_events
    ADD CONSTRAINT activity_events_campaign_owner_fk FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: activity_events activity_events_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_events
    ADD CONSTRAINT activity_events_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: api_admission_buckets api_admission_buckets_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_admission_buckets
    ADD CONSTRAINT api_admission_buckets_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: api_admission_events api_admission_events_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_admission_events
    ADD CONSTRAINT api_admission_events_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: api_admission_leases api_admission_leases_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_admission_leases
    ADD CONSTRAINT api_admission_leases_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: api_admission_recoveries api_admission_recoveries_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_admission_recoveries
    ADD CONSTRAINT api_admission_recoveries_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);

--
-- Name: api_admission_recoveries api_admission_recoveries_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_admission_recoveries
    ADD CONSTRAINT api_admission_recoveries_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: api_admission_windows api_admission_windows_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_admission_windows
    ADD CONSTRAINT api_admission_windows_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: archive_previews archive_previews_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.archive_previews
    ADD CONSTRAINT archive_previews_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: archive_previews archive_previews_secure_staged_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.archive_previews
    ADD CONSTRAINT archive_previews_secure_staged_owner_fk FOREIGN KEY (secure_staged_input_id, owner_user_id) REFERENCES public.portable_staged_inputs(id, owner_user_id) NOT VALID;

--
-- Name: asset_derivatives asset_derivatives_filesystem_operation_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_derivatives
    ADD CONSTRAINT asset_derivatives_filesystem_operation_fk FOREIGN KEY (filesystem_operation_id, owner_user_id, filesystem_operation_purpose, source_asset_id) REFERENCES public.durable_filesystem_operations(id, owner_user_id, purpose, asset_id) ON DELETE RESTRICT;

--
-- Name: asset_derivatives asset_derivatives_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_derivatives
    ADD CONSTRAINT asset_derivatives_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: asset_derivatives asset_derivatives_source_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_derivatives
    ADD CONSTRAINT asset_derivatives_source_asset_id_owner_user_id_fkey FOREIGN KEY (source_asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: asset_generation_contexts asset_generation_contexts_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_generation_contexts
    ADD CONSTRAINT asset_generation_contexts_asset_id_owner_user_id_fkey FOREIGN KEY (asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: asset_generation_contexts asset_generation_contexts_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_generation_contexts
    ADD CONSTRAINT asset_generation_contexts_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE SET NULL (campaign_id);

--
-- Name: asset_generation_contexts asset_generation_contexts_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_generation_contexts
    ADD CONSTRAINT asset_generation_contexts_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);

--
-- Name: asset_generation_contexts asset_generation_contexts_image_job_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_generation_contexts
    ADD CONSTRAINT asset_generation_contexts_image_job_id_owner_user_id_fkey FOREIGN KEY (image_job_id, owner_user_id) REFERENCES public.image_jobs(id, owner_user_id) ON DELETE SET NULL (image_job_id);

--
-- Name: asset_generation_contexts asset_generation_contexts_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_generation_contexts
    ADD CONSTRAINT asset_generation_contexts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: asset_generation_contexts asset_generation_contexts_provider_profile_id_owner_user_i_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_generation_contexts
    ADD CONSTRAINT asset_generation_contexts_provider_profile_id_owner_user_i_fkey FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES public.provider_profiles(id, owner_user_id) ON DELETE SET NULL (provider_profile_id);

--
-- Name: asset_generation_contexts asset_generation_contexts_turn_id_campaign_id_owner_user_i_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_generation_contexts
    ADD CONSTRAINT asset_generation_contexts_turn_id_campaign_id_owner_user_i_fkey FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE SET NULL (turn_id);

--
-- Name: asset_generation_contexts asset_generation_contexts_world_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_generation_contexts
    ADD CONSTRAINT asset_generation_contexts_world_id_owner_user_id_fkey FOREIGN KEY (world_id, owner_user_id) REFERENCES public.worlds(id, owner_user_id) ON DELETE SET NULL (world_id);

--
-- Name: asset_generation_contexts asset_generation_contexts_world_version_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_generation_contexts
    ADD CONSTRAINT asset_generation_contexts_world_version_id_owner_user_id_fkey FOREIGN KEY (world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id) ON DELETE SET NULL (world_version_id);

--
-- Name: asset_library_entries asset_library_entries_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_library_entries
    ADD CONSTRAINT asset_library_entries_asset_id_owner_user_id_fkey FOREIGN KEY (asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: asset_library_entries asset_library_entries_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_library_entries
    ADD CONSTRAINT asset_library_entries_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);

--
-- Name: asset_library_entries asset_library_entries_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_library_entries
    ADD CONSTRAINT asset_library_entries_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: asset_metadata_backfill_jobs asset_metadata_backfill_jobs_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_metadata_backfill_jobs
    ADD CONSTRAINT asset_metadata_backfill_jobs_asset_id_owner_user_id_fkey FOREIGN KEY (asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: asset_metadata_backfill_jobs asset_metadata_backfill_jobs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_metadata_backfill_jobs
    ADD CONSTRAINT asset_metadata_backfill_jobs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: asset_metadata_backfill_publications asset_metadata_backfill_publicatio_filesystem_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_metadata_backfill_publications
    ADD CONSTRAINT asset_metadata_backfill_publicatio_filesystem_operation_id_fkey FOREIGN KEY (filesystem_operation_id) REFERENCES public.durable_filesystem_operations(id);

--
-- Name: asset_metadata_backfill_publications asset_metadata_backfill_publication_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_metadata_backfill_publications
    ADD CONSTRAINT asset_metadata_backfill_publication_asset_id_owner_user_id_fkey FOREIGN KEY (asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: asset_mutation_idempotency asset_mutation_idempotency_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_mutation_idempotency
    ADD CONSTRAINT asset_mutation_idempotency_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: asset_mutation_idempotency asset_mutation_idempotency_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_mutation_idempotency
    ADD CONSTRAINT asset_mutation_idempotency_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: asset_mutation_idempotency asset_mutation_idempotency_selected_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_mutation_idempotency
    ADD CONSTRAINT asset_mutation_idempotency_selected_asset_id_owner_user_id_fkey FOREIGN KEY (selected_asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id);

--
-- Name: asset_mutation_idempotency asset_mutation_idempotency_target_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_mutation_idempotency
    ADD CONSTRAINT asset_mutation_idempotency_target_asset_id_owner_user_id_fkey FOREIGN KEY (target_asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: asset_mutation_idempotency asset_mutation_idempotency_turn_id_campaign_id_owner_user__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_mutation_idempotency
    ADD CONSTRAINT asset_mutation_idempotency_turn_id_campaign_id_owner_user__fkey FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: asset_mutation_idempotency asset_mutation_idempotency_world_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_mutation_idempotency
    ADD CONSTRAINT asset_mutation_idempotency_world_id_owner_user_id_fkey FOREIGN KEY (world_id, owner_user_id) REFERENCES public.worlds(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: asset_publication_content_arbitrations asset_publication_content_arb_canonical_asset_id_owner_use_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_content_arbitrations
    ADD CONSTRAINT asset_publication_content_arb_canonical_asset_id_owner_use_fkey FOREIGN KEY (canonical_asset_id, owner_user_id) REFERENCES public.asset_publication_identities(asset_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: asset_publication_content_arbitrations asset_publication_content_arbitrations_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_content_arbitrations
    ADD CONSTRAINT asset_publication_content_arbitrations_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: asset_publication_identities asset_publication_identities_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_identities
    ADD CONSTRAINT asset_publication_identities_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: asset_publication_library_initializations asset_publication_library_ini_canonical_asset_id_owner_use_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_library_initializations
    ADD CONSTRAINT asset_publication_library_ini_canonical_asset_id_owner_use_fkey FOREIGN KEY (canonical_asset_id, owner_user_id) REFERENCES public.asset_publication_identities(asset_id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: asset_publication_library_initializations asset_publication_library_initial_request_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_library_initializations
    ADD CONSTRAINT asset_publication_library_initial_request_id_owner_user_id_fkey FOREIGN KEY (request_id, owner_user_id) REFERENCES public.asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: asset_publication_request_contexts asset_publication_request_context_request_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_request_contexts
    ADD CONSTRAINT asset_publication_request_context_request_id_owner_user_id_fkey FOREIGN KEY (request_id, owner_user_id) REFERENCES public.asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: asset_publication_request_derivatives asset_publication_request_derivat_request_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_request_derivatives
    ADD CONSTRAINT asset_publication_request_derivat_request_id_owner_user_id_fkey FOREIGN KEY (request_id, owner_user_id) REFERENCES public.asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: asset_publication_request_references asset_publication_request_referen_request_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_request_references
    ADD CONSTRAINT asset_publication_request_referen_request_id_owner_user_id_fkey FOREIGN KEY (request_id, owner_user_id) REFERENCES public.asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: asset_publication_request_results asset_publication_request_results_request_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_request_results
    ADD CONSTRAINT asset_publication_request_results_request_id_owner_user_id_fkey FOREIGN KEY (request_id, owner_user_id) REFERENCES public.asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: asset_publication_request_sources asset_publication_request_sources_request_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_request_sources
    ADD CONSTRAINT asset_publication_request_sources_request_id_owner_user_id_fkey FOREIGN KEY (request_id, owner_user_id) REFERENCES public.asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: asset_publication_requests asset_publication_requests_canonical_asset_id_owner_user_i_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_requests
    ADD CONSTRAINT asset_publication_requests_canonical_asset_id_owner_user_i_fkey FOREIGN KEY (canonical_asset_id, owner_user_id) REFERENCES public.asset_publication_identities(asset_id, owner_user_id) ON DELETE SET NULL (canonical_asset_id);

--
-- Name: asset_publication_requests asset_publication_requests_owner_user_id_canonical_content_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_requests
    ADD CONSTRAINT asset_publication_requests_owner_user_id_canonical_content_fkey FOREIGN KEY (owner_user_id, canonical_content_hash) REFERENCES public.asset_publication_content_arbitrations(owner_user_id, content_hash) ON DELETE SET NULL (canonical_content_hash);

--
-- Name: asset_publication_requests asset_publication_requests_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_publication_requests
    ADD CONSTRAINT asset_publication_requests_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: asset_references asset_references_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_references
    ADD CONSTRAINT asset_references_asset_id_owner_user_id_fkey FOREIGN KEY (asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: asset_references asset_references_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_references
    ADD CONSTRAINT asset_references_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: asset_references asset_references_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_references
    ADD CONSTRAINT asset_references_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: asset_references asset_references_turn_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_references
    ADD CONSTRAINT asset_references_turn_owner_fk FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE SET NULL (turn_id);

--
-- Name: assets assets_campaign_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_campaign_owner_fk FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE SET NULL (campaign_id);

--
-- Name: assets assets_filesystem_operation_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_filesystem_operation_fk FOREIGN KEY (filesystem_operation_id, owner_user_id, filesystem_operation_purpose, id) REFERENCES public.durable_filesystem_operations(id, owner_user_id, purpose, asset_id) ON DELETE RESTRICT;

--
-- Name: assets assets_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: assets assets_turn_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_turn_owner_fk FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE SET NULL (turn_id);

--
-- Name: authoring_job_stages authoring_job_stages_job_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authoring_job_stages
    ADD CONSTRAINT authoring_job_stages_job_id_owner_user_id_fkey FOREIGN KEY (job_id, owner_user_id) REFERENCES public.authoring_jobs(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: authoring_jobs authoring_jobs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authoring_jobs
    ADD CONSTRAINT authoring_jobs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: campaign_activity_history campaign_activity_history_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_activity_history
    ADD CONSTRAINT campaign_activity_history_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_activity_history campaign_activity_history_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_activity_history
    ADD CONSTRAINT campaign_activity_history_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: campaign_canonical_facts campaign_canonical_facts_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_canonical_facts
    ADD CONSTRAINT campaign_canonical_facts_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_canonical_facts campaign_canonical_facts_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_canonical_facts
    ADD CONSTRAINT campaign_canonical_facts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: campaign_canonical_facts campaign_canonical_facts_source_edit_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_canonical_facts
    ADD CONSTRAINT campaign_canonical_facts_source_edit_owner_fk FOREIGN KEY (source_state_edit_id, campaign_id, owner_user_id) REFERENCES public.campaign_state_edits(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_canonical_facts campaign_canonical_facts_source_turn_id_campaign_id_owner__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_canonical_facts
    ADD CONSTRAINT campaign_canonical_facts_source_turn_id_campaign_id_owner__fkey FOREIGN KEY (source_turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_canonical_facts campaign_canonical_facts_superseded_by_fact_id_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_canonical_facts
    ADD CONSTRAINT campaign_canonical_facts_superseded_by_fact_id_campaign_id_fkey FOREIGN KEY (superseded_by_fact_id, campaign_id, owner_user_id) REFERENCES public.campaign_canonical_facts(id, campaign_id, owner_user_id) ON DELETE SET NULL (superseded_by_fact_id);

--
-- Name: campaign_canonical_facts campaign_canonical_facts_world_version_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_canonical_facts
    ADD CONSTRAINT campaign_canonical_facts_world_version_id_owner_user_id_fkey FOREIGN KEY (world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: campaign_cast_characters campaign_cast_characters_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_characters
    ADD CONSTRAINT campaign_cast_characters_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaign_cast_state(campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_characters campaign_cast_characters_world_version_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_characters
    ADD CONSTRAINT campaign_cast_characters_world_version_id_owner_user_id_fkey FOREIGN KEY (world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: campaign_cast_discovery_candidates campaign_cast_discovery_candi_job_id_campaign_id_owner_use_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_candidates
    ADD CONSTRAINT campaign_cast_discovery_candi_job_id_campaign_id_owner_use_fkey FOREIGN KEY (job_id, campaign_id, owner_user_id) REFERENCES public.campaign_cast_discovery_jobs(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_discovery_jobs campaign_cast_discovery_jobs_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_jobs
    ADD CONSTRAINT campaign_cast_discovery_jobs_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_discovery_jobs campaign_cast_discovery_jobs_turn_id_campaign_id_owner_use_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_jobs
    ADD CONSTRAINT campaign_cast_discovery_jobs_turn_id_campaign_id_owner_use_fkey FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_discovery_receipts campaign_cast_discovery_recei_job_id_campaign_id_owner_use_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_receipts
    ADD CONSTRAINT campaign_cast_discovery_recei_job_id_campaign_id_owner_use_fkey FOREIGN KEY (job_id, campaign_id, owner_user_id) REFERENCES public.campaign_cast_discovery_jobs(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_discovery_retries campaign_cast_discovery_retri_job_id_campaign_id_owner_use_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_retries
    ADD CONSTRAINT campaign_cast_discovery_retri_job_id_campaign_id_owner_use_fkey FOREIGN KEY (job_id, campaign_id, owner_user_id) REFERENCES public.campaign_cast_discovery_jobs(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_discovery_jobs campaign_cast_discovery_scan_scope; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_jobs
    ADD CONSTRAINT campaign_cast_discovery_scan_scope FOREIGN KEY (scan_id, campaign_id, owner_user_id) REFERENCES public.campaign_cast_scans(id, campaign_id, owner_user_id);

--
-- Name: campaign_cast_events campaign_cast_events_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_events
    ADD CONSTRAINT campaign_cast_events_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaign_cast_state(campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_observations campaign_cast_observations_character_id_campaign_id_owner__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_observations
    ADD CONSTRAINT campaign_cast_observations_character_id_campaign_id_owner__fkey FOREIGN KEY (character_id, campaign_id, owner_user_id) REFERENCES public.campaign_cast_characters(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_observations campaign_cast_observations_event_id_campaign_id_owner_user_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_observations
    ADD CONSTRAINT campaign_cast_observations_event_id_campaign_id_owner_user_fkey FOREIGN KEY (event_id, campaign_id, owner_user_id) REFERENCES public.campaign_cast_events(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_observations campaign_cast_observations_source_turn_id_campaign_id_owne_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_observations
    ADD CONSTRAINT campaign_cast_observations_source_turn_id_campaign_id_owne_fkey FOREIGN KEY (source_turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_observations campaign_cast_observations_speaker_character_id_campaign_i_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_observations
    ADD CONSTRAINT campaign_cast_observations_speaker_character_id_campaign_i_fkey FOREIGN KEY (speaker_character_id, campaign_id, owner_user_id) REFERENCES public.campaign_cast_characters(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_observations campaign_cast_observations_supersedes_observation_id_chara_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_observations
    ADD CONSTRAINT campaign_cast_observations_supersedes_observation_id_chara_fkey FOREIGN KEY (supersedes_observation_id, character_id, field, campaign_id, owner_user_id) REFERENCES public.campaign_cast_observations(id, character_id, field, campaign_id, owner_user_id) DEFERRABLE INITIALLY DEFERRED;

--
-- Name: campaign_cast_observations campaign_cast_observations_world_version_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_observations
    ADD CONSTRAINT campaign_cast_observations_world_version_id_owner_user_id_fkey FOREIGN KEY (world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: campaign_cast_profiles campaign_cast_profiles_character_id_campaign_id_owner_user_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_profiles
    ADD CONSTRAINT campaign_cast_profiles_character_id_campaign_id_owner_user_fkey FOREIGN KEY (character_id, campaign_id, owner_user_id) REFERENCES public.campaign_cast_characters(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_promotion_receipts campaign_cast_promotion_receipts_world_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_promotion_receipts
    ADD CONSTRAINT campaign_cast_promotion_receipts_world_id_owner_user_id_fkey FOREIGN KEY (world_id, owner_user_id) REFERENCES public.world_drafts(world_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_scan_sources campaign_cast_scan_sources_scan_id_campaign_id_owner_user__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_scan_sources
    ADD CONSTRAINT campaign_cast_scan_sources_scan_id_campaign_id_owner_user__fkey FOREIGN KEY (scan_id, campaign_id, owner_user_id) REFERENCES public.campaign_cast_scans(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_scans campaign_cast_scans_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_scans
    ADD CONSTRAINT campaign_cast_scans_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_cast_state campaign_cast_state_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_state
    ADD CONSTRAINT campaign_cast_state_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_character_profile_edits campaign_character_profile_edits_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_character_profile_edits
    ADD CONSTRAINT campaign_character_profile_edits_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_character_profile_edits campaign_character_profile_edits_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_character_profile_edits
    ADD CONSTRAINT campaign_character_profile_edits_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: campaign_illustration_configs campaign_illustration_configs_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_illustration_configs
    ADD CONSTRAINT campaign_illustration_configs_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_illustration_configs campaign_illustration_configs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_illustration_configs
    ADD CONSTRAINT campaign_illustration_configs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: campaign_illustration_configs campaign_illustration_configs_provider_profile_id_owner_us_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_illustration_configs
    ADD CONSTRAINT campaign_illustration_configs_provider_profile_id_owner_us_fkey FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES public.provider_profiles(id, owner_user_id);

--
-- Name: campaign_memory_configs campaign_memory_configs_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_memory_configs
    ADD CONSTRAINT campaign_memory_configs_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_memory_configs campaign_memory_configs_embedding_provider_profile_id_owne_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_memory_configs
    ADD CONSTRAINT campaign_memory_configs_embedding_provider_profile_id_owne_fkey FOREIGN KEY (embedding_provider_profile_id, owner_user_id) REFERENCES public.provider_profiles(id, owner_user_id);

--
-- Name: campaign_memory_configs campaign_memory_configs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_memory_configs
    ADD CONSTRAINT campaign_memory_configs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: campaign_state campaign_state_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_state
    ADD CONSTRAINT campaign_state_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;

--
-- Name: campaign_state campaign_state_campaign_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_state
    ADD CONSTRAINT campaign_state_campaign_owner_fk FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id);

--
-- Name: campaign_state_edits campaign_state_edits_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_state_edits
    ADD CONSTRAINT campaign_state_edits_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_state_edits campaign_state_edits_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_state_edits
    ADD CONSTRAINT campaign_state_edits_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: campaign_state campaign_state_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_state
    ADD CONSTRAINT campaign_state_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: campaign_story_memory_enrollments campaign_story_memory_enrollment_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_story_memory_enrollments
    ADD CONSTRAINT campaign_story_memory_enrollment_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_world_migrations campaign_world_migrations_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_world_migrations
    ADD CONSTRAINT campaign_world_migrations_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: campaign_world_migrations campaign_world_migrations_from_world_version_id_owner_user_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_world_migrations
    ADD CONSTRAINT campaign_world_migrations_from_world_version_id_owner_user_fkey FOREIGN KEY (from_world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id);

--
-- Name: campaign_world_migrations campaign_world_migrations_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_world_migrations
    ADD CONSTRAINT campaign_world_migrations_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: campaign_world_migrations campaign_world_migrations_to_world_version_id_owner_user_i_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_world_migrations
    ADD CONSTRAINT campaign_world_migrations_to_world_version_id_owner_user_i_fkey FOREIGN KEY (to_world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id);

--
-- Name: campaign_world_transfers campaign_world_transfers_from_world_version_id_owner_user__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_world_transfers
    ADD CONSTRAINT campaign_world_transfers_from_world_version_id_owner_user__fkey FOREIGN KEY (from_world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: campaign_world_transfers campaign_world_transfers_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_world_transfers
    ADD CONSTRAINT campaign_world_transfers_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: campaign_world_transfers campaign_world_transfers_source_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_world_transfers
    ADD CONSTRAINT campaign_world_transfers_source_campaign_id_owner_user_id_fkey FOREIGN KEY (source_campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE SET NULL (source_campaign_id);

--
-- Name: campaign_world_transfers campaign_world_transfers_target_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_world_transfers
    ADD CONSTRAINT campaign_world_transfers_target_campaign_id_owner_user_id_fkey FOREIGN KEY (target_campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE SET NULL (target_campaign_id);

--
-- Name: campaign_world_transfers campaign_world_transfers_to_world_version_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_world_transfers
    ADD CONSTRAINT campaign_world_transfers_to_world_version_id_owner_user_id_fkey FOREIGN KEY (to_world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: campaigns campaigns_image_provider_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_image_provider_owner_fk FOREIGN KEY (image_provider_profile_id, owner_user_id) REFERENCES public.provider_profiles(id, owner_user_id);

--
-- Name: campaigns campaigns_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: campaigns campaigns_text_provider_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_text_provider_owner_fk FOREIGN KEY (text_provider_profile_id, owner_user_id) REFERENCES public.provider_profiles(id, owner_user_id);

--
-- Name: campaigns campaigns_world_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_world_version_id_fkey FOREIGN KEY (world_version_id) REFERENCES public.world_versions(id);

--
-- Name: campaigns campaigns_world_version_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_world_version_owner_fk FOREIGN KEY (world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id);

--
-- Name: campaign_cast_discovery_candidates cast_candidate_campaign_owner; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_cast_discovery_candidates
    ADD CONSTRAINT cast_candidate_campaign_owner FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: chronicle_chunk_jobs chronicle_chunk_jobs_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_chunk_jobs
    ADD CONSTRAINT chronicle_chunk_jobs_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: chronicle_jobs chronicle_jobs_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_jobs
    ADD CONSTRAINT chronicle_jobs_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;

--
-- Name: chronicle_jobs chronicle_jobs_campaign_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_jobs
    ADD CONSTRAINT chronicle_jobs_campaign_owner_fk FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id);

--
-- Name: chronicle_jobs chronicle_jobs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_jobs
    ADD CONSTRAINT chronicle_jobs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: chronicle_memories chronicle_memories_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memories
    ADD CONSTRAINT chronicle_memories_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;

--
-- Name: chronicle_memories chronicle_memories_campaign_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memories
    ADD CONSTRAINT chronicle_memories_campaign_owner_fk FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id);

--
-- Name: chronicle_memories chronicle_memories_embedding_provider_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memories
    ADD CONSTRAINT chronicle_memories_embedding_provider_owner_fk FOREIGN KEY (embedding_provider_profile_id, owner_user_id) REFERENCES public.provider_profiles(id, owner_user_id);

--
-- Name: chronicle_memories chronicle_memories_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memories
    ADD CONSTRAINT chronicle_memories_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: chronicle_memories chronicle_memories_turn_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memories
    ADD CONSTRAINT chronicle_memories_turn_owner_fk FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: chronicle_memories chronicle_memories_world_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memories
    ADD CONSTRAINT chronicle_memories_world_version_id_fkey FOREIGN KEY (world_version_id) REFERENCES public.world_versions(id);

--
-- Name: chronicle_memories chronicle_memories_world_version_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memories
    ADD CONSTRAINT chronicle_memories_world_version_owner_fk FOREIGN KEY (world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id);

--
-- Name: chronicle_memory_chunks chronicle_memory_chunks_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memory_chunks
    ADD CONSTRAINT chronicle_memory_chunks_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: chronicle_memory_chunks chronicle_memory_chunks_embedding_provider_profile_id_owne_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memory_chunks
    ADD CONSTRAINT chronicle_memory_chunks_embedding_provider_profile_id_owne_fkey FOREIGN KEY (embedding_provider_profile_id, owner_user_id) REFERENCES public.provider_profiles(id, owner_user_id);

--
-- Name: chronicle_memory_chunks chronicle_memory_chunks_parent_memory_id_owner_user_id_cam_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memory_chunks
    ADD CONSTRAINT chronicle_memory_chunks_parent_memory_id_owner_user_id_cam_fkey FOREIGN KEY (parent_memory_id, owner_user_id, campaign_id, world_version_id) REFERENCES public.chronicle_memories(id, owner_user_id, campaign_id, world_version_id) ON DELETE CASCADE;

--
-- Name: chronicle_memory_chunks chronicle_memory_chunks_world_version_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_memory_chunks
    ADD CONSTRAINT chronicle_memory_chunks_world_version_id_owner_user_id_fkey FOREIGN KEY (world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id);

--
-- Name: chronicle_query_embedding_cache chronicle_query_embedding_cac_provider_profile_id_owner_us_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_query_embedding_cache
    ADD CONSTRAINT chronicle_query_embedding_cac_provider_profile_id_owner_us_fkey FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES public.provider_profiles(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: chronicle_query_embedding_cache chronicle_query_embedding_cache_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_query_embedding_cache
    ADD CONSTRAINT chronicle_query_embedding_cache_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: chronicle_retrieval_candidates chronicle_retrieval_candidate_parent_memory_id_owner_user__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_retrieval_candidates
    ADD CONSTRAINT chronicle_retrieval_candidate_parent_memory_id_owner_user__fkey FOREIGN KEY (parent_memory_id, owner_user_id, campaign_id, world_version_id) REFERENCES public.chronicle_memories(id, owner_user_id, campaign_id, world_version_id) ON DELETE CASCADE;

--
-- Name: chronicle_retrieval_candidates chronicle_retrieval_candidate_run_id_owner_user_id_campaig_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_retrieval_candidates
    ADD CONSTRAINT chronicle_retrieval_candidate_run_id_owner_user_id_campaig_fkey FOREIGN KEY (run_id, owner_user_id, campaign_id, world_version_id) REFERENCES public.chronicle_retrieval_runs(id, owner_user_id, campaign_id, world_version_id) ON DELETE CASCADE;

--
-- Name: chronicle_retrieval_candidates chronicle_retrieval_candidates_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_retrieval_candidates
    ADD CONSTRAINT chronicle_retrieval_candidates_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: chronicle_retrieval_runs chronicle_retrieval_runs_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_retrieval_runs
    ADD CONSTRAINT chronicle_retrieval_runs_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: chronicle_retrieval_runs chronicle_retrieval_runs_world_version_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chronicle_retrieval_runs
    ADD CONSTRAINT chronicle_retrieval_runs_world_version_id_owner_user_id_fkey FOREIGN KEY (world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id);

--
-- Name: durable_filesystem_candidate_authorities durable_filesystem_candidate__operation_id_owner_user_id_p_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_candidate_authorities
    ADD CONSTRAINT durable_filesystem_candidate__operation_id_owner_user_id_p_fkey FOREIGN KEY (operation_id, owner_user_id, purpose) REFERENCES public.durable_filesystem_operations(id, owner_user_id, purpose) ON DELETE RESTRICT;

--
-- Name: durable_filesystem_candidate_authorities durable_filesystem_candidate_authorities_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_candidate_authorities
    ADD CONSTRAINT durable_filesystem_candidate_authorities_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: durable_filesystem_descriptors durable_filesystem_descriptors_operation_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_descriptors
    ADD CONSTRAINT durable_filesystem_descriptors_operation_id_owner_user_id_fkey FOREIGN KEY (operation_id, owner_user_id) REFERENCES public.durable_filesystem_operations(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: durable_filesystem_descriptors durable_filesystem_descriptors_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_descriptors
    ADD CONSTRAINT durable_filesystem_descriptors_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: durable_filesystem_operations durable_filesystem_operations_asset_identity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_operations
    ADD CONSTRAINT durable_filesystem_operations_asset_identity_fk FOREIGN KEY (asset_id, owner_user_id) REFERENCES public.asset_publication_identities(asset_id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: durable_filesystem_operations durable_filesystem_operations_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_operations
    ADD CONSTRAINT durable_filesystem_operations_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: durable_filesystem_prewrite_nodes durable_filesystem_prewrite_n_operation_id_owner_user_id_p_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_prewrite_nodes
    ADD CONSTRAINT durable_filesystem_prewrite_n_operation_id_owner_user_id_p_fkey FOREIGN KEY (operation_id, owner_user_id, purpose) REFERENCES public.durable_filesystem_operations(id, owner_user_id, purpose);

--
-- Name: durable_filesystem_prewrite_nodes durable_filesystem_prewrite_nodes_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_filesystem_prewrite_nodes
    ADD CONSTRAINT durable_filesystem_prewrite_nodes_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: generation_attempts generation_attempts_generation_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_attempts
    ADD CONSTRAINT generation_attempts_generation_job_id_fkey FOREIGN KEY (generation_job_id) REFERENCES public.generation_jobs(id) ON DELETE CASCADE;

--
-- Name: generation_attempts generation_attempts_generation_job_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_attempts
    ADD CONSTRAINT generation_attempts_generation_job_id_owner_user_id_fkey FOREIGN KEY (generation_job_id, owner_user_id) REFERENCES public.generation_jobs(id, owner_user_id);

--
-- Name: generation_attempts generation_attempts_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_attempts
    ADD CONSTRAINT generation_attempts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: generation_jobs generation_jobs_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_jobs
    ADD CONSTRAINT generation_jobs_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;

--
-- Name: generation_jobs generation_jobs_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_jobs
    ADD CONSTRAINT generation_jobs_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id);

--
-- Name: generation_jobs generation_jobs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_jobs
    ADD CONSTRAINT generation_jobs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: generation_jobs generation_jobs_provider_profile_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_jobs
    ADD CONSTRAINT generation_jobs_provider_profile_id_owner_user_id_fkey FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES public.provider_profiles(id, owner_user_id);

--
-- Name: generation_jobs generation_jobs_state_edit_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_jobs
    ADD CONSTRAINT generation_jobs_state_edit_owner_fk FOREIGN KEY (state_edit_id, campaign_id, owner_user_id) REFERENCES public.campaign_state_edits(id, campaign_id, owner_user_id);

--
-- Name: generation_jobs generation_jobs_turn_input_classification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_jobs
    ADD CONSTRAINT generation_jobs_turn_input_classification_id_fkey FOREIGN KEY (turn_input_classification_id) REFERENCES public.turn_input_classifications(id) ON DELETE SET NULL;

--
-- Name: generation_jobs generation_jobs_turn_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_jobs
    ADD CONSTRAINT generation_jobs_turn_owner_fk FOREIGN KEY (result_turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE SET NULL (result_turn_id);

--
-- Name: illustration_backfill_jobs illustration_backfill_jobs_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_backfill_jobs
    ADD CONSTRAINT illustration_backfill_jobs_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: illustration_backfill_jobs illustration_backfill_jobs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_backfill_jobs
    ADD CONSTRAINT illustration_backfill_jobs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: illustration_match_candidates illustration_match_candidates_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_match_candidates
    ADD CONSTRAINT illustration_match_candidates_asset_id_owner_user_id_fkey FOREIGN KEY (asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: illustration_match_candidates illustration_match_candidates_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_match_candidates
    ADD CONSTRAINT illustration_match_candidates_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: illustration_match_candidates illustration_match_candidates_resolution_job_id_owner_user_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_match_candidates
    ADD CONSTRAINT illustration_match_candidates_resolution_job_id_owner_user_fkey FOREIGN KEY (resolution_job_id, owner_user_id) REFERENCES public.illustration_resolution_jobs(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: illustration_prompt_jobs illustration_prompt_jobs_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_prompt_jobs
    ADD CONSTRAINT illustration_prompt_jobs_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: illustration_prompt_jobs illustration_prompt_jobs_generation_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_prompt_jobs
    ADD CONSTRAINT illustration_prompt_jobs_generation_job_id_fkey FOREIGN KEY (generation_job_id) REFERENCES public.generation_jobs(id) ON DELETE SET NULL;

--
-- Name: illustration_prompt_jobs illustration_prompt_jobs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_prompt_jobs
    ADD CONSTRAINT illustration_prompt_jobs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: illustration_prompt_jobs illustration_prompt_jobs_provider_profile_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_prompt_jobs
    ADD CONSTRAINT illustration_prompt_jobs_provider_profile_id_owner_user_id_fkey FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES public.provider_profiles(id, owner_user_id) ON DELETE SET NULL (provider_profile_id);

--
-- Name: illustration_prompt_jobs illustration_prompt_jobs_segment_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_prompt_jobs
    ADD CONSTRAINT illustration_prompt_jobs_segment_id_owner_user_id_fkey FOREIGN KEY (segment_id, owner_user_id) REFERENCES public.turn_illustration_segments(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: illustration_prompt_jobs illustration_prompt_jobs_turn_id_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_prompt_jobs
    ADD CONSTRAINT illustration_prompt_jobs_turn_id_campaign_id_owner_user_id_fkey FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: illustration_resolution_jobs illustration_resolution_jobs_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_resolution_jobs
    ADD CONSTRAINT illustration_resolution_jobs_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: illustration_resolution_jobs illustration_resolution_jobs_image_job_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_resolution_jobs
    ADD CONSTRAINT illustration_resolution_jobs_image_job_id_owner_user_id_fkey FOREIGN KEY (image_job_id, owner_user_id) REFERENCES public.image_jobs(id, owner_user_id) ON DELETE SET NULL (image_job_id);

--
-- Name: illustration_resolution_jobs illustration_resolution_jobs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_resolution_jobs
    ADD CONSTRAINT illustration_resolution_jobs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: illustration_resolution_jobs illustration_resolution_jobs_selected_asset_id_owner_user__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_resolution_jobs
    ADD CONSTRAINT illustration_resolution_jobs_selected_asset_id_owner_user__fkey FOREIGN KEY (selected_asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id) ON DELETE SET NULL (selected_asset_id);

--
-- Name: illustration_resolution_jobs illustration_resolution_jobs_turn_id_campaign_id_owner_use_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_resolution_jobs
    ADD CONSTRAINT illustration_resolution_jobs_turn_id_campaign_id_owner_use_fkey FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: illustration_resolution_jobs illustration_resolution_segment_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.illustration_resolution_jobs
    ADD CONSTRAINT illustration_resolution_segment_owner_fk FOREIGN KEY (segment_id, owner_user_id) REFERENCES public.turn_illustration_segments(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: image_job_asset_publications image_job_asset_publications_image_job_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_job_asset_publications
    ADD CONSTRAINT image_job_asset_publications_image_job_id_owner_user_id_fkey FOREIGN KEY (image_job_id, owner_user_id) REFERENCES public.image_jobs(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: image_job_asset_publications image_job_asset_publications_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_job_asset_publications
    ADD CONSTRAINT image_job_asset_publications_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: image_job_asset_publications image_job_asset_publications_request_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_job_asset_publications
    ADD CONSTRAINT image_job_asset_publications_request_id_owner_user_id_fkey FOREIGN KEY (request_id, owner_user_id) REFERENCES public.asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: image_jobs image_jobs_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_jobs
    ADD CONSTRAINT image_jobs_asset_id_owner_user_id_fkey FOREIGN KEY (asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id);

--
-- Name: image_jobs image_jobs_campaign_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_jobs
    ADD CONSTRAINT image_jobs_campaign_owner_fk FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: image_jobs image_jobs_generation_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_jobs
    ADD CONSTRAINT image_jobs_generation_job_id_fkey FOREIGN KEY (generation_job_id) REFERENCES public.generation_jobs(id) ON DELETE CASCADE;

--
-- Name: image_jobs image_jobs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_jobs
    ADD CONSTRAINT image_jobs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: image_jobs image_jobs_provider_profile_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_jobs
    ADD CONSTRAINT image_jobs_provider_profile_id_owner_user_id_fkey FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES public.provider_profiles(id, owner_user_id);

--
-- Name: image_jobs image_jobs_segment_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_jobs
    ADD CONSTRAINT image_jobs_segment_owner_fk FOREIGN KEY (segment_id, owner_user_id) REFERENCES public.turn_illustration_segments(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: image_jobs image_jobs_turn_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_jobs
    ADD CONSTRAINT image_jobs_turn_owner_fk FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: image_jobs image_jobs_world_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_jobs
    ADD CONSTRAINT image_jobs_world_owner_fk FOREIGN KEY (world_id, owner_user_id) REFERENCES public.worlds(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: import_progress_status import_progress_status_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_progress_status
    ADD CONSTRAINT import_progress_status_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: imports imports_campaign_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imports
    ADD CONSTRAINT imports_campaign_owner_fk FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE SET NULL (campaign_id);

--
-- Name: imports imports_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imports
    ADD CONSTRAINT imports_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: imports imports_world_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imports
    ADD CONSTRAINT imports_world_owner_fk FOREIGN KEY (world_id, owner_user_id) REFERENCES public.worlds(id, owner_user_id) ON DELETE SET NULL (world_id);

--
-- Name: imports imports_world_version_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imports
    ADD CONSTRAINT imports_world_version_owner_fk FOREIGN KEY (world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id) ON DELETE SET NULL (world_version_id);

--
-- Name: instance_settings_events instance_settings_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_settings_events
    ADD CONSTRAINT instance_settings_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);

--
-- Name: instance_settings_events instance_settings_events_revision_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_settings_events
    ADD CONSTRAINT instance_settings_events_revision_fkey FOREIGN KEY (revision) REFERENCES public.instance_settings_revisions(revision);

--
-- Name: instance_settings_revisions instance_settings_revisions_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_settings_revisions
    ADD CONSTRAINT instance_settings_revisions_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);

--
-- Name: instance_settings_revisions instance_settings_revisions_previous_revision_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_settings_revisions
    ADD CONSTRAINT instance_settings_revisions_previous_revision_fkey FOREIGN KEY (previous_revision) REFERENCES public.instance_settings_revisions(revision);

--
-- Name: instance_settings_runtime_reports instance_settings_runtime_reports_active_revision_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_settings_runtime_reports
    ADD CONSTRAINT instance_settings_runtime_reports_active_revision_fkey FOREIGN KEY (active_revision) REFERENCES public.instance_settings_revisions(revision);

--
-- Name: instance_settings_state instance_settings_state_active_revision_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_settings_state
    ADD CONSTRAINT instance_settings_state_active_revision_fkey FOREIGN KEY (active_revision) REFERENCES public.instance_settings_revisions(revision);

--
-- Name: instance_settings_state instance_settings_state_requested_revision_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_settings_state
    ADD CONSTRAINT instance_settings_state_requested_revision_fkey FOREIGN KEY (requested_revision) REFERENCES public.instance_settings_revisions(revision);

--
-- Name: local_settings_restart_operations local_settings_restart_operations_expected_active_revision_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_settings_restart_operations
    ADD CONSTRAINT local_settings_restart_operations_expected_active_revision_fkey FOREIGN KEY (expected_active_revision) REFERENCES public.instance_settings_revisions(revision);

--
-- Name: local_settings_restart_operations local_settings_restart_operations_revision_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_settings_restart_operations
    ADD CONSTRAINT local_settings_restart_operations_revision_fkey FOREIGN KEY (revision) REFERENCES public.instance_settings_revisions(revision);

--
-- Name: model_chains model_chains_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_chains
    ADD CONSTRAINT model_chains_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;

--
-- Name: model_chains model_chains_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_chains
    ADD CONSTRAINT model_chains_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id);

--
-- Name: model_chains model_chains_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_chains
    ADD CONSTRAINT model_chains_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: model_chains model_chains_provider_profile_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_chains
    ADD CONSTRAINT model_chains_provider_profile_id_owner_user_id_fkey FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES public.provider_profiles(id, owner_user_id);

--
-- Name: model_chains model_chains_world_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_chains
    ADD CONSTRAINT model_chains_world_version_id_fkey FOREIGN KEY (world_version_id) REFERENCES public.world_versions(id);

--
-- Name: model_chains model_chains_world_version_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_chains
    ADD CONSTRAINT model_chains_world_version_id_owner_user_id_fkey FOREIGN KEY (world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id);

--
-- Name: portable_export_artifacts portable_export_artifacts_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_export_artifacts
    ADD CONSTRAINT portable_export_artifacts_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id);

--
-- Name: portable_export_artifacts portable_export_artifacts_filesystem_operation_id_owner_us_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_export_artifacts
    ADD CONSTRAINT portable_export_artifacts_filesystem_operation_id_owner_us_fkey FOREIGN KEY (filesystem_operation_id, owner_user_id, filesystem_operation_purpose) REFERENCES public.durable_filesystem_operations(id, owner_user_id, purpose);

--
-- Name: portable_export_artifacts portable_export_artifacts_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_export_artifacts
    ADD CONSTRAINT portable_export_artifacts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: portable_export_artifacts portable_export_artifacts_world_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_export_artifacts
    ADD CONSTRAINT portable_export_artifacts_world_id_owner_user_id_fkey FOREIGN KEY (world_id, owner_user_id) REFERENCES public.worlds(id, owner_user_id);

--
-- Name: portable_export_artifacts portable_export_artifacts_world_version_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_export_artifacts
    ADD CONSTRAINT portable_export_artifacts_world_version_id_owner_user_id_fkey FOREIGN KEY (world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id);

--
-- Name: portable_import_asset_publications portable_import_asset_publicati_operation_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_asset_publications
    ADD CONSTRAINT portable_import_asset_publicati_operation_id_owner_user_id_fkey FOREIGN KEY (operation_id, owner_user_id) REFERENCES public.portable_import_operations(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: portable_import_asset_publications portable_import_asset_publications_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_asset_publications
    ADD CONSTRAINT portable_import_asset_publications_asset_id_owner_user_id_fkey FOREIGN KEY (asset_id, owner_user_id) REFERENCES public.asset_publication_identities(asset_id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: portable_import_asset_publications portable_import_asset_publications_import_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_asset_publications
    ADD CONSTRAINT portable_import_asset_publications_import_id_owner_user_id_fkey FOREIGN KEY (import_id, owner_user_id) REFERENCES public.imports(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: portable_import_asset_publications portable_import_asset_publications_request_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_asset_publications
    ADD CONSTRAINT portable_import_asset_publications_request_fk FOREIGN KEY (request_id, owner_user_id) REFERENCES public.asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: portable_import_asset_reservation_intents portable_import_asset_reservati_operation_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_asset_reservation_intents
    ADD CONSTRAINT portable_import_asset_reservati_operation_id_owner_user_id_fkey FOREIGN KEY (operation_id, owner_user_id) REFERENCES public.portable_import_operations(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: portable_import_asset_reservation_intents portable_import_asset_reservation_i_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_asset_reservation_intents
    ADD CONSTRAINT portable_import_asset_reservation_i_asset_id_owner_user_id_fkey FOREIGN KEY (asset_id, owner_user_id) REFERENCES public.asset_publication_identities(asset_id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: portable_import_asset_reservation_intents portable_import_asset_reservation_intents_request_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_asset_reservation_intents
    ADD CONSTRAINT portable_import_asset_reservation_intents_request_fk FOREIGN KEY (request_id, owner_user_id) REFERENCES public.asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: portable_import_normalized_asset_contexts portable_import_normalized_ass_operation_id_asset_ordinal_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_contexts
    ADD CONSTRAINT portable_import_normalized_ass_operation_id_asset_ordinal_fkey1 FOREIGN KEY (operation_id, asset_ordinal) REFERENCES public.portable_import_normalized_asset_publications(operation_id, asset_ordinal) ON DELETE RESTRICT;

--
-- Name: portable_import_normalized_asset_references portable_import_normalized_ass_operation_id_asset_ordinal_fkey2; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_references
    ADD CONSTRAINT portable_import_normalized_ass_operation_id_asset_ordinal_fkey2 FOREIGN KEY (operation_id, asset_ordinal) REFERENCES public.portable_import_normalized_asset_publications(operation_id, asset_ordinal) ON DELETE RESTRICT;

--
-- Name: portable_import_normalized_asset_sources portable_import_normalized_ass_operation_id_owner_user_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_sources
    ADD CONSTRAINT portable_import_normalized_ass_operation_id_owner_user_id_fkey1 FOREIGN KEY (operation_id, owner_user_id) REFERENCES public.portable_import_operations(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: portable_import_normalized_asset_contexts portable_import_normalized_ass_operation_id_owner_user_id_fkey2; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_contexts
    ADD CONSTRAINT portable_import_normalized_ass_operation_id_owner_user_id_fkey2 FOREIGN KEY (operation_id, owner_user_id) REFERENCES public.portable_import_operations(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: portable_import_normalized_asset_references portable_import_normalized_ass_operation_id_owner_user_id_fkey3; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_references
    ADD CONSTRAINT portable_import_normalized_ass_operation_id_owner_user_id_fkey3 FOREIGN KEY (operation_id, owner_user_id) REFERENCES public.portable_import_operations(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: portable_import_normalized_asset_sources portable_import_normalized_asse_operation_id_asset_ordinal_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_sources
    ADD CONSTRAINT portable_import_normalized_asse_operation_id_asset_ordinal_fkey FOREIGN KEY (operation_id, asset_ordinal) REFERENCES public.portable_import_normalized_asset_publications(operation_id, asset_ordinal) ON DELETE RESTRICT;

--
-- Name: portable_import_normalized_asset_publications portable_import_normalized_asse_operation_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_publications
    ADD CONSTRAINT portable_import_normalized_asse_operation_id_owner_user_id_fkey FOREIGN KEY (operation_id, owner_user_id) REFERENCES public.portable_import_operations(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: portable_import_normalized_asset_publications portable_import_normalized_asset__request_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_publications
    ADD CONSTRAINT portable_import_normalized_asset__request_id_owner_user_id_fkey FOREIGN KEY (request_id, owner_user_id) REFERENCES public.asset_publication_requests(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: portable_import_normalized_asset_publications portable_import_normalized_asset_p_import_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_publications
    ADD CONSTRAINT portable_import_normalized_asset_p_import_id_owner_user_id_fkey FOREIGN KEY (import_id, owner_user_id) REFERENCES public.imports(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: portable_import_normalized_asset_publications portable_import_normalized_asset_publication_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_normalized_asset_publications
    ADD CONSTRAINT portable_import_normalized_asset_publication_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: portable_import_operations portable_import_operations_destination_world_id_owner_user_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_operations
    ADD CONSTRAINT portable_import_operations_destination_world_id_owner_user_fkey FOREIGN KEY (destination_world_id, owner_user_id) REFERENCES public.worlds(id, owner_user_id);

--
-- Name: portable_import_operations portable_import_operations_destination_world_version_id_ow_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_operations
    ADD CONSTRAINT portable_import_operations_destination_world_version_id_ow_fkey FOREIGN KEY (destination_world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id);

--
-- Name: portable_import_operations portable_import_operations_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_operations
    ADD CONSTRAINT portable_import_operations_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.imports(id);

--
-- Name: portable_import_operations portable_import_operations_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_operations
    ADD CONSTRAINT portable_import_operations_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: portable_import_operations portable_import_operations_staged_input_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_operations
    ADD CONSTRAINT portable_import_operations_staged_input_id_owner_user_id_fkey FOREIGN KEY (staged_input_id, owner_user_id) REFERENCES public.portable_staged_inputs(id, owner_user_id);

--
-- Name: portable_import_work portable_import_work_operation_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_import_work
    ADD CONSTRAINT portable_import_work_operation_id_owner_user_id_fkey FOREIGN KEY (operation_id, owner_user_id) REFERENCES public.portable_import_operations(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: portable_staged_inputs portable_staged_inputs_filesystem_operation_id_owner_user__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_staged_inputs
    ADD CONSTRAINT portable_staged_inputs_filesystem_operation_id_owner_user__fkey FOREIGN KEY (filesystem_operation_id, owner_user_id, filesystem_operation_purpose) REFERENCES public.durable_filesystem_operations(id, owner_user_id, purpose);

--
-- Name: portable_staged_inputs portable_staged_inputs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portable_staged_inputs
    ADD CONSTRAINT portable_staged_inputs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: prepared_text_physical_attempts prepared_text_physical_attempts_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prepared_text_physical_attempts
    ADD CONSTRAINT prepared_text_physical_attempts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: private_filesystem_delivery_grants private_filesystem_delivery_g_candidate_token_hash_operati_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_filesystem_delivery_grants
    ADD CONSTRAINT private_filesystem_delivery_g_candidate_token_hash_operati_fkey FOREIGN KEY (candidate_token_hash, operation_id, owner_user_id, purpose) REFERENCES public.durable_filesystem_candidate_authorities(candidate_token_hash, operation_id, owner_user_id, purpose) ON DELETE RESTRICT;

--
-- Name: private_filesystem_delivery_grants private_filesystem_delivery_g_operation_id_owner_user_id_d_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_filesystem_delivery_grants
    ADD CONSTRAINT private_filesystem_delivery_g_operation_id_owner_user_id_d_fkey FOREIGN KEY (operation_id, owner_user_id, descriptor_role, descriptor_ordinal) REFERENCES public.durable_filesystem_descriptors(operation_id, owner_user_id, descriptor_role, ordinal) ON DELETE RESTRICT;

--
-- Name: private_filesystem_delivery_grants private_filesystem_delivery_grants_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_filesystem_delivery_grants
    ADD CONSTRAINT private_filesystem_delivery_grants_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: private_finalized_asset_delivery_grants private_finalized_asset_deliv_candidate_token_hash_operati_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_finalized_asset_delivery_grants
    ADD CONSTRAINT private_finalized_asset_deliv_candidate_token_hash_operati_fkey FOREIGN KEY (candidate_token_hash, operation_id, owner_user_id, operation_purpose) REFERENCES public.durable_filesystem_candidate_authorities(candidate_token_hash, operation_id, owner_user_id, purpose) ON DELETE RESTRICT;

--
-- Name: private_finalized_asset_delivery_grants private_finalized_asset_deliv_operation_id_owner_user_id_d_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_finalized_asset_delivery_grants
    ADD CONSTRAINT private_finalized_asset_deliv_operation_id_owner_user_id_d_fkey FOREIGN KEY (operation_id, owner_user_id, descriptor_role, descriptor_ordinal) REFERENCES public.durable_filesystem_descriptors(operation_id, owner_user_id, descriptor_role, ordinal) ON DELETE RESTRICT;

--
-- Name: private_finalized_asset_delivery_grants private_finalized_asset_deliv_operation_id_owner_user_id_o_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_finalized_asset_delivery_grants
    ADD CONSTRAINT private_finalized_asset_deliv_operation_id_owner_user_id_o_fkey FOREIGN KEY (operation_id, owner_user_id, operation_purpose, asset_id) REFERENCES public.durable_filesystem_operations(id, owner_user_id, purpose, asset_id) ON DELETE RESTRICT;

--
-- Name: private_finalized_asset_delivery_grants private_finalized_asset_delivery_gr_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_finalized_asset_delivery_grants
    ADD CONSTRAINT private_finalized_asset_delivery_gr_asset_id_owner_user_id_fkey FOREIGN KEY (asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: private_finalized_asset_delivery_grants private_finalized_asset_delivery_grants_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_finalized_asset_delivery_grants
    ADD CONSTRAINT private_finalized_asset_delivery_grants_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: private_legacy_asset_read_capabilities private_legacy_asset_read_capabilit_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_legacy_asset_read_capabilities
    ADD CONSTRAINT private_legacy_asset_read_capabilit_asset_id_owner_user_id_fkey FOREIGN KEY (asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: private_legacy_asset_read_capabilities private_legacy_asset_read_capabilities_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_legacy_asset_read_capabilities
    ADD CONSTRAINT private_legacy_asset_read_capabilities_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: prompt_template_overrides prompt_template_overrides_campaign_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_template_overrides
    ADD CONSTRAINT prompt_template_overrides_campaign_owner_fk FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: CONSTRAINT prompt_template_overrides_campaign_owner_fk ON prompt_template_overrides; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT prompt_template_overrides_campaign_owner_fk ON public.prompt_template_overrides IS 'Campaign prompt overrides must belong to the same owner as their campaign.';

--
-- Name: prompt_template_overrides prompt_template_overrides_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_template_overrides
    ADD CONSTRAINT prompt_template_overrides_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: provider_cost_events provider_cost_events_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cost_events
    ADD CONSTRAINT provider_cost_events_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: provider_cost_events provider_cost_events_chronicle_job_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cost_events
    ADD CONSTRAINT provider_cost_events_chronicle_job_id_owner_user_id_fkey FOREIGN KEY (chronicle_job_id, owner_user_id) REFERENCES public.chronicle_jobs(id, owner_user_id) ON DELETE SET NULL (chronicle_job_id);

--
-- Name: provider_cost_events provider_cost_events_generation_job_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cost_events
    ADD CONSTRAINT provider_cost_events_generation_job_id_owner_user_id_fkey FOREIGN KEY (generation_job_id, owner_user_id) REFERENCES public.generation_jobs(id, owner_user_id) ON DELETE SET NULL (generation_job_id);

--
-- Name: provider_cost_events provider_cost_events_image_job_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cost_events
    ADD CONSTRAINT provider_cost_events_image_job_id_owner_user_id_fkey FOREIGN KEY (image_job_id, owner_user_id) REFERENCES public.image_jobs(id, owner_user_id) ON DELETE SET NULL (image_job_id);

--
-- Name: provider_cost_events provider_cost_events_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cost_events
    ADD CONSTRAINT provider_cost_events_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: provider_cost_events provider_cost_events_provider_profile_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cost_events
    ADD CONSTRAINT provider_cost_events_provider_profile_id_owner_user_id_fkey FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES public.provider_profiles(id, owner_user_id) ON DELETE SET NULL (provider_profile_id);

--
-- Name: provider_cost_events provider_cost_events_turn_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cost_events
    ADD CONSTRAINT provider_cost_events_turn_owner_fk FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE SET NULL (turn_id);

--
-- Name: provider_profiles provider_profiles_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_profiles
    ADD CONSTRAINT provider_profiles_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: settings_operator_sessions settings_operator_sessions_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings_operator_sessions
    ADD CONSTRAINT settings_operator_sessions_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);

--
-- Name: story_activity_events story_activity_events_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_activity_events
    ADD CONSTRAINT story_activity_events_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: story_activity_events story_activity_events_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_activity_events
    ADD CONSTRAINT story_activity_events_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: summary_checkpoints summary_checkpoints_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.summary_checkpoints
    ADD CONSTRAINT summary_checkpoints_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;

--
-- Name: summary_checkpoints summary_checkpoints_campaign_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.summary_checkpoints
    ADD CONSTRAINT summary_checkpoints_campaign_owner_fk FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id);

--
-- Name: summary_checkpoints summary_checkpoints_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.summary_checkpoints
    ADD CONSTRAINT summary_checkpoints_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: system_archive_jobs system_archive_jobs_export_artifact_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_jobs
    ADD CONSTRAINT system_archive_jobs_export_artifact_id_owner_user_id_fkey FOREIGN KEY (export_artifact_id, owner_user_id) REFERENCES public.portable_export_artifacts(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: system_archive_jobs system_archive_jobs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_jobs
    ADD CONSTRAINT system_archive_jobs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: system_archive_jobs system_archive_jobs_staged_input_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_jobs
    ADD CONSTRAINT system_archive_jobs_staged_input_id_owner_user_id_fkey FOREIGN KEY (staged_input_id, owner_user_id) REFERENCES public.portable_staged_inputs(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: system_archive_upload_chunks system_archive_upload_chunks_filesystem_operation_id_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_upload_chunks
    ADD CONSTRAINT system_archive_upload_chunks_filesystem_operation_id_owner_fkey FOREIGN KEY (filesystem_operation_id, owner_user_id, filesystem_operation_purpose) REFERENCES public.durable_filesystem_operations(id, owner_user_id, purpose) ON DELETE RESTRICT;

--
-- Name: system_archive_upload_chunks system_archive_upload_chunks_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_upload_chunks
    ADD CONSTRAINT system_archive_upload_chunks_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: system_archive_upload_chunks system_archive_upload_chunks_upload_id_owner_user_id_files_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_upload_chunks
    ADD CONSTRAINT system_archive_upload_chunks_upload_id_owner_user_id_files_fkey FOREIGN KEY (upload_id, owner_user_id, filesystem_operation_id) REFERENCES public.system_archive_uploads(id, owner_user_id, filesystem_operation_id) ON DELETE CASCADE;

--
-- Name: system_archive_uploads system_archive_uploads_filesystem_operation_id_owner_user__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_uploads
    ADD CONSTRAINT system_archive_uploads_filesystem_operation_id_owner_user__fkey FOREIGN KEY (filesystem_operation_id, owner_user_id, filesystem_operation_purpose) REFERENCES public.durable_filesystem_operations(id, owner_user_id, purpose) ON DELETE RESTRICT;

--
-- Name: system_archive_uploads system_archive_uploads_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_uploads
    ADD CONSTRAINT system_archive_uploads_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: system_archive_uploads system_archive_uploads_staged_input_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_archive_uploads
    ADD CONSTRAINT system_archive_uploads_staged_input_id_owner_user_id_fkey FOREIGN KEY (staged_input_id, owner_user_id) REFERENCES public.portable_staged_inputs(id, owner_user_id) ON DELETE RESTRICT;

--
-- Name: turn_illustration_segment_assets turn_illustration_segment_asset_image_job_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_segment_assets
    ADD CONSTRAINT turn_illustration_segment_asset_image_job_id_owner_user_id_fkey FOREIGN KEY (image_job_id, owner_user_id) REFERENCES public.image_jobs(id, owner_user_id) ON DELETE SET NULL (image_job_id);

--
-- Name: turn_illustration_segment_assets turn_illustration_segment_assets_asset_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_segment_assets
    ADD CONSTRAINT turn_illustration_segment_assets_asset_id_owner_user_id_fkey FOREIGN KEY (asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: turn_illustration_segment_assets turn_illustration_segment_assets_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_segment_assets
    ADD CONSTRAINT turn_illustration_segment_assets_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: turn_illustration_segment_assets turn_illustration_segment_assets_segment_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_segment_assets
    ADD CONSTRAINT turn_illustration_segment_assets_segment_id_owner_user_id_fkey FOREIGN KEY (segment_id, owner_user_id) REFERENCES public.turn_illustration_segments(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: turn_illustration_segments turn_illustration_segments_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_segments
    ADD CONSTRAINT turn_illustration_segments_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: turn_illustration_segments turn_illustration_segments_generation_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_segments
    ADD CONSTRAINT turn_illustration_segments_generation_job_id_fkey FOREIGN KEY (generation_job_id) REFERENCES public.generation_jobs(id) ON DELETE SET NULL;

--
-- Name: turn_illustration_segments turn_illustration_segments_illustration_set_id_owner_user__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_segments
    ADD CONSTRAINT turn_illustration_segments_illustration_set_id_owner_user__fkey FOREIGN KEY (illustration_set_id, owner_user_id) REFERENCES public.turn_illustration_sets(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: turn_illustration_segments turn_illustration_segments_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_segments
    ADD CONSTRAINT turn_illustration_segments_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: turn_illustration_segments turn_illustration_segments_turn_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_segments
    ADD CONSTRAINT turn_illustration_segments_turn_owner_fk FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: turn_illustration_sets turn_illustration_sets_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_sets
    ADD CONSTRAINT turn_illustration_sets_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: turn_illustration_sets turn_illustration_sets_generation_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_sets
    ADD CONSTRAINT turn_illustration_sets_generation_job_id_fkey FOREIGN KEY (generation_job_id) REFERENCES public.generation_jobs(id) ON DELETE SET NULL;

--
-- Name: turn_illustration_sets turn_illustration_sets_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_sets
    ADD CONSTRAINT turn_illustration_sets_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: turn_illustration_sets turn_illustration_sets_turn_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_illustration_sets
    ADD CONSTRAINT turn_illustration_sets_turn_owner_fk FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: turn_input_classifications turn_input_classifications_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_input_classifications
    ADD CONSTRAINT turn_input_classifications_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;

--
-- Name: turn_input_classifications turn_input_classifications_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_input_classifications
    ADD CONSTRAINT turn_input_classifications_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id);

--
-- Name: turn_input_classifications turn_input_classifications_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_input_classifications
    ADD CONSTRAINT turn_input_classifications_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: turn_input_classifications turn_input_classifications_provider_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_input_classifications
    ADD CONSTRAINT turn_input_classifications_provider_profile_id_fkey FOREIGN KEY (provider_profile_id) REFERENCES public.provider_profiles(id) ON DELETE SET NULL;

--
-- Name: turn_narration_corrections turn_narration_corrections_campaign_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_narration_corrections
    ADD CONSTRAINT turn_narration_corrections_campaign_id_owner_user_id_fkey FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: turn_narration_corrections turn_narration_corrections_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_narration_corrections
    ADD CONSTRAINT turn_narration_corrections_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);

--
-- Name: turn_narration_corrections turn_narration_corrections_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_narration_corrections
    ADD CONSTRAINT turn_narration_corrections_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: turn_narration_corrections turn_narration_corrections_turn_id_campaign_id_owner_user__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turn_narration_corrections
    ADD CONSTRAINT turn_narration_corrections_turn_id_campaign_id_owner_user__fkey FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES public.turns(id, campaign_id, owner_user_id) ON DELETE CASCADE;

--
-- Name: turns turns_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;

--
-- Name: turns turns_campaign_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_campaign_owner_fk FOREIGN KEY (campaign_id, owner_user_id) REFERENCES public.campaigns(id, owner_user_id);

--
-- Name: turns turns_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: world_drafts world_drafts_based_on_world_version_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_drafts
    ADD CONSTRAINT world_drafts_based_on_world_version_owner_fk FOREIGN KEY (based_on_world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id) ON DELETE SET NULL (based_on_world_version_id);

--
-- Name: world_drafts world_drafts_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_drafts
    ADD CONSTRAINT world_drafts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: world_drafts world_drafts_world_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_drafts
    ADD CONSTRAINT world_drafts_world_id_owner_user_id_fkey FOREIGN KEY (world_id, owner_user_id) REFERENCES public.worlds(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: world_generation_progress world_generation_progress_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_generation_progress
    ADD CONSTRAINT world_generation_progress_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: world_share_links world_share_links_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_share_links
    ADD CONSTRAINT world_share_links_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: world_share_links world_share_links_version_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_share_links
    ADD CONSTRAINT world_share_links_version_owner_fk FOREIGN KEY (world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: world_share_links world_share_links_world_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_share_links
    ADD CONSTRAINT world_share_links_world_owner_fk FOREIGN KEY (world_id, owner_user_id) REFERENCES public.worlds(id, owner_user_id) ON DELETE CASCADE;

--
-- Name: world_versions world_versions_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_versions
    ADD CONSTRAINT world_versions_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--
-- Name: world_versions world_versions_world_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_versions
    ADD CONSTRAINT world_versions_world_id_fkey FOREIGN KEY (world_id) REFERENCES public.worlds(id);

--
-- Name: world_versions world_versions_world_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_versions
    ADD CONSTRAINT world_versions_world_owner_fk FOREIGN KEY (world_id, owner_user_id) REFERENCES public.worlds(id, owner_user_id);

--
-- Name: worlds worlds_cover_asset_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worlds
    ADD CONSTRAINT worlds_cover_asset_owner_fk FOREIGN KEY (cover_asset_id, owner_user_id) REFERENCES public.assets(id, owner_user_id) ON DELETE SET NULL (cover_asset_id);

--
-- Name: worlds worlds_forked_version_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worlds
    ADD CONSTRAINT worlds_forked_version_owner_fk FOREIGN KEY (forked_from_world_version_id, owner_user_id) REFERENCES public.world_versions(id, owner_user_id) ON DELETE SET NULL (forked_from_world_version_id);

--
-- Name: worlds worlds_forked_world_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worlds
    ADD CONSTRAINT worlds_forked_world_owner_fk FOREIGN KEY (forked_from_world_id, owner_user_id) REFERENCES public.worlds(id, owner_user_id);

--
-- Name: worlds worlds_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worlds
    ADD CONSTRAINT worlds_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

--

INSERT INTO public.users (system_key, display_name) VALUES ('initial-owner', 'Initial Owner');
INSERT INTO public.instance_settings_state DEFAULT VALUES;

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'Restore a pre-baseline backup to revert the baseline'; END $$;
