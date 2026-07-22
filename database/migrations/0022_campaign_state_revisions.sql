ALTER TABLE campaign_state
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0);

CREATE TABLE IF NOT EXISTS campaign_state_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL,
  effective_turn_number integer NOT NULL CHECK (effective_turn_number >= 0),
  revision integer NOT NULL CHECK (revision > 0),
  state_snapshot_private jsonb NOT NULL,
  changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  UNIQUE (campaign_id, revision)
);

CREATE INDEX IF NOT EXISTS campaign_state_edits_turn_idx
  ON campaign_state_edits(owner_user_id, campaign_id, effective_turn_number, revision DESC);
