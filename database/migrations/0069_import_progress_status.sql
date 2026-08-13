-- Up Migration

-- Compatibility status for the existing predictable progress lookup. The raw
-- browser key is never persisted and this table grants no import, filesystem,
-- provider, world, or campaign authority.
CREATE TABLE import_progress_status (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  lookup_key_hash text NOT NULL CHECK (lookup_key_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('processing','completed','failed')),
  phase text NOT NULL CHECK (length(btrim(phase)) BETWEEN 1 AND 200),
  progress_percent double precision NOT NULL CHECK (
    progress_percent BETWEEN 0 AND 100
  ),
  message text NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 2000),
  world_id uuid,
  world_version_id uuid,
  duplicate boolean,
  error_message text CHECK (
    error_message IS NULL OR length(btrim(error_message)) BETWEEN 1 AND 2000
  ),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_user_id,lookup_key_hash),
  CONSTRAINT import_progress_status_terminal_check CHECK (
    (status='processing' AND progress_percent < 100 AND error_message IS NULL)
    OR (status='completed' AND progress_percent=100 AND error_message IS NULL)
    OR (status='failed' AND progress_percent=100 AND error_message IS NOT NULL)
  )
);

CREATE INDEX import_progress_status_expiry_idx
  ON import_progress_status(expires_at,owner_user_id,lookup_key_hash);

-- Down Migration

DROP TABLE IF EXISTS import_progress_status;
