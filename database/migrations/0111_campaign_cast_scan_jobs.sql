-- Up Migration
ALTER TABLE campaign_cast_discovery_jobs ADD COLUMN scan_id uuid;
ALTER TABLE campaign_cast_discovery_jobs ADD CONSTRAINT campaign_cast_discovery_scan_scope
  FOREIGN KEY(scan_id,campaign_id,owner_user_id) REFERENCES campaign_cast_scans(id,campaign_id,owner_user_id);
CREATE INDEX campaign_cast_discovery_scan ON campaign_cast_discovery_jobs(scan_id) WHERE scan_id IS NOT NULL;

-- Down Migration
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM campaign_cast_discovery_jobs WHERE scan_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Retain scan job provenance; disable scans instead';
  END IF;
END $$;
ALTER TABLE campaign_cast_discovery_jobs DROP CONSTRAINT campaign_cast_discovery_scan_scope;
ALTER TABLE campaign_cast_discovery_jobs DROP COLUMN scan_id;
