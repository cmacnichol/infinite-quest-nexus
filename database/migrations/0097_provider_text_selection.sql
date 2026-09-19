ALTER TABLE provider_profiles
  ADD COLUMN text_selection jsonb;

ALTER TABLE provider_profiles
  ADD CONSTRAINT provider_profiles_text_selection_shape_check
  CHECK (
    text_selection IS NULL OR (
      jsonb_typeof(text_selection) = 'object'
      AND (
        (text_selection->>'kind' = 'model'
          AND text_selection ? 'modelId'
          AND jsonb_typeof(text_selection->'modelId') = 'string')
        OR
        (text_selection->>'kind' = 'openrouter_preset'
          AND text_selection ? 'slug'
          AND jsonb_typeof(text_selection->'slug') = 'string'
          AND text_selection->>'slug' ~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$')
      )
    )
  );
