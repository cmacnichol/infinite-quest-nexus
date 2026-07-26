CREATE TABLE IF NOT EXISTS world_generation_progress (
  progress_key text PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  phase text NOT NULL,
  progress_percent integer NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  message text NOT NULL DEFAULT '',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes'
);

CREATE INDEX IF NOT EXISTS world_generation_progress_owner_key_idx
  ON world_generation_progress (owner_user_id, progress_key);

CREATE INDEX IF NOT EXISTS world_generation_progress_expiry_idx
  ON world_generation_progress (expires_at);
