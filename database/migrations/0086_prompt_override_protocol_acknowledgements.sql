ALTER TABLE prompt_template_overrides
  ADD COLUMN compatibility_protocol_identity text;

-- Existing acknowledgements predate the protocol/context-policy binding and
-- must be explicitly renewed; the repository rejects this sentinel value.
UPDATE prompt_template_overrides
   SET compatibility_protocol_identity = 'acknowledgement-required-after-protocol-upgrade'
 WHERE compatibility_required_shape_version IS NOT NULL;

ALTER TABLE prompt_template_overrides
  DROP CONSTRAINT prompt_template_overrides_compatibility_metadata_check,
  ADD CONSTRAINT prompt_template_overrides_compatibility_metadata_check CHECK (
    (compatibility_required_shape_version IS NULL
      AND compatibility_protocol_identity IS NULL
      AND compatibility_content_hash IS NULL
      AND compatibility_acknowledged_at IS NULL)
    OR
    (compatibility_required_shape_version IS NOT NULL
      AND compatibility_protocol_identity IS NOT NULL
      AND compatibility_content_hash IS NOT NULL
      AND compatibility_content_hash ~ '^[a-f0-9]{64}$'
      AND compatibility_acknowledged_at IS NOT NULL)
  );
