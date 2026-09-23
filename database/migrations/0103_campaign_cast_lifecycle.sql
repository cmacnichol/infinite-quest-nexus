-- Up Migration
ALTER TABLE campaign_cast_state ADD COLUMN last_boundary_change_key text;
ALTER TABLE campaign_cast_characters DROP CONSTRAINT campaign_cast_characters_origin_check;
ALTER TABLE campaign_cast_characters ADD CHECK (origin->>'kind' IN ('manual','discovered','world','historical_world','protagonist'));
ALTER TABLE campaign_cast_observations DROP CONSTRAINT campaign_cast_observations_evidence_check;
ALTER TABLE campaign_cast_observations ADD CHECK (evidence->>'kind' IN ('turn','world','historical_world'));
ALTER TABLE campaign_cast_observations DROP CONSTRAINT campaign_cast_observations_check1;
ALTER TABLE campaign_cast_observations ADD CHECK (
  (evidence->>'kind' = 'turn' AND source_turn_id IS NOT NULL AND narration_revision >= 0 AND source_hash ~ '^[a-f0-9]{64}$')
  OR (evidence->>'kind' = 'world' AND world_version_id IS NOT NULL)
  OR (evidence->>'kind' = 'historical_world' AND evidence->>'sourceWorldVersionId' IS NOT NULL AND world_version_id IS NULL)
);

-- Down Migration
-- Historical provenance must be retained. Downgrade the application with editing
-- disabled; do not apply a destructive narrowing of these additive constraints.
ALTER TABLE campaign_cast_state DROP COLUMN last_boundary_change_key;
