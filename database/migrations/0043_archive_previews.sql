CREATE TABLE archive_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  archive_type text NOT NULL CHECK (archive_type IN ('campaign', 'system')),
  token_hash text NOT NULL,
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
  destination_hash text NOT NULL CHECK (destination_hash ~ '^[0-9a-f]{64}$'),
  application_version text NOT NULL,
  staged_archive_path text NOT NULL CHECK (
    staged_archive_path <> ''
    AND staged_archive_path !~ '(^/|^[A-Za-z]:|^\\\\|\\\\|(^|/)\.\.?(/|$))'
  ),
  source_name text NOT NULL DEFAULT '',
  preview jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('previewed', 'consumed', 'expired', 'failed')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT archive_previews_token_hash_key UNIQUE (token_hash)
);

CREATE UNIQUE INDEX archive_previews_owner_fingerprint_destination_live_idx
  ON archive_previews(owner_user_id, archive_type, content_fingerprint, destination_hash)
  WHERE status = 'previewed';

CREATE INDEX archive_previews_owner_scope_idx
  ON archive_previews(owner_user_id, archive_type, content_fingerprint);

CREATE INDEX archive_previews_expiry_idx
  ON archive_previews(expires_at);
