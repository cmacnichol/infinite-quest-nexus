-- Up Migration
CREATE TABLE campaign_cast_discovery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  turn_number integer NOT NULL CHECK (turn_number > 0),
  narration_revision integer NOT NULL CHECK (narration_revision >= 0),
  timeline_revision integer NOT NULL CHECK (timeline_revision >= 0),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  protocol text NOT NULL CHECK (protocol = 'cast-discovery-v1'),
  source jsonb NOT NULL,
  chunks jsonb NOT NULL CHECK (jsonb_typeof(chunks) = 'array' AND jsonb_array_length(chunks) <= 32),
  execution_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry_wait','complete','failed','cancelled')),
  chunk_ordinal integer NOT NULL DEFAULT 0 CHECK (chunk_ordinal >= 0),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 2),
  checkpoint jsonb,
  lease_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  diagnostic_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,campaign_id,owner_user_id),
  -- A replacement can reuse a turn's correction ordinal on a different timeline.
  UNIQUE (campaign_id,turn_id,narration_revision,timeline_revision,protocol),
  FOREIGN KEY (campaign_id,owner_user_id) REFERENCES campaigns(id,owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id,campaign_id,owner_user_id) REFERENCES turns(id,campaign_id,owner_user_id) ON DELETE CASCADE,
  CHECK ((status='running') = (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX campaign_cast_discovery_one_running ON campaign_cast_discovery_jobs(campaign_id) WHERE status='running';
CREATE INDEX campaign_cast_discovery_claim ON campaign_cast_discovery_jobs(status,available_at,created_at);

-- Operational receipts fence replay; applied identities and evidence live in cast events.
CREATE TABLE campaign_cast_discovery_receipts (
  job_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  chunk_ordinal integer NOT NULL CHECK (chunk_ordinal >= 0),
  output_hash text NOT NULL CHECK (output_hash ~ '^[a-f0-9]{64}$'),
  character_ids uuid[] NOT NULL,
  observation_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(job_id,chunk_ordinal),
  FOREIGN KEY(job_id,campaign_id,owner_user_id) REFERENCES campaign_cast_discovery_jobs(id,campaign_id,owner_user_id) ON DELETE CASCADE
);

-- Down Migration
DROP TABLE campaign_cast_discovery_receipts;
DROP TABLE campaign_cast_discovery_jobs;
