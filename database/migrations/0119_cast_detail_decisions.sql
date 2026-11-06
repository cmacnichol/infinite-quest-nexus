-- Operational inbox decisions are deliberately excluded from portable cast authority.
ALTER TABLE campaign_cast_discovery_candidates ADD COLUMN detail_decisions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE campaign_cast_discovery_candidates ADD CONSTRAINT cast_detail_decisions_array CHECK (jsonb_typeof(detail_decisions) = 'array');
