CREATE TABLE IF NOT EXISTS world_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  world_id uuid NOT NULL,
  world_version_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  redeemed_count bigint NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
  last_redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT world_share_links_world_owner_fk
    FOREIGN KEY (world_id, owner_user_id) REFERENCES worlds(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT world_share_links_version_owner_fk
    FOREIGN KEY (world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS world_share_links_owner_world_idx
  ON world_share_links(owner_user_id, world_id, created_at DESC);

CREATE INDEX IF NOT EXISTS world_share_links_active_expiry_idx
  ON world_share_links(expires_at)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE world_share_links IS
  'Revocable expiring bearer links pinned to immutable portable world versions; raw tokens are never persisted.';
