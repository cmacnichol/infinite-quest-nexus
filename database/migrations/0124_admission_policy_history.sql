-- up migration
-- Additive authority preserves the legacy bucket primary key and old upserts.
ALTER TABLE api_admission_buckets ADD COLUMN accounted_count integer NOT NULL DEFAULT 0 CHECK (accounted_count >= 0);
CREATE TABLE api_admission_windows (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 100),
  window_started_at timestamptz NOT NULL,
  window_expires_at timestamptz NOT NULL,
  max_requests integer NOT NULL CHECK (max_requests > 0),
  PRIMARY KEY(owner_user_id,operation,window_started_at,window_expires_at),
  CHECK(window_expires_at>window_started_at)
);
CREATE INDEX api_admission_windows_expiry_idx ON api_admission_windows(window_expires_at);
CREATE TABLE api_admission_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 100),
  accepted_at timestamptz NOT NULL
);
CREATE INDEX api_admission_events_scope_idx ON api_admission_events(owner_user_id,operation,accepted_at);
CREATE INDEX api_admission_events_expiry_idx ON api_admission_events(accepted_at);
