ALTER TABLE generation_jobs ADD COLUMN generation_policy jsonb;
ALTER TABLE turns ADD COLUMN generation_policy jsonb;
ALTER TABLE campaigns ALTER COLUMN turn_control_style SET DEFAULT 'flexible_action';

ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_generation_policy_valid CHECK (
  generation_policy IS NULL OR COALESCE(
    jsonb_typeof(generation_policy) = 'object'
    AND jsonb_typeof(generation_policy->'version') = 'number'
    AND generation_policy->>'version' = '1'
    AND (
      (generation_policy->>'playMode' = 'legacy'
       AND generation_policy->>'turnControlStyle' IN ('action_only', 'flexible_action')
       AND generation_policy ? 'protocolVersion' = false
       AND generation_policy ? 'prompts' = false)
      OR
      (generation_policy->>'playMode' = 'story_only'
       AND generation_policy->>'turnControlStyle' = 'flexible_scene'
       AND generation_policy->>'protocolVersion' = 'story-only-v1'
       AND jsonb_typeof(generation_policy->'prompts') = 'object'
       AND generation_policy->'prompts' ?& ARRAY['systemSupplement', 'systemSupplementHash', 'choiceRepairSystem', 'choiceRepairSystemHash']
       AND jsonb_typeof(generation_policy->'prompts'->'systemSupplement') = 'string'
       AND jsonb_typeof(generation_policy->'prompts'->'systemSupplementHash') = 'string'
       AND jsonb_typeof(generation_policy->'prompts'->'choiceRepairSystem') = 'string'
       AND jsonb_typeof(generation_policy->'prompts'->'choiceRepairSystemHash') = 'string')
    ), false)
);

ALTER TABLE turns ADD CONSTRAINT turns_generation_policy_valid CHECK (
  generation_policy IS NULL OR COALESCE(
    jsonb_typeof(generation_policy) = 'object'
    AND jsonb_typeof(generation_policy->'version') = 'number'
    AND generation_policy->>'version' = '1'
    AND (
      (generation_policy->>'playMode' = 'legacy'
       AND generation_policy->>'turnControlStyle' IN ('action_only', 'flexible_action')
       AND generation_policy ? 'protocolVersion' = false
       AND generation_policy ? 'prompts' = false)
      OR
      (generation_policy->>'playMode' = 'story_only'
       AND generation_policy->>'turnControlStyle' = 'flexible_scene'
       AND generation_policy->>'protocolVersion' = 'story-only-v1'
       AND jsonb_typeof(generation_policy->'prompts') = 'object'
       AND generation_policy->'prompts' ?& ARRAY['systemSupplement', 'systemSupplementHash', 'choiceRepairSystem', 'choiceRepairSystemHash']
       AND jsonb_typeof(generation_policy->'prompts'->'systemSupplement') = 'string'
       AND jsonb_typeof(generation_policy->'prompts'->'systemSupplementHash') = 'string'
       AND jsonb_typeof(generation_policy->'prompts'->'choiceRepairSystem') = 'string'
       AND jsonb_typeof(generation_policy->'prompts'->'choiceRepairSystemHash') = 'string')
    ), false)
);

UPDATE campaigns
   SET turn_control_style = 'flexible_action'
 WHERE turn_control_style = 'flexible_auto';

UPDATE users
   SET settings = jsonb_set(settings, '{defaultTurnControlStyle}', '"flexible_action"'::jsonb)
 WHERE settings->>'defaultTurnControlStyle' = 'flexible_auto';
