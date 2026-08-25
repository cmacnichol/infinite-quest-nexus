-- Resumable upload rows contain only owner-scoped, hashed metadata. The actual
-- staging file remains governed by durable_filesystem_operations.

CREATE TABLE system_archive_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  handle_token_hash text NOT NULL UNIQUE CHECK (handle_token_hash ~ '^[0-9a-f]{64}$'),
  filesystem_operation_id uuid NOT NULL,
  filesystem_operation_purpose text GENERATED ALWAYS AS ('portable_staging'::text) STORED,
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'uploading', 'completed', 'expired', 'failed')),
  byte_length bigint NOT NULL CHECK (byte_length >= 0 AND byte_length <= 9007199254740991),
  received_bytes bigint NOT NULL DEFAULT 0
    CHECK (received_bytes >= 0 AND received_bytes <= byte_length),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  staged_input_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_user_id),
  UNIQUE (id, owner_user_id, filesystem_operation_id),
  UNIQUE (filesystem_operation_id),
  FOREIGN KEY (filesystem_operation_id, owner_user_id, filesystem_operation_purpose)
    REFERENCES durable_filesystem_operations(id, owner_user_id, purpose) ON DELETE RESTRICT,
  FOREIGN KEY (staged_input_id, owner_user_id)
    REFERENCES portable_staged_inputs(id, owner_user_id) ON DELETE RESTRICT,
  CONSTRAINT system_archive_uploads_lifecycle_check CHECK (
    (status = 'created' AND received_bytes = 0 AND staged_input_id IS NULL)
    OR (status = 'uploading' AND received_bytes > 0 AND staged_input_id IS NULL)
    OR (status = 'completed' AND received_bytes = byte_length AND staged_input_id IS NOT NULL)
    OR status IN ('expired', 'failed')
  )
);

CREATE INDEX system_archive_uploads_expiry_idx
  ON system_archive_uploads(status, expires_at, updated_at, id)
  WHERE status IN ('created', 'uploading', 'expired');

CREATE TABLE system_archive_upload_chunks (
  upload_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  filesystem_operation_id uuid NOT NULL,
  filesystem_operation_purpose text GENERATED ALWAYS AS ('portable_staging'::text) STORED,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  byte_offset bigint NOT NULL CHECK (byte_offset >= 0 AND byte_offset <= 9007199254740991),
  byte_length bigint NOT NULL CHECK (byte_length > 0 AND byte_length <= 9007199254740991),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, chunk_index),
  UNIQUE (upload_id, owner_user_id, chunk_index),
  CONSTRAINT system_archive_upload_chunks_offset_key
    UNIQUE (upload_id, byte_offset),
  FOREIGN KEY (upload_id, owner_user_id, filesystem_operation_id)
    REFERENCES system_archive_uploads(id, owner_user_id, filesystem_operation_id) ON DELETE CASCADE,
  FOREIGN KEY (filesystem_operation_id, owner_user_id, filesystem_operation_purpose)
    REFERENCES durable_filesystem_operations(id, owner_user_id, purpose) ON DELETE RESTRICT
);

CREATE INDEX system_archive_upload_chunks_range_idx
  ON system_archive_upload_chunks(upload_id, byte_offset, byte_length);

CREATE FUNCTION enforce_system_archive_upload_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER system_archive_uploads_scope_trigger
BEFORE INSERT OR UPDATE ON system_archive_uploads
FOR EACH ROW EXECUTE FUNCTION enforce_system_archive_upload_scope();

CREATE FUNCTION enforce_system_archive_upload_chunk_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER system_archive_upload_chunks_scope_trigger
BEFORE INSERT OR UPDATE ON system_archive_upload_chunks
FOR EACH ROW EXECUTE FUNCTION enforce_system_archive_upload_chunk_scope();
