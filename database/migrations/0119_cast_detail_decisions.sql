-- Up Migration
-- Operational inbox decisions are deliberately excluded from portable cast authority.
ALTER TABLE campaign_cast_discovery_candidates ADD COLUMN detail_decisions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE campaign_cast_discovery_candidates ADD CONSTRAINT cast_detail_decisions_array CHECK (jsonb_typeof(detail_decisions) = 'array');

-- Down Migration
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM campaign_cast_discovery_candidates WHERE detail_decisions <> '[]'::jsonb) THEN
    RAISE EXCEPTION 'Retain recorded detail decisions; disable cast editing instead';
  END IF;
END $$;
ALTER TABLE campaign_cast_discovery_candidates DROP CONSTRAINT cast_detail_decisions_array;
ALTER TABLE campaign_cast_discovery_candidates DROP COLUMN detail_decisions;
