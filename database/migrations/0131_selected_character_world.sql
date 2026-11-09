-- Up Migration
-- Comparison-only provenance for the immutable selected protagonist's World.
-- Historical campaigns remain NULL: imported audit/provenance can resemble native
-- creation, so readers conservatively reserve a matching roster ID when unknown.
-- The original World need not still exist, and this UUID grants no access to it.
ALTER TABLE campaigns ADD COLUMN selected_character_world_id uuid;

-- Down Migration
ALTER TABLE campaigns DROP COLUMN selected_character_world_id;
