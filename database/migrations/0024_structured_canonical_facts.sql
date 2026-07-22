CREATE TABLE campaign_canonical_facts (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL,
  world_version_id uuid NOT NULL,
  source_turn_id uuid NOT NULL,
  source_turn_number integer NOT NULL CHECK (source_turn_number > 0),
  source_fact_index integer NOT NULL CHECK (source_fact_index >= 0),
  content text NOT NULL CHECK (content <> ''),
  normalized_content text NOT NULL CHECK (normalized_content <> ''),
  entities text[] NOT NULL DEFAULT ARRAY[]::text[],
  valid_from_turn integer NOT NULL CHECK (valid_from_turn > 0),
  valid_until_turn integer CHECK (valid_until_turn IS NULL OR valid_until_turn > valid_from_turn),
  superseded_by_fact_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, campaign_id, owner_user_id),
  UNIQUE (campaign_id, source_turn_id, source_fact_index),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_turn_id, campaign_id, owner_user_id)
    REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (superseded_by_fact_id, campaign_id, owner_user_id)
    REFERENCES campaign_canonical_facts(id, campaign_id, owner_user_id)
    ON DELETE SET NULL (superseded_by_fact_id)
);

CREATE INDEX campaign_canonical_facts_active_idx
  ON campaign_canonical_facts(owner_user_id, campaign_id, source_turn_number DESC)
  WHERE valid_until_turn IS NULL;

CREATE INDEX campaign_canonical_facts_normalized_idx
  ON campaign_canonical_facts(owner_user_id, campaign_id, normalized_content)
  WHERE valid_until_turn IS NULL;

INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type, status)
SELECT owner_user_id, id, 'reindex_campaign', 'queued'
  FROM campaigns
ON CONFLICT (campaign_id, job_type) WHERE status IN ('queued', 'running')
DO UPDATE SET work_version = chronicle_jobs.work_version + 1, updated_at = now();

COMMENT ON TABLE campaign_canonical_facts IS
  'Rebuildable, turn-valid canonical fact projection. Accepted turn snapshots remain authoritative.';
COMMENT ON COLUMN campaign_canonical_facts.valid_until_turn IS
  'Exclusive turn boundary at which this fact was superseded; NULL means currently active.';
