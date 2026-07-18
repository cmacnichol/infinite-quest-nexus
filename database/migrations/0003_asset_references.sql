ALTER TABLE assets ADD CONSTRAINT assets_id_owner_unique UNIQUE (id, owner_user_id);

CREATE TABLE IF NOT EXISTS asset_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  asset_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  turn_id uuid,
  asset_role text NOT NULL CHECK (asset_role IN ('turn_illustration', 'world_asset', 'import_attachment')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (asset_id, owner_user_id) REFERENCES assets(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE SET NULL,
  UNIQUE NULLS NOT DISTINCT (asset_id, campaign_id, turn_id, asset_role)
);

CREATE INDEX IF NOT EXISTS asset_references_campaign_idx
  ON asset_references(owner_user_id, campaign_id, created_at DESC);
