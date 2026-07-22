CREATE TABLE campaign_world_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  source_campaign_id uuid,
  target_campaign_id uuid,
  from_world_version_id uuid NOT NULL,
  to_world_version_id uuid NOT NULL,
  character_strategy text NOT NULL CHECK (character_strategy IN ('preserve_source')),
  state_strategy text NOT NULL CHECK (state_strategy IN ('preserve')),
  target_defaults_policy text NOT NULL CHECK (target_defaults_policy IN ('retain_source')),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, idempotency_key),
  FOREIGN KEY (source_campaign_id, owner_user_id)
    REFERENCES campaigns(id, owner_user_id) ON DELETE SET NULL (source_campaign_id),
  FOREIGN KEY (target_campaign_id, owner_user_id)
    REFERENCES campaigns(id, owner_user_id) ON DELETE SET NULL (target_campaign_id),
  FOREIGN KEY (from_world_version_id, owner_user_id)
    REFERENCES world_versions(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_world_version_id, owner_user_id)
    REFERENCES world_versions(id, owner_user_id) ON DELETE RESTRICT,
  CHECK (from_world_version_id <> to_world_version_id)
);

CREATE INDEX campaign_world_transfers_source_idx
  ON campaign_world_transfers(owner_user_id, source_campaign_id, created_at DESC)
  WHERE source_campaign_id IS NOT NULL;
CREATE INDEX campaign_world_transfers_target_idx
  ON campaign_world_transfers(owner_user_id, target_campaign_id, created_at DESC)
  WHERE target_campaign_id IS NOT NULL;
CREATE INDEX campaign_world_transfers_from_version_idx
  ON campaign_world_transfers(owner_user_id, from_world_version_id);
CREATE INDEX campaign_world_transfers_to_version_idx
  ON campaign_world_transfers(owner_user_id, to_world_version_id);
