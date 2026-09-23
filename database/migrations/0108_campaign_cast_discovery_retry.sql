-- Up Migration
ALTER TABLE campaign_cast_discovery_jobs ADD COLUMN retry_generation integer NOT NULL DEFAULT 0 CHECK (retry_generation >= 0);
CREATE TABLE campaign_cast_discovery_retries (
  job_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  retry_generation integer NOT NULL CHECK (retry_generation > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(job_id,idempotency_key),
  UNIQUE(job_id,retry_generation),
  FOREIGN KEY(job_id,campaign_id,owner_user_id) REFERENCES campaign_cast_discovery_jobs(id,campaign_id,owner_user_id) ON DELETE CASCADE
);

-- Down Migration
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM campaign_cast_discovery_jobs WHERE retry_generation > 0) THEN
    RAISE EXCEPTION 'Retain cast retry generations while retry history exists; disable discovery instead';
  END IF;
END $$;
DROP TABLE campaign_cast_discovery_retries;
ALTER TABLE campaign_cast_discovery_jobs DROP COLUMN retry_generation;
