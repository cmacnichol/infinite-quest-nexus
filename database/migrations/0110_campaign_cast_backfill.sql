-- Up Migration
CREATE TABLE campaign_cast_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  from_turn integer NOT NULL CHECK (from_turn > 0),
  through_turn integer NOT NULL CHECK (through_turn >= from_turn),
  boundary jsonb NOT NULL CHECK (jsonb_typeof(boundary) = 'object'),
  execution_snapshot jsonb NOT NULL CHECK (jsonb_typeof(execution_snapshot) = 'object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','paused','complete','failed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,campaign_id,owner_user_id),
  UNIQUE (campaign_id,idempotency_key),
  FOREIGN KEY (campaign_id,owner_user_id) REFERENCES campaigns(id,owner_user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX campaign_cast_one_active_scan ON campaign_cast_scans(campaign_id)
  WHERE status IN ('queued','running','paused','failed');

-- Frozen source survives turn removal so lifecycle handling can retain an honest cancelled scan.
CREATE TABLE campaign_cast_scan_sources (
  scan_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  turn_number integer NOT NULL CHECK (turn_number > 0),
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','failed','cancelled')),
  PRIMARY KEY(scan_id,turn_number),
  FOREIGN KEY(scan_id,campaign_id,owner_user_id) REFERENCES campaign_cast_scans(id,campaign_id,owner_user_id) ON DELETE CASCADE
);

-- Down Migration
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM campaign_cast_scans) THEN
    RAISE EXCEPTION 'Retain cast scan history; disable new scans instead';
  END IF;
END $$;
DROP TABLE campaign_cast_scan_sources;
DROP TABLE campaign_cast_scans;
