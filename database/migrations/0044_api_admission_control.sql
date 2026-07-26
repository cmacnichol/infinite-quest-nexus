CREATE TABLE api_admission_buckets (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 100),
  window_started_at timestamptz NOT NULL,
  window_expires_at timestamptz NOT NULL,
  accepted_count integer NOT NULL CHECK (accepted_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, operation, window_started_at),
  CHECK (window_expires_at > window_started_at)
);

CREATE INDEX api_admission_buckets_expiry_idx
  ON api_admission_buckets (window_expires_at);

CREATE TABLE api_admission_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 100),
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, operation, request_id)
);

CREATE INDEX api_admission_leases_scope_expiry_idx
  ON api_admission_leases (owner_user_id, operation, expires_at);
