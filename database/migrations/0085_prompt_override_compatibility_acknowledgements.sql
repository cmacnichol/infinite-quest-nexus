ALTER TABLE prompt_template_overrides
  ADD COLUMN compatibility_required_shape_version text,
  ADD COLUMN compatibility_content_hash text,
  ADD COLUMN compatibility_acknowledged_at timestamptz;

ALTER TABLE prompt_template_overrides
  ADD CONSTRAINT prompt_template_overrides_compatibility_metadata_check CHECK (
    (compatibility_required_shape_version IS NULL
      AND compatibility_content_hash IS NULL
      AND compatibility_acknowledged_at IS NULL)
    OR
    (compatibility_required_shape_version IS NOT NULL
      AND compatibility_content_hash IS NOT NULL
      AND compatibility_content_hash ~ '^[a-f0-9]{64}$'
      AND compatibility_acknowledged_at IS NOT NULL)
  );
