ALTER TABLE campaign_illustration_configs
  ADD COLUMN refinement_instructions text NOT NULL DEFAULT ''
    CHECK (char_length(refinement_instructions) <= 4000);
