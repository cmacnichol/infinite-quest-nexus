-- Up Migration

-- Allow asset_generation_contexts to accept streaming_illustration
ALTER TABLE asset_generation_contexts
  DROP CONSTRAINT asset_generation_contexts_target_type_check,
  ADD CONSTRAINT asset_generation_contexts_target_type_check
    CHECK (target_type IN ('world_cover', 'turn_illustration', 'streaming_illustration', 'other'));

-- Down Migration

ALTER TABLE asset_generation_contexts
  DROP CONSTRAINT asset_generation_contexts_target_type_check,
  ADD CONSTRAINT asset_generation_contexts_target_type_check
    CHECK (target_type IN ('world_cover', 'turn_illustration', 'other'));
