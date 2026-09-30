-- Preserve all saved prompts while allowing longer Story Writer instructions.
ALTER TABLE prompt_template_overrides
  DROP CONSTRAINT prompt_template_overrides_content_check,
  ADD CONSTRAINT prompt_template_overrides_content_check
    CHECK (char_length(btrim(content)) > 0
      AND char_length(content) <= CASE WHEN prompt_key = 'story_system' THEN 64000 ELSE 16000 END);
