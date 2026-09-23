-- Up Migration
ALTER TABLE campaign_cast_discovery_jobs ADD COLUMN identity_snapshot jsonb;
ALTER TABLE campaign_cast_discovery_receipts ADD COLUMN validation_summary jsonb NOT NULL DEFAULT '{}';
CREATE TABLE campaign_cast_discovery_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  job_id uuid NOT NULL,
  chunk_ordinal integer NOT NULL CHECK (chunk_ordinal >= 0),
  local_key text NOT NULL CHECK (length(local_key) BETWEEN 1 AND 100),
  source jsonb NOT NULL,
  proposal jsonb NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','cancelled')),
  resolution_receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(job_id,chunk_ordinal,local_key),
  FOREIGN KEY(job_id,campaign_id,owner_user_id) REFERENCES campaign_cast_discovery_jobs(id,campaign_id,owner_user_id) ON DELETE CASCADE
);
CREATE INDEX campaign_cast_discovery_candidates_pending ON campaign_cast_discovery_candidates(campaign_id,created_at,id) WHERE status='pending';

-- Down Migration
DROP TABLE campaign_cast_discovery_candidates;
ALTER TABLE campaign_cast_discovery_receipts DROP COLUMN validation_summary;
ALTER TABLE campaign_cast_discovery_jobs DROP COLUMN identity_snapshot;
