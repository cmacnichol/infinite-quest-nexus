-- Promotion receipts are installation-local retry state, never portable authority.
CREATE TABLE campaign_cast_promotion_receipts (
  owner_user_id uuid NOT NULL,
  world_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, world_id, idempotency_key),
  FOREIGN KEY (world_id, owner_user_id) REFERENCES world_drafts(world_id, owner_user_id) ON DELETE CASCADE
);
